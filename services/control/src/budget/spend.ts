/**
 * 花钱记到账上（design/prd/09-explore-v2.md §9、07 契约「预算」）。
 *
 * 用量表只是流水，能用的额度看 budget_allocation：本月上限减掉「已占用」。
 * 这里把每一笔已知金额累加到这份档案本月的根额度上（amount 保持 0，只加 spent），
 * monthlyBudgetSnapshot 里的 available 就会真的变小——不靠人去翻用量表盯。
 * 金额未知的调用不记 0，也不假装没花：它们只留在用量表里标未知。
 */
import type pg from "pg";
import { currentPeriod } from "./index";

type Client = pg.PoolClient;

export const recordSpend = async (
  client: Client,
  input: { account: string; dossier: string; costCny: number | string | null },
): Promise<number> => {
  const value = Number(input.costCny);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const amount = Number(value.toFixed(6));
  await client.query(
    `insert into budget_allocation(account_id,dossier_id,parent_id,run_id,delegation_id,period,amount_cny,spent_cny)
     values($1,$2,null,null,null,$3,0,$4)
     on conflict (account_id,dossier_id,period) where parent_id is null
     do update set spent_cny = budget_allocation.spent_cny + excluded.spent_cny`,
    [input.account, input.dossier, currentPeriod(), amount],
  );
  return amount;
};

/** 单价（每百万 token 人民币）→ 这一笔的金额；没有单价或 token 未知就给 null。 */
export function costOf(
  pricing: { inputPerMillion: number; outputPerMillion: number } | null | undefined,
  inputTokens: number | null,
  outputTokens: number | null,
): string | null {
  if (!pricing) return null;
  if (!Number.isFinite(pricing.inputPerMillion) || !Number.isFinite(pricing.outputPerMillion)) return null;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null;
  return (
    ((inputTokens as number) * pricing.inputPerMillion + (outputTokens as number) * pricing.outputPerMillion) /
    1_000_000
  ).toFixed(6);
}

/** 发请求之前先估一次（按峰值费率、输入按字符数保守折算），拿它去比可用额度。 */
export function estimateRequestCost(
  pricing: { inputPerMillion: number; outputPerMillion: number } | null | undefined,
  body: string,
  maxTokens: number,
): number | null {
  if (!pricing) return null;
  if (!Number.isFinite(pricing.inputPerMillion) || !Number.isFinite(pricing.outputPerMillion)) return null;
  const inputTokens = Math.ceil(body.length / 3) + 1500;
  const outputTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096;
  return (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000;
}
