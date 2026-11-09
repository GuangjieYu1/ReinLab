/**
 * 创作台的助手会话（29 号开场）：真的 DSH 模式——同一个会话多轮、自动带上下文、
 * 有读工具和「只能交提议」的写工具，回复由模型自己写（Markdown），检查只说这次新带出来的冲突。
 *
 * 会话存在 event 表里（user/message、assistant/message），续一句就是往同一条 run 追加一轮。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CreativeDocument } from './world';
import type { Proposal } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvent } from '../ledger';
import { appendEvents } from './events';
import { advisorOps } from './advisor';
import { loadWorld } from './service';
import { effectiveWorldOf } from './effective';
import { diffDocuments } from './items';
import { runCheck } from './check';
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

const ROLE_PROMPT: Record<'advisor' | 'writer', string> = {
  advisor: `你是这部小说的设定顾问。你只交提议，作者在待确认里接受才入账。
底线：只用给到的设定和原文里已有的东西；缺什么就照实说缺什么，并把它写成「还不确定的」。不要替作者拍板历史事实。`,
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
              start: { type: 'string' },
              end: { type: 'string' },
              narrative: { type: 'string', enum: ['fact', 'hearsay', 'dream', 'hypothetical', 'flashback'] },
            },
            required: ['title', 'what'],
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
      },
      required: ['title'],
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
       values(gen_random_uuid(),$1,$2,null,$3,$4,$5,$6,$7,null,null,$8,'creative_assistant')`,
      [account, dossier, deps.provider ?? 'deepseek-official', deps.model, known, known ? usage.inputTokens : null, known ? usage.outputTokens : null, cost === null ? null : cost.toFixed(6)],
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
  role: 'advisor' | 'writer';
  /** 本轮新建的提议 id（回复里可以引用）。 */
  proposals: string[];
};

/** 执行一轮里的一个工具调用。写工具只交提议。 */
export async function runTool(defs: RunToolContext, call: ToolCall): Promise<string> {
  const { client, account, dossier, context, role } = defs;
  const worldState = await loadWorld(client, account, dossier);
  const world =
    context.workId && role !== 'writer'
      ? (await effectiveWorldOf(client, account, dossier, context.workId)).document
      : context.workId
        ? (await effectiveWorldOf(client, account, dossier, context.workId)).document
        : worldState.document;

  switch (call.name) {
    case 'world_snapshot':
      return digestOf(world);
    case 'event_search': {
      const query = String(call.input.query ?? '');
      const hits = world.events.filter((event) => `${event.title} ${event.what}`.includes(query)).slice(0, 20);
      return hits.length
        ? hits.map((event) => `- ${event.id}｜${event.title}｜${event.start?.label ?? '时间未定'}｜${clip(event.what, 120)}`).join('\n')
        : '没有找到相关事件。';
    }
    case 'check_run': {
      const legs = await buildLegs(client, { account, dossier, document: world });
      const check = runCheck({ document: world, legs, revision: worldState.revision, now: new Date().toISOString() });
      return JSON.stringify(
        {
          确定: check.conflicts.filter((item) => item.severity === 'hard').map((item) => ({ why: item.why, kind: item.kind })),
          疑似: check.conflicts.filter((item) => item.severity === 'suspect').map((item) => ({ why: item.why, kind: item.kind })),
          信息不足: check.insufficient.map((item) => `${item.eventId}：${(item.gaps ?? []).join('；') || '缺信息'}`),
          未覆盖: check.uncovered.map((item) => item.why),
        },
        null,
        1,
      );
    }
    case 'work_scene': {
      if (!context.workId) return '当前没有打开的作品。';
      const work = (
        await client.query<{ document: WorkDocument }>(
          'select document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3',
          [account, dossier, context.workId],
        )
      ).rows[0]?.document;
      if (!work) return '没有这部作品。';
      const sceneId = String(call.input.sceneId ?? context.sceneId ?? '');
      const scene = work.chapters.flatMap((chapter) => chapter.scenes).find((item) => item.id === sceneId);
      if (!scene) return '没有这一场。';
      return `# ${scene.title}\n目标：${scene.goal || '未写'}\n引用事件：${scene.eventIds.join('、') || '无'}\n\n${scene.text}`;
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
      if (!a || !b) return '没有这两个版本。';
      return diffDocuments(a, b)
        .map((item) => `- ${item.title}｜${item.change}${item.fields.length ? `｜改了：${item.fields.join('、')}` : ''}`)
        .join('\n');
    }
    case 'read_file': {
      const root = defs.client ? process.cwd() : process.cwd();
      const target = resolve(root, String(call.input.path ?? ''));
      if (!target.startsWith(root)) return '只能读工作区里的文件。';
      try {
        const content = await readFile(target, 'utf8');
        return clip(content, 20_000);
      } catch {
        return '读不到这个文件。';
      }
    }
    case 'propose_setting': {
      const ops = advisorOps({
        kind: 'itinerary',
        title: String(call.input.title ?? ''),
        summary: String(call.input.summary ?? ''),
        entities: (call.input.entities as unknown[]) ?? [],
        events: (call.input.events as unknown[]) ?? [],
        rules: (call.input.rules as unknown[]) ?? [],
        doubts: (call.input.doubts as unknown[]) ?? [],
      });
      return await createProposal(defs, world, {
        kind: 'itinerary',
        title: String(call.input.title ?? '提议'),
        summary: String(call.input.summary ?? ''),
        ops: ops.ops,
        doubts: ops.doubts,
      });
    }
    case 'propose_text_edit': {
      if (!context.workId) return '当前没有打开的作品，改不了正文。';
      const sceneId = String(call.input.sceneId ?? '');
      const workRow = (
        await client.query<{ revision: number; document: WorkDocument }>(
          'select revision, document from creative_work where account_id=$1 and dossier_id=$2 and work_id=$3 for update',
          [account, dossier, context.workId],
        )
      ).rows[0];
      if (!workRow) return '没有这部作品。';
      const { scene } = sceneOf(workRow.document, sceneId);
      const mode = String(call.input.mode ?? 'rewrite') as 'draft' | 'continue' | 'complete' | 'rewrite';
      const after = clip(call.input.after ?? '', 200_000);
      if (!after) return '没有给正文。';
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
      return `已交一条改稿提议（${proposal.id.slice(0, 8)}）：${proposal.title}，作者在待确认里接受才落笔。`;
    }
    default:
      return '没有这个工具。';
  }
}

/** 交一条设定提议：写进待确认，并先算「这条提议自己带出来的冲突」。 */
async function createProposal(
  defs: RunToolContext,
  world: CreativeDocument,
  input: { kind: Proposal['kind']; title: string; summary: string; ops: unknown[]; doubts: string[] },
): Promise<string> {
  const { client, account, dossier } = defs;
  const state = await loadWorld(client, account, dossier, { lock: true });
  const proposal: Proposal = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    ops: input.ops as unknown as Proposal['ops'],
    origin: { basis: 'inferred', by: 'advisor' },
    doubts: input.doubts,
    dependsOn: [],
    conflicts: [],
    status: 'pending',
  };
  const next: CreativeDocument = { ...state.document, proposals: [...state.document.proposals, proposal] };
  await client.query(
    'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
    [account, dossier, state.revision + 1, JSON.stringify(next)],
  );
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.proposal', data: proposal },
    { type: 'creative.op', data: { revision: state.revision + 1, applied: [] } },
  ]);
  defs.proposals.push(proposal.id);
  return `已交一条设定提议（${proposal.id.slice(0, 8)}）：${proposal.title}。它进了待确认，作者接受才入账。`;
}

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
  const role: 'advisor' | 'writer' = meta.input.creativeMode === 'creative_writer' ? 'writer' : 'advisor';
  const context: SessionContext = {
    dossierId: dossier,
    workId: meta.input.workId ? String(meta.input.workId) : null,
    sceneId: meta.input.sceneId ? String(meta.input.sceneId) : null,
  };
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

  const tools = role === 'advisor' ? TOOLS_ADVISOR : TOOLS_WRITER;
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
      '要读设定/正文/检查/版本差异用工具；交提议用 propose 工具。回复用 Markdown，简洁。',
    ].join('\n');
    const messages: ChatMessage[] = [...history];
    const proposals: string[] = [];
    let finalText = '';
    for (let step = 0; step < 6; step += 1) {
      const turn = await callChat(deps.chat, {
        system: `${ROLE_PROMPT[role]}\n\n${contextBlock}`,
        messages,
        tools,
      });
      await recordUsage(deps.db, account, dossier, deps.chat, turn.usage);
      if (turn.toolCalls.length) {
        messages.push({ role: 'assistant', content: turn.text || '（调用工具）' });
        const results: string[] = [];
        for (const call of turn.toolCalls) {
          const result = await deps.db.withAccount(account, (client) =>
            runTool(
              { client, account, dossier, context, role, proposals },
              call,
            ),
          );
          results.push(`【${call.name}】\n${result}`);
        }
        messages.push({ role: 'user', content: results.join('\n\n') });
        finalText = turn.text;
        continue;
      }
      finalText = turn.text;
      break;
    }
    if (!finalText.trim()) finalText = '这一步没有写出回复。';
    await say('assistant', finalText, `${keyBase}-assistant`);
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
  }
}

export { paragraphsOf, wordsOf };
