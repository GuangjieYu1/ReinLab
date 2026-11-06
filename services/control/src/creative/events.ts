/**
 * 创作台事件流（20-creative-contract.md §3）。
 *
 * seq 全局递增，按 after= 续订；页面按 seq 去重，跳号就重取快照。
 * 只写库、只读库，进程内不再另发一份：断线重连以后拿到的和当时一样。
 */

import type pg from 'pg';
import type { CreativeEvent } from '@reinlab/contracts';

export type CreativeEventDraft = { type: string; data: unknown };

export async function appendEvents(
  client: pg.PoolClient,
  input: { account: string; dossier: string },
  drafts: CreativeEventDraft[],
): Promise<number> {
  let seq = 0;
  for (const draft of drafts) {
    const result = await client.query<{ seq: string }>(
      `insert into creative_event(account_id,dossier_id,type,data) values($1,$2,$3,$4::jsonb) returning seq::text seq`,
      [input.account, input.dossier, draft.type, JSON.stringify(draft.data ?? null)],
    );
    seq = Number(result.rows[0]?.seq ?? seq);
  }
  return seq;
}

export async function readEvents(
  client: pg.PoolClient,
  input: { account: string; dossier: string; after: number; limit?: number },
): Promise<CreativeEvent[]> {
  const result = await client.query<{ seq: string; at: Date; type: string; data: unknown; dossier_id: string }>(
    `select seq::text seq, at, type, data, dossier_id from creative_event
      where account_id=$1 and dossier_id=$2 and seq>$3 order by seq limit $4`,
    [input.account, input.dossier, input.after, input.limit ?? 200],
  );
  return result.rows.map((row) => ({
    seq: Number(row.seq),
    at: row.at.toISOString(),
    dossierId: row.dossier_id,
    type: row.type,
    data: row.data,
  }));
}

export async function cursorOf(
  client: pg.PoolClient,
  input: { account: string; dossier: string },
): Promise<number> {
  const result = await client.query<{ seq: string | null }>(
    'select max(seq)::text seq from creative_event where account_id=$1 and dossier_id=$2',
    [input.account, input.dossier],
  );
  return Number(result.rows[0]?.seq ?? 0);
}
