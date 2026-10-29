import type pg from "pg";
import { z } from "zod";
import { MonthlyBudget } from "@reinlab/contracts";
import { denied } from "../api/errors";
import { micros, decimal, cny } from "./money";

/** 预算周期（自然月第一天），账本与 /v1/me 都用它。 */
export const currentPeriod = () =>
  new Date(Date.now()).toISOString().slice(0, 7) + "-01";

/** 本月预算快照：上限、已分配、已花与占用的额度。 */
export async function monthlyBudgetSnapshot(client: pg.PoolClient) {
  const period = currentPeriod(),
    result = await client.query(
      `select monthly_budget_cny::text cap,
    (select coalesce(sum(amount_cny),0)::text from budget_allocation where parent_id is null and period=$1) allocated,
    (select coalesce(sum(spent_cny),0)::text from budget_allocation where parent_id is null and period=$1) spent,
    (select coalesce(sum(greatest(amount_cny,spent_cny)),0)::text from budget_allocation where parent_id is null and period=$1) occupied,
    (select count(*)::int from budget_hold where state='unpriced' and period=$1) unknown,
    (select coalesce(sum(actual_quota),0)::text from budget_hold where period=$1) quota,
    (select coalesce(sum(actual_gpu_seconds),0)::text from budget_hold where period=$1) gpu
    from account where id=nullif(current_setting('app.account_id',true),'')::uuid`,
      [period],
    );
  if (!result.rowCount) throw denied();
  const row = result.rows[0],
    available = micros(row.cap) - micros(row.occupied);
  return MonthlyBudget.parse({
    period,
    monthlyLimitCny: cny(row.cap),
    allocatedCny: cny(row.allocated),
    spentKnownCny: cny(row.spent),
    availableCny: decimal(available > 0n ? available : 0n),
    unpricedCount: row.unknown,
    quotaRuns: Number(row.quota),
    gpuSeconds: Number(row.gpu),
  });
}

/** One account lock per transaction: ledger writes for this account serialize. */
export async function lockBudget(client: pg.PoolClient, accountId: string) {
  const context = await client.query(
    "select current_setting('app.account_id',true) id",
  );
  if (context.rows[0].id !== accountId) throw denied();
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    "ledger:" + accountId,
  ]);
}
