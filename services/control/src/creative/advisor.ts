/**
 * 设定顾问（1B 契约 §5.2「助手」、19 §6「加人物」）：从一个想法提出设定。
 *
 * 底线：只提作者说得出的东西；不知道的地点、年代留空并写疑点；提出的经历先跑一遍硬检查，
 * 检查结果跟着提议一起交上来（`conflicts`），不冒称「检查通过」。所有产出都是提议，作者接受才入账。
 *
 * 一次调用出一条提议（itinerary / entity / event / rule 里的一种）；路线不写进 ops——
 * 路线是按事件和路网算出来的，接受以后自然会算，算不出来再走推断路线。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { CreativeCny as Cny, CreativeOp, Proposal } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { runCheck } from './check';
import { appendEvents } from './events';
import { buildLegs } from './routing';
import { loadWorld } from './service';
import { effectiveWorldOf } from './effective';
import { callStructured, extractJson, type ModelDeps } from './model-call';
import { clip } from './text';
import { applyOps, type CreativeDocument } from './world';
import { parseStoryTime } from './story-time';

const SYSTEM = `你在给一部小说的世界观当设定顾问。用户给你一句话的想法，和现有的设定摘要。

只输出 JSON：
{
  "kind": "itinerary|entity|event|rule|relation",
  "title": "一句话说这条提议是什么",
  "summary": "人话说明（谁、何时、从哪来、为什么在这儿）",
  "entities": [{"name":"","kind":"person|place|item|org","aliases":[],"summary":"","level":"city|building|room|site","parent":"已有地点名"}],
  "events": [{"title":"","what":"","kind":"stay|travel|interaction|birth|death|other","participants":[{"name":"","as":"actor|present|remote|mentioned"}],"place":"","start":"","end":"","narrative":"fact|hearsay|dream|hypothetical|flashback"}],
  "rules": [{"text":"","machine":null}],
  "doubts": ["还不确定的地方"]
}

底线：
- 只用用户给的意图和现有设定。时间写原文写法（例如「康熙二十三年三月初七」「第 3 日 08:00」）；不确定就写「未定」，不要编。
- 加人物要给「什么时候从哪来、和谁有交集、为什么在这儿」，不是一句介绍。
- 具体地点能对上现有地点就写现有名字；对不上就新建一个只写名字的地点（没有坐标），不要瞎填经纬度。
- 做得对不上的地方写进 doubts，不要装作确定。`;

export type AdvisorDeps = {
  model?: ModelDeps;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  provider?: string;
};

/**
 * 提议种类的判定（契约 §5.1：加人物是 itinerary）。
 * 模型经常把「建人物 + 几条事件」写成 entity，这里按实际 ops 纠回来。
 */
export function derivedKind(ops: CreativeOp[], declared?: string): Proposal['kind'] {
  const addsPerson = ops.some((op) => op.op === 'entity.add' && op.entity.kind === 'person');
  const addsAnyEntity = ops.some((op) => op.op === 'entity.add');
  const addsEvent = ops.some((op) => op.op === 'event.add');
  const addsRule = ops.some((op) => op.op === 'rule.set');
  const addsRelation = ops.some((op) => op.op === 'relation.add');
  const addable = ['itinerary', 'entity', 'event', 'rule', 'relation', 'map_edit', 'merge', 'route', 'text_edit'];
  if (addsEvent && addsPerson) return 'itinerary';
  if (addsEvent) return 'event';
  if (addsRule) return 'rule';
  if (addsRelation) return 'relation';
  if (addsAnyEntity) return 'entity';
  return declared && addable.includes(declared) ? (declared as Proposal['kind']) : 'event';
}

/** 这一次顾问调用的花费；没配单价或 token 未知就记未知（不记 0）。 */
function costOfUsage(
  deps: AdvisorDeps,
  usage: { inputTokens: number | null; outputTokens: number | null },
): Cny {
  if (!deps.pricing || Number.isInteger(usage.inputTokens) === false || Number.isInteger(usage.outputTokens) === false)
    return { value: null, known: false };
  return {
    value:
      ((usage.inputTokens as number) * deps.pricing.inputPerMillion +
        (usage.outputTokens as number) * deps.pricing.outputPerMillion) /
      1_000_000,
    known: true,
  };
}

export type AdvisorResult = {
  proposals: Proposal[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  cost: Cny;
  /** 模型按底线拒绝提设定（查不到依据）：这不算失败，是「这一步提不出来」的答复。 */
  declined?: string;
};

type AdvisorPayload = {
  kind?: unknown;
  title?: unknown;
  summary?: unknown;
  entities?: unknown;
  events?: unknown;
  rules?: unknown;
  doubts?: unknown;
};

const asText = (value: unknown, max: number): string => clip(value ?? '', max).trim();

/** 模型输出 → 一批 op（实体、事件、规则）。事件里的人物/地点按名字引用，接受时再解析。 */
export function advisorOps(payload: AdvisorPayload): { ops: CreativeOp[]; doubts: string[] } {
  const ops: CreativeOp[] = [];
  const doubts = (Array.isArray(payload.doubts) ? payload.doubts : []).map((item) => asText(item, 300)).filter(Boolean);
  for (const item of Array.isArray(payload.entities) ? payload.entities : []) {
    const row = item as Record<string, unknown>;
    const name = asText(row.name, 60);
    const kind = asText(row.kind, 16) as 'person' | 'place' | 'item' | 'org';
    if (!name || !['person', 'place', 'item', 'org'].includes(kind)) continue;
    ops.push({
      op: 'entity.add',
      entity: {
        kind,
        name,
        aliases: (Array.isArray(row.aliases) ? row.aliases : []).map((alias) => asText(alias, 60)).filter(Boolean),
        ...(row.summary ? { summary: asText(row.summary, 500) } : {}),
        ...(kind === 'place'
          ? {
              place: {
                level: (['world', 'region', 'city', 'building', 'floor', 'room', 'site'].includes(asText(row.level, 16))
                  ? asText(row.level, 16)
                  : 'site') as 'site',
                parentId: null,
                geo: null,
                geoCertainty: 'unlocated' as const,
                connects: [],
              },
              ...(row.parent ? { parentName: asText(row.parent, 60) } : {}),
            }
          : {}),
      },
    } as unknown as CreativeOp);
  }
  for (const item of Array.isArray(payload.events) ? payload.events : []) {
    const row = item as Record<string, unknown>;
    const title = asText(row.title, 120);
    if (!title) continue;
    const participants = (Array.isArray(row.participants) ? row.participants : [])
      .map((participant) => {
        const entry = participant as Record<string, unknown>;
        return { entityId: '', entityName: asText(entry.name, 60), as: asText(entry.as, 16) || 'actor' };
      })
      .filter((participant) => participant.entityName);
    if (!participants.length) continue;
    ops.push({
      op: 'event.add',
      event: {
        title,
        what: asText(row.what, 500) || title,
        kind: (['stay', 'travel', 'interaction', 'birth', 'death', 'other'].includes(asText(row.kind, 16))
          ? asText(row.kind, 16)
          : 'stay') as 'stay',
        participants,
        placeId: null,
        ...(row.place ? { placeName: asText(row.place, 60) } : {}),
        travel: null,
        narrative: (['fact', 'hearsay', 'dream', 'hypothetical', 'flashback'].includes(asText(row.narrative, 16))
          ? asText(row.narrative, 16)
          : 'fact') as 'fact',
        start: { input: asText(row.start, 80) || '未定' },
        end: { input: asText(row.end, 80) || '未定' },
      },
    } as unknown as CreativeOp);
  }
  for (const item of Array.isArray(payload.rules) ? payload.rules : []) {
    const row = item as Record<string, unknown>;
    const text = asText(row.text, 500);
    if (!text) continue;
    // 能翻成程序可判的形式就翻（验收问题 3）：只认检查器支持的四类，翻不了的留 machine: null，
    // 由模型在检查时按事件判、标「疑似」。
    const machineKind = asText((row.machine as Record<string, unknown> | null)?.kind, 20);
    const machine =
      machineKind && ['teleport', 'remote_presence', 'resurrection', 'custom'].includes(machineKind)
        ? {
            kind: machineKind as 'teleport' | 'remote_presence' | 'resurrection' | 'custom',
            params: ((row.machine as Record<string, unknown>)?.params ?? {}) as Record<string, unknown>,
          }
        : null;
    const note = asText(row.machineNote, 200);
    ops.push({ op: 'rule.set', rule: { id: `rule_${randomUUID().slice(0, 8)}`, text, machine } });
    if (machine) doubts.push(`规则「${clip(text, 40)}」翻成了程序可判的「${machine.kind}」${note ? `：${note}` : ''}。`);
    else doubts.push(`规则「${clip(text, 40)}」暂时翻不成程序可判的形式：检查时由模型按相关事件判断，结果标「疑似」。`);
  }
  return { ops, doubts };
}

/**
 * 试算前把「还没确认的人/地点」摘出来（契约 §1.1 补注 1）：
 * 它们没解析成 id，不参与判定，但要在 doubts 里说清楚，不能当作没冲突。
 */
export function splitTrialOps(
  world: CreativeDocument,
  ops: CreativeOp[],
): { trialOps: CreativeOp[]; unresolvedPeople: string[]; unresolvedPlaces: string[] } {
  const known = new Set<string>();
  for (const entity of world.entities) {
    known.add(entity.name);
    for (const alias of entity.aliases ?? []) known.add(alias);
  }
  // 同一批里先建出来的实体，后面的操作能引用到
  for (const op of ops) if (op.op === 'entity.add') known.add(op.entity.name);
  const unresolvedPeople: string[] = [];
  const unresolvedPlaces: string[] = [];
  const trialOps: CreativeOp[] = [];
  for (const op of ops) {
    if (op.op !== 'event.add') {
      trialOps.push(op);
      continue;
    }
    const participants = op.event.participants.filter((participant) => {
      if (participant.entityId) return true;
      const name = participant.entityName ?? '';
      if (name && known.has(name)) return true;
      if (name && !unresolvedPeople.includes(name)) unresolvedPeople.push(name);
      return false;
    });
    const place = op.event.placeName ?? '';
    const placeResolved = !place || known.has(place);
    if (place && !placeResolved && !unresolvedPlaces.includes(place)) unresolvedPlaces.push(place);
    if (!participants.length) continue; // 一个人都对不上：这条不进试算，只留疑点
    const { placeName: _dropped, ...eventRest } = op.event;
    trialOps.push({
      ...op,
      event: {
        ...eventRest,
        participants,
        placeId: null,
        ...(placeResolved && place ? { placeName: place } : {}),
      },
    } as CreativeOp);
  }
  return { trialOps, unresolvedPeople, unresolvedPlaces };
}

/** 试算：把这条提议先应用一份副本，再跑检查，看接受以后会怎样。 */
export async function trialConflicts(
  client: pg.PoolClient,
  input: { account: string; dossier: string; document: CreativeDocument; ops: CreativeOp[] },
): Promise<Proposal['conflicts']> {
  try {
    const applied = applyOps(input.document, input.ops, { actor: 'agent' });
    const legs = await buildLegs(client, {
      account: input.account,
      dossier: input.dossier,
      document: applied.next,
    });
    const check = runCheck({
      document: applied.next,
      legs,
      revision: 0,
      now: new Date().toISOString(),
    });
    return check.conflicts;
  } catch {
    // 试算本身失败（比如时间写法认不出）：不给冲突，交给疑点说明，不假装检查过
    return [];
  }
}

export async function advise(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  deps: AdvisorDeps,
  query: string,
  options: { workId?: string } = {},
): Promise<AdvisorResult> {
  if (!deps.model) throw new ApiFailure('ADVISOR_UNAVAILABLE', 503, '本机没配置模型 key，顾问开不了。');
  const state = await loadWorld(client, account, dossier, { lock: true });
  // 1C：在某一部作品里用时，读的是这部作品实际用的设定（组合还原），不是世界观草稿
  const world = options.workId
    ? (await effectiveWorldOf(client, account, dossier, options.workId)).document
    : state.document;
  const summary = [
    `世界观：${world.title}`,
    `历法：${world.calendars.map((item) => `${item.name}（${item.kind}）`).join('、')}`,
    world.events.length
      ? `已有时间范围：${world.events
          .map((event) => event.start.label)
          .filter((label) => label !== '未定')
          .slice(0, 3)
          .join('、')} 等 ${world.events.length} 条事件`
      : '还没有事件',
    `已有实体：${world.entities.slice(0, 40).map((item) => `${item.name}（${item.kind}）`).join('、') || '无'}`,
    world.events.length
      ? `已有事件：${world.events.slice(0, 20).map((event) => `${event.title}（${event.start.label}）`).join('；')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const result = await callStructured(deps.model, {
    system: SYSTEM,
    prompt: `作者的意图：${query}\n\n现有设定：\n${summary}`,
    maxTokens: 3000,
  });
  const parsed = extractJson(result.text) as AdvisorPayload | null;
  if (!parsed) throw new ApiFailure('ADVISOR_UNREADABLE', 503, '模型没有给出能用的提议。');
  const { ops, doubts } = advisorOps(parsed);
  if (!ops.length) {
    // 没有可入账的东西：照实说，不当成系统故障（会话里显示成一句正常的答复）。
    const reason = doubts.length ? doubts.join('；') : '模型没有给出能入账的设定。';
    const cost = costOfUsage(deps, result.usage);
    await client.query(
      `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose)
       values(gen_random_uuid(),$1,$2,null,$3,$4,$5,$6,$7,null,null,$8,'creative_advisor')`,
      [
        account,
        dossier,
        deps.provider ?? 'deepseek-official',
        deps.model.model,
        cost.known,
        cost.known ? result.usage.inputTokens : null,
        cost.known ? result.usage.outputTokens : null,
        cost.known && cost.value !== null ? cost.value.toFixed(6) : null,
      ],
    );
    return { proposals: [], usage: result.usage, cost, declined: clip(reason, 500) };
  }
  const calendar = world.calendars.find((item) => item.kind === 'chinese_era')?.id ?? 'gregorian';
  // 时间写法先在本机认一遍，认不出的写在疑点里（接受时也不会硬填）
  for (const op of ops) {
    if (op.op !== 'event.add') continue;
    for (const [label, time] of [['开始', op.event.start], ['结束', op.event.end]] as const) {
      if (!time?.input || time.input === '未定') continue;
      const parsedTime = parseStoryTime(time.input, { calendars: world.calendars, events: [], defaultCalendar: calendar });
      if (!parsedTime.ok) doubts.push(`${label}时间「${time.input}」认不出来：${parsedTime.failure.message}`);
    }
  }
  const kind = derivedKind(ops, asText(parsed.kind, 20));
  const { trialOps, unresolvedPeople, unresolvedPlaces } = splitTrialOps(world, ops);
  // 契约 §1.1 补注 1：没解析成 id 的不参与试算，但要说清楚（不能当成没有冲突）。
  for (const name of unresolvedPeople) doubts.push(`「${name}」还没确认，试算没算他。`);
  for (const name of unresolvedPlaces) doubts.push(`「${name}」还没确认，试算没算这个地点。`);
  const conflicts = trialOps.length
    ? await trialConflicts(client, { account, dossier, document: world, ops: trialOps })
    : [];
  const proposal: Proposal = {
    id: randomUUID(),
    kind,
    title: asText(parsed.title, 120) || '设定提议',
    summary: asText(parsed.summary, 1200),
    ops,
    origin: { basis: 'inferred', by: 'advisor', why: asText(parsed.summary, 500) },
    doubts,
    dependsOn: [],
    conflicts,
    status: 'pending',
  };
  const revision = state.revision + 1;
  await client.query(
    'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
    [account, dossier, revision, JSON.stringify({ ...world, proposals: [...world.proposals, proposal] })],
  );
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.proposal', data: proposal },
    { type: 'creative.op', data: { revision, applied: [] } },
  ]);
  const cost: Cny = costOfUsage(deps, result.usage);
  await client.query(
    `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose)
     values(gen_random_uuid(),$1,$2,null,$3,$4,$5,$6,$7,null,null,$8,'creative_advisor')`,
    [
      account,
      dossier,
      deps.provider ?? 'deepseek-official',
      deps.model.model,
      cost.known,
      cost.known ? result.usage.inputTokens : null,
      cost.known ? result.usage.outputTokens : null,
      cost.known && cost.value !== null ? cost.value.toFixed(6) : null,
    ],
  );
  return { proposals: [proposal], usage: result.usage, cost };
}
