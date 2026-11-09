/**
 * 创作台的助手会话（29 号开场）：真的 DSH 模式——同一个会话多轮、自动带上下文、
 * 有读工具和「只能交提议」的写工具，回复由模型自己写（Markdown），检查只说这次新带出来的冲突。
 *
 * 会话存在 event 表里（user/message、assistant/message），续一句就是往同一条 run 追加一轮。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CreativeDocument } from './world';
import type { BoardRef, CreativeOp, Proposal } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvent } from '../ledger';
import { appendEvents } from './events';
import { advisorOps } from './advisor';
import { loadWorld } from './service';
import { focusStep } from './preview';
import { selectedVersions } from './asset-query';
import { effectiveWorldOf } from './effective';
import { diffDocuments } from './items';
import { runCheck } from './check';
import { parseStoryTime } from './story-time';
import { timeContext } from './world';
import { buildLegs } from './routing';
import { clip } from './text';
import { paragraphsOf, sceneOf, wordsOf, type WorkDocument } from './work';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

export type ChatDeps = {
  baseUrl: string;
  apiKey: string;
  model: string;
  transport?: typeof fetch;
  maxTokens?: number;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  provider?: string;
};

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ChatTurn = { text: string; toolCalls: ToolCall[]; usage: { inputTokens: number | null; outputTokens: number | null } };

const endpointOf = (baseUrl: string) => {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
};

/** 一次带工具的消息调用（Anthropic 形状）。 */
export async function callChat(
  deps: ChatDeps,
  input: { system: string; messages: ChatMessage[]; tools: ToolDef[]; maxTokens?: number },
): Promise<ChatTurn> {
  const transport = deps.transport ?? fetch;
  const response = await transport(endpointOf(deps.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': deps.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: deps.model,
      max_tokens: input.maxTokens ?? deps.maxTokens ?? 4096,
      system: input.system,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: [{ type: 'text', text: message.content }],
      })),
      ...(input.tools.length ? { tools: input.tools } : {}),
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) throw new ApiFailure('ASSISTANT_FAILED', 503, `模型调用失败（${response.status}）。`);
  const body = (await response.json()) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const blocks = body.content ?? [];
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('').trim();
  const toolCalls = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ id: block.id ?? randomUUID(), name: block.name ?? '', input: (block.input ?? {}) as Record<string, unknown> }));
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: Number.isFinite(body.usage?.input_tokens) ? Number(body.usage?.input_tokens) : null,
      outputTokens: Number.isFinite(body.usage?.output_tokens) ? Number(body.usage?.output_tokens) : null,
    },
  };
}

const ROLE_PROMPT: Record<'advisor' | 'writer' | 'director', string> = {
  advisor: `你是这部小说的设定顾问。你只交提议，作者在待确认里接受才入账。
底线：只用给到的设定和原文里已有的东西；缺什么就照实说缺什么，并把它写成「还不确定的」。不要替作者拍板历史事实。`,
  director: `你是这部小说的分镜导演。你只交提议（白模、镜头表），作者接受才入账；你不能自己出片。
底线：每镜 4–10 秒；人物站位要在房间轮廓里；机位不要穿墙；回复里不复述镜头明细。`,
  writer: `你是这部小说的写作助手。你只交正文改稿提议，作者接受才落笔。
底线：只改指定的那一段或那一场，不要替下一场收尾、不要跳到别的时间线；设定里没有的地点人物时间不要编，非写不可就写得含糊并在 why 里说明。`,
};

const TOOLS_READ: ToolDef[] = [
  {
    name: 'world_snapshot',
    description: '读当前世界观（在这部作品里时是它实际用的设定）：人物地点、事件、规则、交通方式。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'event_search',
    description: '按关键字找事件（标题、经过、参与者的名字）。',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'check_run',
    description: '读当前的检查结果（确定冲突、疑似、未覆盖、信息不足）。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'work_scene',
    description: '读这一场（或指定场景）的正文和目标。',
    input_schema: { type: 'object', properties: { sceneId: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'version_diff',
    description: '读两个版本之间改了哪些设定条目。',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'number' }, to: { type: 'number' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: '读工作区里的一个文本文件（作者贴过来的资料常放在这里）。',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
];

const TOOLS_ADVISOR: ToolDef[] = [
  ...TOOLS_READ,
  {
    name: 'propose_setting',
    description:
      '交一条设定提议（进待确认，作者接受才入账）。人物经历用 entities + events；规则用 rules。规则能翻成程序可判就填 machine。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['person', 'place', 'item', 'org'] },
              aliases: { type: 'array', items: { type: 'string' } },
              summary: { type: 'string' },
              parentName: { type: 'string' },
              look: { type: 'string', description: '人物外貌（自然语言），出形象只从它读' },
              level: { type: 'string', enum: ['world', 'region', 'city', 'site', 'building', 'floor', 'room'] },
            },
            required: ['name', 'kind'],
            additionalProperties: false,
          },
        },
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              what: { type: 'string' },
              kind: { type: 'string', enum: ['stay', 'travel', 'interaction', 'birth', 'death', 'other'] },
              participants: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, as: { type: 'string' } }, required: ['name'], additionalProperties: false } },
              placeName: { type: 'string' },
              from: { type: 'string', description: '出行事件的起点地名（会按名字对上现有地点）' },
              to: { type: 'string', description: '出行事件的终点地名（会按名字对上现有地点）' },
              start: { type: 'string' },
              end: { type: 'string' },
              narrative: { type: 'string', enum: ['fact', 'hearsay', 'dream', 'hypothetical', 'flashback'] },
            },
            required: ['title', 'what'],
            additionalProperties: false,
          },
        },
        updates: {
          type: 'array',
          description: '改现有条目的几个字段（比如给已有的人物补外貌），按名字找',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['person', 'place', 'item', 'org'] },
              look: { type: 'string' },
              summary: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        rules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              machine: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['teleport', 'remote_presence', 'resurrection', 'custom'] },
                  params: { type: 'object' },
                },
                required: ['kind'],
                additionalProperties: false,
              },
              machineNote: { type: 'string' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        doubts: { type: 'array', items: { type: 'string' } },
        supersedes: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
];

const TOOLS_DIRECTOR: ToolDef[] = [
  ...TOOLS_READ,
  {
    name: 'propose_whitebox',
    description: '交一条白模提议（这个房间的部件：墙、柜台、门、桌……），进待确认。',
    input_schema: {
      type: 'object',
      properties: {
        placeId: { type: 'string' },
        note: { type: 'string' },
        prims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['box', 'cylinder', 'prism'] },
              c: {
                type: 'array',
                items: { type: 'number' },
                minItems: 3,
                maxItems: 3,
                description: '底面中心（米，局部坐标）：y 一般是 0；不要写成几何中心',
              },
              s: {
                type: 'array',
                items: { type: 'number' },
                minItems: 3,
                maxItems: 3,
                description: 'box：长宽高；cylinder/prism：[半径, 高, 0]（半径不是直径）',
              },
              sides: { type: 'number' },
              rotY: { type: 'number' },
              label: { type: 'string' },
              material: { type: 'string', enum: ['plaster', 'wood', 'stone', 'tile', 'water', 'plant', 'cloth', 'brick'] },
              color: { type: 'string', description: '#rrggbb' },
              outside: { type: 'boolean', description: '本来就在房间外（门外街面这类）' },
            },
            required: ['kind', 'c', 's'],
            additionalProperties: false,
          },
        },
      },
      required: ['placeId', 'prims'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_shots',
    description: '交一条镜头表提议（这一场拆成几镜），进待确认。',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string' },
        shots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              n: { type: 'number' },
              para: { type: 'number' },
              durationSec: { type: 'number' },
              action: { type: 'string' },
              dialogue: { type: 'string' },
              light: { type: 'string' },
              camera: {
                type: 'object',
                properties: {
                  eye: { type: 'array', items: { type: 'number' } },
                  target: { type: 'array', items: { type: 'number' } },
                  fov: { type: 'number' },
                },
                required: ['eye', 'target'],
                additionalProperties: false,
              },
              cast: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    entityId: { type: 'string' },
                    at: { type: 'array', items: { type: 'number' } },
                    facing: { type: 'number' },
                    pose: { type: 'string', enum: ['stand', 'sit', 'walk'] },
                  },
                  required: ['entityId', 'at'],
                  additionalProperties: false,
                },
              },
            },
            required: ['action', 'camera'],
            additionalProperties: false,
          },
        },
        emptyShot: { type: 'boolean', description: '明确这些都是空镜（没有人物）' },
      },
      required: ['shots'],
      additionalProperties: false,
    },
  },
];

const TOOLS_WRITER: ToolDef[] = [
  ...TOOLS_READ,
  {
    name: 'propose_text_edit',
    description: '交一条正文改稿提议（作者接受才落笔）。改写要给出被替换的原话 before。',
    input_schema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        mode: { type: 'string', enum: ['draft', 'continue', 'complete', 'rewrite'] },
        before: { type: 'string' },
        after: { type: 'string' },
        why: { type: 'string' },
      },
      required: ['sceneId', 'mode', 'after'],
      additionalProperties: false,
    },
  },
];

export type SessionContext = {
  dossierId: string;
  workId: string | null;
  sceneId: string | null;
  /** 分镜导演用：这一场所在的房间（地点）。 */
  placeId?: string | null;
};

/** 把世界观摘要成工具输出（给模型读，不是给页面）。 */
export function digestOf(document: CreativeDocument): string {
  const lines: string[] = [`# 《${document.title}》`];
  lines.push('## 人物地点');
  for (const entity of document.entities)
    lines.push(`- ${entity.id}｜${entity.kind === 'place' ? '地点' : entity.kind === 'person' ? '人物' : '物件'}｜${entity.name}${entity.aliases.length ? `（别名：${entity.aliases.join('、')}）` : ''}：${clip(entity.summary, 120)}`);
  lines.push('## 事件');
  for (const event of document.events)
    lines.push(
      `- ${event.id}｜${event.title}｜${event.start?.label ?? '时间未定'} → ${event.end?.label ?? ''}｜${event.narrative}｜地点 ${event.placeId ?? '未定'}｜${event.participants.map((p) => `${p.entityId}(${p.as})`).join(' ') || '无参与者'}：${clip(event.what, 100)}`,
    );
  lines.push('## 规则');
  for (const rule of document.rules)
    lines.push(`- ${rule.id}｜${rule.text}${rule.machine ? `（程序可判：${rule.machine.kind}）` : '（自然语言，未翻）'}`);
  lines.push('## 房间（白模按这个轮廓搭）');
  for (const place of document.entities.filter((item) => item.kind === 'place' && item.place?.room))
    lines.push(
      `- ${place.id}｜${place.name}｜轮廓 ${JSON.stringify(place.place!.room!.outline)}｜层高 ${place.place!.room!.height}｜ø${place.place!.room!.heading}°`,
    );
  lines.push('## 交通方式');
  for (const mode of document.modes) lines.push(`- ${mode.id}｜${mode.name}｜${mode.kmPerHour} km/h｜${mode.network}`);
  return lines.join('\n');
}

export type SessionRunDeps = {
  db: import('../db/database').Database;
  chat?: ChatDeps;
  workspaceRoot?: string;
};

const recordUsage = async (
  db: import('../db/database').Database,
  account: string,
  dossier: string,
  runId: string,
  deps: ChatDeps,
  usage: { inputTokens: number | null; outputTokens: number | null },
): Promise<void> => {
  const known = Boolean(deps.pricing) && Number.isInteger(usage.inputTokens) && Number.isInteger(usage.outputTokens);
  const cost = known && deps.pricing
    ? ((usage.inputTokens as number) * deps.pricing.inputPerMillion + (usage.outputTokens as number) * deps.pricing.outputPerMillion) / 1_000_000
    : null;
  await db.withAccount(account, async (client) => {
    await client.query(
      `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose)
       values(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,null,null,$9,'creative_assistant')`,
      [account, dossier, runId, deps.provider ?? 'deepseek-official', deps.model, known, known ? usage.inputTokens : null, known ? usage.outputTokens : null, cost === null ? null : cost.toFixed(6)],
    );
  });
};

const readHistory = async (client: pg.PoolClient, account: string, runId: string): Promise<ChatMessage[]> => {
  const rows = (
    await client.query<{ action: string; payload: { message?: { content?: { type: string; text?: string }[]; role?: string } } }>(
      "select action, payload from event where account_id=$1 and run_id=$2 and action in ('user/message','assistant/message') order by seq",
      [account, runId],
    )
  ).rows;
  return rows
    .map((row) => ({
      role: row.action === 'user/message' ? ('user' as const) : ('assistant' as const),
      content: (row.payload?.message?.content ?? []).map((block) => block.text ?? '').join('').trim(),
    }))
    .filter((message) => message.content);
};

export type RunToolContext = {
  client: pg.PoolClient;
  account: string;
  dossier: string;
  context: SessionContext;
  role: 'advisor' | 'writer' | 'director';
  runId: string;
  /** 作者在看板虚影上点「改一下」时带的提议 id：交新版时默认替代它。 */
  about?: string;
  /** 本轮新建的提议 id（回复里可以引用）。 */
  proposals: string[];
};

/** 执行一轮里的一个工具调用。写工具只交提议。返回给模型的文字 + 看板上要描亮的 refs。 */
export async function runTool(
  defs: RunToolContext,
  call: ToolCall,
): Promise<{ text: string; refs: BoardRef[]; step?: string; ok?: boolean }> {
  const { client, account, dossier, context, role } = defs;
  const worldState = await loadWorld(client, account, dossier);
  const selectedVersionIds = new Map(
    [...(await selectedVersions(client, account, dossier)).values()].map((item) => [item.entityId, item.versionId]),
  );
  const world =
    context.workId && role !== 'writer'
      ? (await effectiveWorldOf(client, account, dossier, context.workId)).document
      : context.workId
        ? (await effectiveWorldOf(client, account, dossier, context.workId)).document
        : worldState.document;

  switch (call.name) {
    case 'world_snapshot':
      return { text: digestOf(world), refs: [] };
    case 'event_search': {
      const query = String(call.input.query ?? '');
      const hits = world.events.filter((event) => `${event.title} ${event.what}`.includes(query)).slice(0, 20);
      return {
        text: hits.length
          ? hits.map((event) => `- ${event.id}｜${event.title}｜${event.start?.label ?? '时间未定'}｜${clip(event.what, 120)}`).join('\n')
          : '没有找到相关事件。',
        refs: hits.map((event) => ({ kind: 'event' as const, id: event.id })),
      };
    }
    case 'check_run': {
      const legs = await buildLegs(client, { account, dossier, document: world });
      const check = runCheck({ document: world, legs, revision: worldState.revision, now: new Date().toISOString() });
      return {
        text: JSON.stringify(
        {
          确定: check.conflicts.filter((item) => item.severity === 'hard').map((item) => ({ why: item.why, kind: item.kind })),
          疑似: check.conflicts.filter((item) => item.severity === 'suspect').map((item) => ({ why: item.why, kind: item.kind })),
          信息不足: check.insufficient.map((item) => `${item.eventId}：${(item.gaps ?? []).join('；') || '缺信息'}`),
          未覆盖: check.uncovered.map((item) => item.why),
        },
          null,
          1,
        ),
        refs: check.conflicts.flatMap((item) => item.eventIds.map((id) => ({ kind: 'event' as const, id }))).slice(0, 20),
      };
    }
    case 'work_scene': {
      if (!context.workId) return { text: '当前没有打开的作品。', refs: [] };
      const work = (
        await client.query<{ document: WorkDocument }>(
          'select document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
          [account, dossier, context.workId],
        )
      ).rows[0]?.document;
      if (!work) return { text: '没有这部作品。', refs: [] };
      const sceneId = String(call.input.sceneId ?? context.sceneId ?? '');
      const scene = work.chapters.flatMap((chapter) => chapter.scenes).find((item) => item.id === sceneId);
      if (!scene) return { text: '没有这一场。', refs: [] };
      return {
        text: `# ${scene.title}\n目标：${scene.goal || '未写'}\n引用事件：${scene.eventIds.join('、') || '无'}\n\n${scene.text}`,
        refs: [
          { kind: 'scene' as const, workId: context.workId!, sceneId },
          ...scene.eventIds.map((id) => ({ kind: 'event' as const, id })),
        ],
      };
    }
    case 'version_diff': {
      const from = Number(call.input.from);
      const to = Number(call.input.to);
      const rows = (
        await client.query<{ n: number; world: CreativeDocument }>(
          'select n, world from creative_version where account_id=$1 and dossier_id=$2 and n = any($3::int[])',
          [account, dossier, [from, to]],
        )
      ).rows;
      const a = rows.find((row) => Number(row.n) === from)?.world;
      const b = rows.find((row) => Number(row.n) === to)?.world;
      if (!a || !b) return { text: '没有这两个版本。', refs: [] };
      return {
        text: diffDocuments(a, b)
          .map((item) => `- ${item.title}｜${item.change}${item.fields.length ? `｜改了：${item.fields.join('、')}` : ''}`)
          .join('\n'),
        refs: [],
      };
    }
    case 'read_file': {
      const root = defs.client ? process.cwd() : process.cwd();
      const target = resolve(root, String(call.input.path ?? ''));
      if (!target.startsWith(root)) return { text: '只能读工作区里的文件。', refs: [] };
      try {
        const content = await readFile(target, 'utf8');
        return { text: clip(content, 20_000), refs: [] };
      } catch {
        return { text: '读不到这个文件。', refs: [] };
      }
    }
    case 'propose_setting': {
      const ops = advisorOps(
        {
        kind: 'itinerary',
        title: String(call.input.title ?? ''),
        summary: String(call.input.summary ?? ''),
        entities: (call.input.entities as unknown[]) ?? [],
        events: (call.input.events as unknown[]) ?? [],
        rules: (call.input.rules as unknown[]) ?? [],
        doubts: (call.input.doubts as unknown[]) ?? [],
        },
        {
          placeIdOf: (name) =>
            world.entities.find((item) => item.name === name || (item.aliases ?? []).includes(name))?.id ?? null,
        },
      );
      // 改现有条目的字段（比如给已有的人物补外貌）：按名字找到 id，变成 entity.update
      const updateOps = ((call.input.updates as Record<string, unknown>[]) ?? [])
        .map((update) => {
          const name = String(update.name ?? '');
          const entity = world.entities.find((item) => item.name === name || (item.aliases ?? []).includes(name));
          if (!entity) return null;
          const patch: Record<string, unknown> = {};
          if (typeof update.look === 'string') patch.person = { ...(entity.person ?? {}), look: update.look };
          if (typeof update.summary === 'string') patch.summary = update.summary;
          if (!Object.keys(patch).length) return null;
          return { op: 'entity.update', id: entity.id, patch } as unknown as CreativeOp;
        })
        .filter((op): op is CreativeOp => op !== null);
      const proposed = await createProposal(defs, world, {
        kind: 'itinerary',
        title: String(call.input.title ?? '提议'),
        summary: String(call.input.summary ?? ''),
        ops: [...ops.ops, ...updateOps],
        doubts: ops.doubts,
        ...(call.input.supersedes ? { supersedes: String(call.input.supersedes) } : defs.about ? { supersedes: defs.about } : {}),
      });
      return proposed;
    }
    case 'propose_text_edit': {
      if (!context.workId) return { text: '当前没有打开的作品，改不了正文。', refs: [] };
      const sceneId = String(call.input.sceneId ?? '');
      const workRow = (
        await client.query<{ revision: number; document: WorkDocument }>(
          'select revision, document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3 for update',
          [account, dossier, context.workId],
        )
      ).rows[0];
      if (!workRow) return { text: '没有这部作品。', refs: [] };
      const { scene } = sceneOf(workRow.document, sceneId);
      const mode = String(call.input.mode ?? 'rewrite') as 'draft' | 'continue' | 'complete' | 'rewrite';
      const after = clip(call.input.after ?? '', 200_000);
      if (!after) return { text: '没有给正文。', refs: [] };
      const before = String(call.input.before ?? '');
      const proposal: Proposal = {
        id: randomUUID(),
        batchId: `assistant_${randomUUID().slice(0, 8)}`,
        kind: 'text_edit',
        title: `${scene.title}：${mode === 'rewrite' ? '改写' : mode === 'continue' ? '续写' : mode === 'complete' ? '补全' : '起稿'}`,
        summary: clip(call.input.why ?? '', 200),
        ops: [
          {
            op: 'text.set',
            workId: context.workId,
            sceneId,
            baseTextVersion: scene.textVersion,
            mode,
            range: null,
            before,
            after,
          },
        ] as unknown as Proposal['ops'],
        origin: { basis: 'inferred', by: 'writer', why: clip(call.input.why ?? '助手改稿', 300) },
        doubts: [],
        dependsOn: [],
        conflicts: [],
        status: 'pending',
      };
      await client.query(
        'update creative_world set revision=$3, document=jsonb_set(document, $4::text[], $5::jsonb, true), updated_at=now() where account_id=$1 and dossier_id=$2',
        [account, dossier, worldState.revision + 1, '{proposals}', JSON.stringify([...worldState.document.proposals, proposal])],
      );
      await appendEvents(client, { account, dossier }, [{ type: 'creative.proposal', data: proposal }]);
      defs.proposals.push(proposal.id);
      return {
        text: `已交一条改稿提议（${proposal.id.slice(0, 8)}）：${proposal.title}，作者在待确认里接受才落笔。`,
        refs: [{ kind: 'scene' as const, workId: context.workId, sceneId }],
      };
    }
    case 'propose_whitebox': {
      if (!call.input.placeId) return { text: '要指定是哪个地点。', refs: [] };
      const prims = (call.input.prims as Record<string, unknown>[]) ?? [];
      const ops = prims.map((prim) => ({ op: 'whitebox.prim.add', placeId: String(call.input.placeId), prim }));
      const proposed = await createProposal(defs, world, {
        kind: 'whitebox',
        title: `白模：${prims.length} 个部件`,
        summary: String(call.input.note ?? ''),
        ops,
        doubts: [],
        ...(call.input.supersedes ? { supersedes: String(call.input.supersedes) } : defs.about ? { supersedes: defs.about } : {}),
      });
      return proposed;
    }
    case 'propose_shots': {
      if (!context.workId || !context.sceneId) return { text: '分镜要先打开一场正文（workId + sceneId）。', refs: [] };
      const workRow = (
        await client.query<{ document: WorkDocument }>(
          'select document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
          [account, dossier, context.workId],
        )
      ).rows[0];
      const scene = workRow?.document.chapters.flatMap((chapter) => chapter.scenes).find((item) => item.id === context.sceneId);
      const roomPlace = world.entities.find((item) => item.id === context.placeId);
      if (!context.placeId || !roomPlace?.place?.room)
        return {
          text: `这一场所在的房间还没有几何（place.room）。先给「${roomPlace?.name ?? '这个地点'}」定轮廓和层高（whitebox 提议里一并写 place.room），再拆镜头。`,
          refs: [],
          ok: false,
          step: '房间没几何，先补房间',
        };
      const box = (world.whiteboxes ?? []) as { placeId: string; version: number }[];
      const currentBox = box.filter((item) => item.placeId === context.placeId).sort((a, b) => a.version - b.version).at(-1);
      const rows = (call.input.shots as Record<string, unknown>[]) ?? [];
      const ops = rows.map((row, index) => {
        const camera = (row.camera ?? {}) as { eye?: number[]; target?: number[]; fov?: number };
        const cast = ((row.cast as Record<string, unknown>[]) ?? []).map((member) => ({
          entityId: String(member.entityId ?? ''),
          assetVersionId: selectedVersionIds.get(String(member.entityId ?? '')) ?? null,
          at: (member.at as [number, number, number]) ?? [0, 0, 0],
          facing: Number(member.facing ?? 0),
          pose: (['stand', 'sit', 'walk'].includes(String(member.pose)) ? String(member.pose) : 'stand') as 'stand',
          to: null,
        }));
        const paragraph = (scene?.text ?? '').split(/\n\s*\n/)[Number(row.para ?? 0)] ?? '';
        return {
          op: 'shot.add',
          shot: {
            n: Number(row.n ?? index + 1),
            workId: context.workId,
            sceneId: context.sceneId,
            para: Number(row.para ?? 0),
            durationSec: Math.min(10, Math.max(4, Number(row.durationSec ?? 5))),
            placeId: context.placeId!,
            whiteboxVersion: currentBox?.version ?? 0,
            cast,
            camera: {
              eye: (camera.eye as [number, number, number]) ?? [0, 1.6, 3],
              target: (camera.target as [number, number, number]) ?? [0, 1.2, 0],
              fov: Number(camera.fov ?? 45),
            },
            action: String(row.action ?? ''),
            dialogue: row.dialogue ? String(row.dialogue) : null,
            light: row.light ? String(row.light) : null,
            basisText: paragraph.trim() || null,
          },
        };
      });
      // 每镜至少一个人物（除非明确是空镜）；改版时只交改了的镜头，其余沿用旧版
      const emptyShot = Boolean(call.input.emptyShot);
      const emptied = rows.filter((row) => !((row.cast as unknown[]) ?? []).length);
      if (emptied.length && !emptyShot)
        return {
          text: `有 ${emptied.length} 个镜头没有人物。要么补上 cast（每镜至少一个人），要么明确说明这是空镜（emptyShot）。`,
          refs: [],
          ok: false,
          step: '有镜头没人物',
        };
      const prevProposal = defs.about
        ? worldState.document.proposals.find((item: Proposal) => item.id === defs.about && item.kind === 'shots')
        : undefined;
      const prevShots = (prevProposal?.ops ?? [])
        .filter((op) => op.op === 'shot.add')
        .map((op) => (op as unknown as { shot: Record<string, unknown> }).shot);
      const byN = new Map(prevShots.map((shot: Record<string, unknown>) => [Number(shot.n), shot]));
      for (const op of ops as { op: string; shot: Record<string, unknown> }[]) byN.set(Number(op.shot.n), op.shot);
      const merged = [...byN.values()].sort((a: Record<string, unknown>, b: Record<string, unknown>) => Number(a.n) - Number(b.n));
      const proposed = await createProposal(defs, world, {
        kind: 'shots',
        title: `镜头表：${merged.length} 镜`,
        summary: String(call.input.note ?? ''),
        ops: merged.map((shot) => ({ op: 'shot.add', shot })),
        doubts: [],
        ...(call.input.supersedes ? { supersedes: String(call.input.supersedes) } : defs.about ? { supersedes: defs.about } : {}),
      });
      return proposed;
    }
    default:
      return { text: '没有这个工具。', refs: [] };
  }
}

/** 交一条设定提议：写进待确认，并先算「这条提议自己带出来的冲突」。 */
async function createProposal(
  defs: RunToolContext,
  world: CreativeDocument,
  input: {
    kind: Proposal['kind'];
    title: string;
    summary: string;
    ops: unknown[];
    doubts: string[];
    supersedes?: string;
  },
): Promise<{ text: string; refs: BoardRef[]; step?: string; ok?: boolean }> {
  const { client, account, dossier } = defs;
  const state = await loadWorld(client, account, dossier, { lock: true });
  // 时间先用同一个解析器过一遍：认不出就不进待确认，把原因回给模型当场改
  const context = timeContext(state.document);
  for (const op of input.ops as { op?: string; event?: { title?: string; start?: { input?: string }; end?: { input?: string } } }[]) {
    if (op.op !== 'event.add' || !op.event) continue;
    for (const [field, time] of [
      ['开始', op.event.start?.input],
      ['结束', op.event.end?.input],
    ] as const) {
      if (!time) continue;
      const parsed = parseStoryTime(time, context);
      if (!parsed.ok)
        return {
          ok: false,
          step: `提议没交成：「${time}」认不出`,
          text: `这条提议没交成：「${op.event.title ?? '事件'}」的${field}时间「${time}」认不出。可以写 1684-05-03 11:00（T 分隔也行）、1684-05-03 午时、第 3 日 08:00，或相对参照「出城后三天」。改好再交一次。`,
          refs: [],
        };
    }
  }
  const proposal: Proposal = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    ops: input.ops as unknown as Proposal['ops'],
    origin: { basis: 'inferred', by: 'advisor' },
    runId: defs.runId,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    doubts: input.doubts,
    dependsOn: [],
    conflicts: [],
    status: 'pending',
  };
  // 改版：旧版作废，原因「被新版替代」（契约 §11.2）
  const superseded = input.supersedes
    ? state.document.proposals.find((item) => item.id === input.supersedes)
    : undefined;
  const proposals = state.document.proposals.map((item) =>
    superseded && item.id === superseded.id && (item.status === 'pending' || item.status === 'deferred')
      ? {
          ...item,
          status: 'rejected' as const,
          resolution: { decision: 'rejected' as const, reason: '被新版替代', at: new Date().toISOString(), by: 'agent' as const },
        }
      : item,
  );
  const next: CreativeDocument = { ...state.document, proposals: [...proposals, proposal] };
  await client.query(
    'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
    [account, dossier, state.revision + 1, JSON.stringify(next)],
  );
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.proposal', data: proposal },
    { type: 'creative.op', data: { revision: state.revision + 1, applied: [] } },
  ]);
  defs.proposals.push(proposal.id);
  // 看板先描一下这条提议动到的现有条目（新条目还没有真 id，等预览画虚影）
  const refs: BoardRef[] = [];
  const seen = new Set<string>();
  const byName = (name?: string | null): string =>
    name ? String(state.document.entities.find((item) => item.name === name || (item.aliases ?? []).includes(name))?.id ?? '') : '';
  const addRef = (kind: BoardRef['kind'], id: string) => {
    if (!id || id.startsWith('pv:') || seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    refs.push({ kind, id } as BoardRef);
  };
  for (const op of proposal.ops as unknown as Record<string, unknown>[]) {
    const opKind = String(op.op ?? '');
    if (opKind === 'entity.add') {
      const entity = op.entity as { place?: { parentId?: string | null } } | undefined;
      if (entity?.place?.parentId) addRef('entity', entity.place.parentId);
      continue;
    }
    if (opKind.startsWith('entity.')) addRef('entity', String(op.id ?? ''));
    else if (opKind.startsWith('event.')) addRef('event', String(op.id ?? ''));
    else if (opKind.startsWith('relation.')) addRef('relation', String(op.id ?? ''));
    else if (opKind.startsWith('rule.')) addRef('rule', String((op.rule as { id?: string } | undefined)?.id ?? op.id ?? ''));
    if (opKind === 'event.add' || opKind === 'event.update') {
      const event = (op.event ?? op.patch ?? {}) as {
        participants?: { entityId?: string; entityName?: string }[];
        placeId?: string | null;
        placeName?: string | null;
      };
      const placeId = event.placeId || byName(event.placeName);
      if (placeId) addRef('entity', placeId);
      for (const participant of event.participants ?? []) addRef('entity', participant.entityId || byName(participant.entityName));
    }
  }
  return {
    ok: true,
    step: '交了提议，画在看板上',
    text: `已交一条设定提议（${proposal.id.slice(0, 8)}）：${proposal.title}。它进了待确认，作者接受才入账。${superseded ? '上一版已经作废（被新版替代）。' : ''}`,
    refs,
  };
}

const pushFocus = async (
  db: import('../db/database').Database,
  account: string,
  dossier: string,
  data: import('@reinlab/contracts').BoardFocus,
): Promise<void> => {
  await db.withAccount(account, (client) => appendEvents(client, { account, dossier }, [{ type: 'creative.focus', data }]));
};

/** 交提议之后那条 focus 带 proposalId（其余工具不带）。 */
const defs_proposalId = (call: { name: string }, proposals: string[]): string | null =>
  call.name.startsWith('propose_') && proposals.length ? (proposals.at(-1) ?? null) : null;

/** 跑一轮：读历史 + 上下文 → 循环调用工具 → 落一条 assistant/message。 */
export async function runTurn(deps: SessionRunDeps, account: string, runId: string, query: string): Promise<void> {
  if (!deps.chat) throw new ApiFailure('ASSISTANT_UNAVAILABLE', 503, '本机没配置模型 key，助手开不了。');
  const meta = await deps.db.withAccount(account, async (client) => {
    const row = (
      await client.query<{ dossier_id: string; input: Record<string, string> }>(
        'select dossier_id, input from run where account_id=$1 and id=$2',
        [account, runId],
      )
    ).rows[0];
    if (!row) throw new ApiFailure('RUN_NOT_FOUND', 404, '运行不存在。');
    await client.query("update run set state='running' where account_id=$1 and id=$2", [account, runId]);
    return row;
  });
  const dossier = meta.dossier_id;
  const role: 'advisor' | 'writer' | 'director' =
    meta.input.creativeMode === 'creative_writer' ? 'writer' : meta.input.creativeMode === 'creative_director' ? 'director' : 'advisor';
  const context: SessionContext = {
    dossierId: dossier,
    workId: meta.input.workId ? String(meta.input.workId) : null,
    sceneId: meta.input.sceneId ? String(meta.input.sceneId) : null,
    ...(meta.input.placeId ? { placeId: String(meta.input.placeId) } : {}),
  };
  const aboutRaw = meta.input.about;
  const about = typeof aboutRaw === 'string' && aboutRaw ? aboutRaw : undefined;
  const say = async (who: 'user' | 'assistant', text: string, key: string) => {
    await deps.db.withAccount(account, (client) =>
      appendEvent(client, account, {
        dossierId: dossier,
        runId,
        roleId: 'bench-assist',
        kind: 'message',
        action: `${who}/message`,
        risk: 'read',
        payload: { message: { id: `${runId}:${key}`, role: who, content: [{ type: 'text', text }] } },
        dedupeKey: `creative-run:${runId}:${key}`,
      }),
    );
  };
  const keyBase = `turn-${(meta.input as { turn?: number }).turn ?? Date.now()}`;
  await say('user', query, `${keyBase}-user`);

  const tools = role === 'advisor' ? TOOLS_ADVISOR : role === 'director' ? TOOLS_DIRECTOR : TOOLS_WRITER;
  try {
    const history = await deps.db.withAccount(account, (client) => readHistory(client, account, runId));
    const worldState = await deps.db.withAccount(account, (client) => loadWorld(client, account, dossier));
    const world = context.workId
      ? (await deps.db.withAccount(account, (client) => effectiveWorldOf(client, account, dossier, context.workId!))).document
      : worldState.document;
    const legs = await deps.db.withAccount(account, (client) => buildLegs(client, { account, dossier, document: world }));
    const check = runCheck({ document: world, legs, revision: worldState.revision, now: new Date().toISOString() });
    const contextBlock = [
      `当前档案：${dossier}${context.workId ? `｜作品：${context.workId}${context.sceneId ? `｜场景：${context.sceneId}` : ''}` : ''}`,
      context.workId ? '（这部作品用的是它自己实际用的设定，不是世界观草稿）' : '（当前是世界观草稿）',
      `最近检查：确定冲突 ${check.conflicts.filter((item) => item.severity === 'hard').length} 条，疑似 ${check.conflicts.filter((item) => item.severity === 'suspect').length} 条，未覆盖 ${check.uncovered.length} 条。`,
      about ? `作者在看板上要改的是这条提议：${about}（交新版时会被它替代）。` : '',
      '要读设定/正文/检查/版本差异用工具；交提议用 propose 工具。回复用 Markdown，简洁。',
      '提议的明细作者会在看板上看到，回复里不复述明细，只说一两句要点和拿不准的地方。',
    ].join('\n');
    const messages: ChatMessage[] = [...history];
    const proposals: string[] = [];
    let finalText = '';
    let lastToolText = '';
    for (let step = 0; step < 6; step += 1) {
      const turn = await callChat(deps.chat, {
        system: `${ROLE_PROMPT[role]}\n\n${contextBlock}`,
        messages,
        tools,
      });
      await recordUsage(deps.db, account, dossier, runId, deps.chat, turn.usage);
      if (turn.toolCalls.length) {
        messages.push({ role: 'assistant', content: turn.text || '（调用工具）' });
        const results: string[] = [];
        for (const call of turn.toolCalls) {
          const outcome = await deps.db.withAccount(account, (client) =>
            runTool({ client, account, dossier, context, role, runId, ...(about ? { about } : {}), proposals }, call),
          );
          // 看板「正在看」：每次读工具推一条，refs 是这次读到的东西，step 服务端写（契约 §11.4）
          const focus = focusStep(call.name, call.input);
          // 交提议失败时 step 写真实原因（不能一律写「交了提议」）
          await pushFocus(deps.db, account, dossier, {
            runId,
            mode: role === 'director' ? 'creative_director' : role === 'advisor' ? 'creative_advisor' : 'creative_writer',
            step: outcome.step ?? focus.step,
            refs: outcome.refs.length ? outcome.refs : focus.refs,
            proposalId: outcome.ok === false ? null : defs_proposalId(call, proposals),
            done: false,
          });
          lastToolText = outcome.text;
          results.push(`【${call.name}】\n${outcome.text}`);
        }
        messages.push({ role: 'user', content: results.join('\n\n') });
        finalText = turn.text;
        continue;
      }
      finalText = turn.text;
      break;
    }
    // 模型没给正文（比如最后只调了工具就停）：把工具的结果/拒绝原因当回复，别让作者看到空白
    if (!finalText.trim() && lastToolText.trim()) finalText = lastToolText.trim();
    if (!finalText.trim()) finalText = '这一步没有写出回复。';
    await say('assistant', finalText, `${keyBase}-assistant`);
    await pushFocus(deps.db, account, dossier, {
      runId,
      mode: role === 'director' ? 'creative_director' : role === 'advisor' ? 'creative_advisor' : 'creative_writer',
      step: '完成',
      refs: [],
      done: true,
    });
    await deps.db.withAccount(account, async (client) => {
      await client.query("update run set state='completed', ended_at=now(), input=jsonb_set(input,'{turn}', to_jsonb(coalesce((input->>'turn')::int,0)+1)) where account_id=$1 and id=$2", [account, runId]);
    });
  } catch (error) {
    const message = error instanceof ApiFailure ? error.message : String((error as Error)?.message ?? error);
    await deps.db
      .withAccount(account, async (client) => {
        await appendEvent(client, account, {
          dossierId: dossier,
          runId,
          roleId: 'bench-assist',
          kind: 'message',
          action: 'assistant/message',
          risk: 'read',
          payload: { message: { id: `${runId}:${keyBase}-error`, role: 'assistant', content: [{ type: 'text', text: `这一步没成：${clip(message, 300)}` }] } },
          dedupeKey: `creative-run:${runId}:${keyBase}-error`,
        });
        await client.query("update run set state='completed', ended_at=now() where account_id=$1 and id=$2", [account, runId]);
      })
      .catch(() => undefined);
    await pushFocus(deps.db, account, dossier, {
      runId,
      mode: role === 'director' ? 'creative_director' : role === 'advisor' ? 'creative_advisor' : 'creative_writer',
      step: '完成',
      refs: [],
      done: true,
    }).catch(() => undefined);
  }
}

export { paragraphsOf, wordsOf };
