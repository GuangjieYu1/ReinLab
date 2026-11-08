/**
 * 扫正文（1C 契约 §6.3「POST impact/scan」）。
 *
 * 找的是「没有明确引用、但可能受影响」的段落：设定改了以后，正文里那些写到了却没用 id 连过去的句子。
 * AI 读整份正文（分段给序号），只交回 {条目, 场景, 段落, 原句, 理由}；只是线索，作者可以忽略。
 * 异步、花钱、只记不拦；失败给原因，不伪造成功。
 */

import type pg from 'pg';
import type { CreativeCny as Cny, ItemChange } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { appendEvents } from './events';
import { callStructured, extractJson, type ModelDeps } from './model-call';
import { diffDocuments } from './items';
import { clip } from './text';
import { paragraphsOf, type WorkDocument } from './work';
import type { CreativeDocument } from './world';
import type { MaybeHit, ScanDocument } from './impact';

export type ScanDeps = {
  model?: ModelDeps;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  provider?: string;
};

const SYSTEM = `你在帮一个小说作者检查：世界观改了设定以后，正文里哪些段落可能也要跟着改。

用户会给你两样东西：①这次改了哪些设定条目（带 id、标题、改了哪些字段）；②几部作品的正文，按
「作品 id | 章 id | 场 id | 段号 | 正文」一行一行列出来。

只输出 JSON：{"hits":[{"itemId":"","workId":"","chapterId":"","sceneId":"","para":0,"quote":"","why":""}]}

底线：
- 只找「可能受影响」的段落：写到了这条设定（同名地点、同一个人、同一天发生的事、被改的时间点），
  但正文里没有明确用 id 连过去的句子。原文明确引用的段落不用报（系统自己会算）。
- quote 照抄那一句原文，不超过 60 字；para 用给你的段号。
- 说不清为什么受影响的不要报。没有就回空数组。`;

export type ScanHit = MaybeHit;

/** 把作品正文摊成「作品|章|场|段」带序号的文本。 */
export function scanTextOf(works: { id: string; title: string; document: WorkDocument }[]): string {
  const lines: string[] = [];
  for (const work of works) {
    lines.push(`## 作品 ${work.id}《${work.title}》`);
    for (const chapter of work.document.chapters)
      for (const scene of chapter.scenes) {
        if (!scene.text.trim()) continue;
        const paragraphs = paragraphsOf(scene.text);
        paragraphs.forEach((paragraph, para) => {
          if (!paragraph.trim()) return;
          lines.push(`${work.id}|${chapter.id}|${scene.id}|${para}|${paragraph.replace(/\s+/g, ' ').slice(0, 400)}`);
        });
      }
  }
  return lines.join('\n');
}

export function changesForPrompt(items: ItemChange[]): string {
  return items
    .map((item) => `- id=${item.itemId}｜${item.title}｜${item.change}${item.fields.length ? `｜改了：${item.fields.join('、')}` : ''}`)
    .join('\n');
}

export function normalizeHits(raw: unknown, input: { workIds: Set<string>; itemIds: Set<string> }): ScanHit[] {
  const payload = (raw ?? {}) as { hits?: unknown };
  const rows = Array.isArray(payload.hits) ? payload.hits : [];
  const hits: ScanHit[] = [];
  for (const row of rows.slice(0, 200)) {
    const entry = row as Record<string, unknown>;
    const itemId = String(entry.itemId ?? '');
    const workId = String(entry.workId ?? '');
    const chapterId = String(entry.chapterId ?? '');
    const sceneId = String(entry.sceneId ?? '');
    const quote = clip(entry.quote, 120).trim();
    const why = clip(entry.why, 300).trim();
    const para = Number(entry.para);
    if (!input.itemIds.has(itemId) || !input.workIds.has(workId) || !sceneId || !quote) continue;
    hits.push({
      itemId,
      ref: {
        kind: 'scene',
        workId,
        chapterId,
        sceneId,
        para: Number.isFinite(para) && para >= 0 ? Math.floor(para) : 0,
        quote,
        why: why || '这段可能跟改的设定有关',
      },
    });
  }
  return hits;
}

const costOf = (deps: ScanDeps, usage: { inputTokens: number | null; outputTokens: number | null }): Cny => {
  if (!deps.pricing || !Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens))
    return { value: null, known: false };
  return {
    value:
      ((usage.inputTokens as number) * deps.pricing.inputPerMillion +
        (usage.outputTokens as number) * deps.pricing.outputPerMillion) /
      1_000_000,
    known: true,
  };
};

export const readScanDocument = async (
  client: pg.PoolClient,
  account: string,
  dossier: string,
  from: number,
  to: number,
): Promise<ScanDocument | null> => {
  const row = (
    await client.query<{ document: ScanDocument }>(
      'select document from creative_impact_scan where account_id=$1 and dossier_id=$2 and from_version=$3 and to_version=$4',
      [account, dossier, from, to],
    )
  ).rows[0];
  return row?.document ?? null;
};

const saveScanDocument = async (
  client: pg.PoolClient,
  account: string,
  dossier: string,
  document: ScanDocument,
): Promise<void> => {
  await client.query(
    `insert into creative_impact_scan(account_id,dossier_id,from_version,to_version,state,document,updated_at)
     values($1,$2,$3,$4,$5,$6::jsonb,now())
     on conflict (account_id,dossier_id,from_version,to_version)
     do update set state=excluded.state, document=excluded.document, updated_at=now()`,
    [account, dossier, document.fromVersion, document.toVersion, document.state, JSON.stringify(document)],
  );
};

/** 开一个扫正文任务：先落一条 running，再在事务外跑。 */
export async function beginScan(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  from: number,
  to: number,
): Promise<ScanDocument> {
  const document: ScanDocument = {
    fromVersion: from,
    toVersion: to,
    state: 'running',
    cost: { value: 0, known: true },
    error: null,
    hits: [],
  };
  await saveScanDocument(client, account, dossier, document);
  await appendEvents(client, { account, dossier }, [
    { type: 'creative.impact', data: document },
  ]);
  return document;
}

export type ScanRunDeps = ScanDeps & { db: import('../db/database').Database };

/** 跑一次扫正文：读版本差异 + 各作品正文，问模型「哪些段落可能受影响」。 */
export async function runScan(
  deps: ScanRunDeps,
  account: string,
  dossier: string,
  from: number,
  to: number,
): Promise<void> {
  const heads = await deps.db.withAccount(account, async (client) => {
    const fromRow = (
      await client.query<{ world: CreativeDocument }>(
        'select world from creative_version where account_id=$1 and dossier_id=$2 and n=$3',
        [account, dossier, from],
      )
    ).rows[0];
    const toRow = (
      await client.query<{ world: CreativeDocument }>(
        'select world from creative_version where account_id=$1 and dossier_id=$2 and n=$3',
        [account, dossier, to],
      )
    ).rows[0];
    if (!fromRow || !toRow) throw new ApiFailure('VERSION_NOT_FOUND', 404, '没有这两个版本，扫不了。');
    const works = (
      await client.query<{ work_id: string; document: WorkDocument }>(
        'select work_id, document from creative_work where account_id=$1 and dossier_id=$2',
        [account, dossier],
      )
    ).rows;
    return {
      items: diffDocuments(fromRow.world, toRow.world),
      works: works.map((row) => ({ id: row.work_id, title: row.document.title, document: row.document })),
    };
  });

  const model = deps.model;
  if (!model) {
    await failScan(deps, account, dossier, from, to, '本机没配置模型 key，扫正文开不了。');
    return;
  }
  if (!heads.items.length) {
    await deps.db.withAccount(account, async (client) => {
      const done: ScanDocument = { fromVersion: from, toVersion: to, state: 'done', cost: { value: 0, known: true }, error: null, hits: [] };
      await saveScanDocument(client, account, dossier, done);
      await appendEvents(client, { account, dossier }, [{ type: 'creative.impact', data: done }]);
    });
    return;
  }

  const hits: MaybeHit[] = [];
  let cost: Cny = { value: 0, known: true };
  try {
    for (const work of heads.works) {
      const prompt = [
        `这次改的设定条目：`,
        changesForPrompt(heads.items),
        '',
        `正文：`,
        scanTextOf([work]),
      ].join('\n');
      const result = await callStructured(model, { system: SYSTEM, prompt, maxTokens: 3000 });
      const parsed = extractJson(result.text);
      const added = normalizeHits(parsed, {
        workIds: new Set([work.id]),
        itemIds: new Set(heads.items.map((item) => item.itemId)),
      });
      hits.push(...added);
      const callCost = costOf(deps, result.usage);
      if (callCost.known && callCost.value !== null && cost.value !== null)
        cost = { value: Number((cost.value + callCost.value).toFixed(6)), known: true };
      else cost = { value: cost.value, known: cost.known && callCost.known };
      await deps.db.withAccount(account, async (client) => {
        await client.query(
          `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cny,purpose)
           values(gen_random_uuid(),$1,$2,null,$3,$4,$5,$6,$7,null,null,$8,'creative_scan')`,
          [
            account,
            dossier,
            deps.provider ?? 'deepseek-official',
            model.model,
            callCost.known,
            callCost.known ? result.usage.inputTokens : null,
            callCost.known ? result.usage.outputTokens : null,
            callCost.known && callCost.value !== null ? callCost.value.toFixed(6) : null,
          ],
        );
      });
    }
    await deps.db.withAccount(account, async (client) => {
      const done: ScanDocument = { fromVersion: from, toVersion: to, state: 'done', cost, error: null, hits };
      await saveScanDocument(client, account, dossier, done);
      await appendEvents(client, { account, dossier }, [{ type: 'creative.impact', data: done }]);
    });
  } catch (error) {
    await failScan(deps, account, dossier, from, to, clip(String((error as Error)?.message ?? error), 300));
  }
}

async function failScan(
  deps: ScanRunDeps,
  account: string,
  dossier: string,
  from: number,
  to: number,
  message: string,
): Promise<void> {
  await deps.db
    .withAccount(account, async (client) => {
      const failed: ScanDocument = { fromVersion: from, toVersion: to, state: 'failed', cost: { value: null, known: false }, error: message, hits: [] };
      await saveScanDocument(client, account, dossier, failed);
      await appendEvents(client, { account, dossier }, [{ type: 'creative.impact', data: failed }]);
    })
    .catch(() => undefined);
}
