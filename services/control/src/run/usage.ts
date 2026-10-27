import type pg from "pg";
import { ApiFailure } from "../api/errors";

export type UsageRecord = {
  account: string;
  dossier: string;
  run: string;
  provider: string;
  model: string;
  known: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens?: number | null;
  costCny?: string | null;
};

/**
 * The single authoritative usage write. A provider request writes one row;
 * nothing else (kernel events included) writes the same request's usage.
 * Unknown usage is stored as null counts and null cost, never as zero.
 */
export async function recordUsage(
  client: pg.PoolClient,
  usage: UsageRecord,
): Promise<{ id: string; known: boolean }> {
  if (usage.known) {
    if (
      !Number.isSafeInteger(usage.inputTokens) ||
      !Number.isSafeInteger(usage.outputTokens)
    )
      throw new ApiFailure(
        "USAGE_INCOMPLETE",
        400,
        "已知用量必须带输入与输出 token。",
      );
  }
  const result = await client.query(
    `insert into usage_record(id,account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_cny)
     values(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning id,known`,
    [
      usage.account,
      usage.dossier,
      usage.run,
      usage.provider,
      usage.model,
      usage.known,
      usage.known ? usage.inputTokens : null,
      usage.known ? usage.outputTokens : null,
      usage.known ? (usage.cacheReadTokens ?? null) : null,
      usage.known ? (usage.cacheWriteTokens ?? null) : null,
      usage.known ? (usage.reasoningTokens ?? null) : null,
      usage.known ? (usage.costCny ?? null) : null,
    ],
  );
  return { id: result.rows[0].id, known: result.rows[0].known };
}

export type RunUsageState = {
  known: boolean;
  requests: number;
  unknownRequests: number;
  /** Known spend only; null when no row carries a cost. Never a pretends-zero total. */
  knownCny: string | null;
};

/**
 * Cost view for one run. It deliberately has no gate: a request with unknown
 * usage reports `known:false` and nothing here blocks the run from finishing.
 */
export async function runUsage(
  client: pg.PoolClient,
  runId: string,
): Promise<RunUsageState> {
  const result = await client.query(
    `select count(*)::int requests,
       count(*) filter (where not known)::int unknown_requests,
       (count(*) filter (where known))::int known_requests,
       sum(cost_cny)::text known_cny
     from usage_record where run_id=$1`,
    [runId],
  );
  const row = result.rows[0];
  const requests = Number(row.requests);
  const unknown = Number(row.unknown_requests);
  return {
    known: requests > 0 && unknown === 0 && row.known_cny !== null,
    requests,
    unknownRequests: unknown,
    knownCny: row.known_cny ?? null,
  };
}
