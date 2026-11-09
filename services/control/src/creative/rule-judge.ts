/**
 * 自然语言规则由模型判（29 号开场第 3 条）。
 *
 * 顾问交上来的规则，能翻成程序可判形式的已经翻了（rule.machine）；翻不了的（宵禁这类和时段、
 * 地点相关的）在检查时由模型读相关事件来判断，结果标「疑似」（severity: suspect），附上原句和理由，
 * 不算确定冲突。「未覆盖」只留连模型都判不了的。
 *
 * 判定结果按「事件指纹」缓存：事件或规则没变就不重复花钱。
 */

import type pg from 'pg';
import type { CreativeCny as Cny } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvents } from './events';
import { loadWorld } from './service';
import { callStructured } from './model-call';
import { extractJson } from './model-call';
import { clip } from './text';
import type { CreativeDocument } from './world';

export type RuleJudgement = {
  ruleId: string;
  fingerprint: string;
  at: string;
  suspects: { eventId: string; why: string; quote?: string }[];
};

export type JudgeDeps = {
  model?: { baseUrl: string; apiKey: string; model: string; transport?: typeof fetch; maxTokens?: number };
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  provider?: string;
};

const SYSTEM = `你在给一部小说的世界观做规则检查。

用户会给你：①若干条自然语言的规矩（比如「苏州城宵禁，入夜城门关闭」）；②这本书里的事实事件，每条带 id、时间、地点、参与者、经过。

只输出 JSON：{"violations":[{"ruleId":"","eventId":"","why":"","quote":""}]}

底线：
- 只报「这条规矩被这些事件违反」的情况：时间、地点、人物对得上，才报。
- 判不准、信息不全（比如事件时间不明）就不要报；宁可漏，不要编。
- why 用一句话说清哪一条对不上；quote 引用事件里最关键的那半句。`;

import { fingerprintOf } from './fingerprint';


export function judgeableRules(document: CreativeDocument): { id: string; text: string }[] {
  return document.rules.filter((rule) => !rule.machine).map((rule) => ({ id: rule.id, text: rule.text }));
}

/** 现有判定还新不新（事件和规则没变就复用）。 */
export function freshJudgements(document: CreativeDocument): RuleJudgement[] {
  const fingerprint = fingerprintOf(document);
  return (document.ruleJudgements ?? []).filter((item) => item.fingerprint === fingerprint);
}

const costOf = (deps: JudgeDeps, usage: { inputTokens: number | null; outputTokens: number | null }): Cny => {
  if (!deps.pricing || !Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens))
    return { value: null, known: false };
  return {
    value:
      ((usage.inputTokens as number) * deps.pricing.inputPerMillion + (usage.outputTokens as number) * deps.pricing.outputPerMillion) / 1_000_000,
    known: true,
  };
};

/** 跑一次「模型判规则」，结果写进文档的 ruleJudgements（按指纹缓存）。 */
export async function judgeRules(
  db: import('../db/database').Database,
  deps: JudgeDeps,
  account: string,
  dossier: string,
): Promise<{ judged: number; skipped: number; cost: Cny; errors: string[] }> {
  const model = deps.model;
  if (!model) throw new ApiFailure('JUDGE_UNAVAILABLE', 503, '本机没配置模型 key，规则判定开不了。');
  const state = await db.withAccount(account, (client) => loadWorld(client, account, dossier, { lock: true }));
  const rules = judgeableRules(state.document);
  if (!rules.length) return { judged: 0, skipped: 0, cost: { value: 0, known: true }, errors: [] };
  const fingerprint = fingerprintOf(state.document);
  const fresh = state.document.ruleJudgements?.filter((item: { fingerprint: string }) => item.fingerprint === fingerprint).length ?? 0;
  if (fresh >= rules.length) return { judged: 0, skipped: rules.length, cost: { value: 0, known: true }, errors: [] };

  const facts = state.document.events
    .filter((event) => event.narrative === 'fact')
    .map((event) => {
      const place = state.document.entities.find((entity) => entity.id === event.placeId)?.name ?? '地点未定';
      const who = event.participants
        .map((participant) => state.document.entities.find((entity) => entity.id === participant.entityId)?.name ?? participant.entityId)
        .join('、');
      return `- ${event.id}｜${event.start?.label ?? '时间未定'} → ${event.end?.label ?? ''}｜${place}｜${who || '无'}｜${event.title}：${clip(event.what, 120)}`;
    })
    .join('\n');
  const prompt = [
    '规矩：',
    ...rules.map((rule) => `- ${rule.id}｜${rule.text}`),
    '',
    '事实事件：',
    facts,
  ].join('\n');

  const result = await callStructured(model, { system: SYSTEM, prompt, maxTokens: 2000 });
  const parsed = extractJson(result.text) as { violations?: unknown } | null;
  const rows = Array.isArray(parsed?.violations) ? parsed.violations : [];
  const byRule = new Map<string, { eventId: string; why: string; quote?: string }[]>();
  for (const row of rows.slice(0, 100)) {
    const entry = row as Record<string, unknown>;
    const ruleId = String(entry.ruleId ?? '');
    const eventId = String(entry.eventId ?? '');
    if (!rules.some((rule) => rule.id === ruleId) || !state.document.events.some((event) => event.id === eventId)) continue;
    const list = byRule.get(ruleId) ?? [];
    list.push({ eventId, why: clip(entry.why, 300) || '这条规矩可能和这条事件对不上', ...(entry.quote ? { quote: clip(entry.quote, 160) } : {}) });
    byRule.set(ruleId, list);
  }
  const at = new Date().toISOString();
  const judgements: RuleJudgement[] = rules.map((rule) => ({
    ruleId: rule.id,
    fingerprint,
    at,
    suspects: byRule.get(rule.id) ?? [],
  }));
  const cost = costOf(deps, result.usage);
  await db.withAccount(account, async (client) => {
    await client.query(
      `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose)
       values(gen_random_uuid(),$1,$2,null,$3,$4,$5,$6,$7,null,null,$8,'creative_judge')`,
      [
        account,
        dossier,
        deps.provider ?? 'deepseek-official',
        model.model,
        cost.known,
        cost.known ? result.usage.inputTokens : null,
        cost.known ? result.usage.outputTokens : null,
        cost.known && cost.value !== null ? cost.value.toFixed(6) : null,
      ],
    );
  });
  await db.withAccount(account, async (client) => {
    const current = await loadWorld(client, account, dossier, { lock: true });
    const kept = (current.document.ruleJudgements ?? []).filter((item: { fingerprint: string }) => item.fingerprint === fingerprint);
    const next = { ...current.document, ruleJudgements: [...kept, ...judgements] };
    await client.query(
      'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
      [account, dossier, current.revision + 1, JSON.stringify(next)],
    );
    await appendEvents(client, { account, dossier }, [{ type: 'creative.op', data: { revision: current.revision + 1, applied: [] } }]);
  });
  return { judged: judgements.length, skipped: 0, cost, errors: [] };
}

export { fingerprintOf };
