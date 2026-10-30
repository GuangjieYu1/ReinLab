/**
 * 每份计划的模型与工具用量（06 §10、07 契约第 1、2、8 节）。
 *
 * 只读 usage_record（唯一写入入口），按用途、按模型、按次调用分开列。
 * 未知的用量照实计为未知次数，绝不记 0；费用拿不到就是 null。
 */
import type pg from "pg";
import type { PlanUsage } from "@reinlab/contracts";

type Client = pg.PoolClient;

const PURPOSES = ["planning", "vision", "weather_judge", "weather_adjust"] as const;

const sumOrNull = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};

export async function planUsage(client: Client, account: string, dossier: string): Promise<PlanUsage> {
  const rows = (
    await client.query(
      `select purpose, model, known, input_tokens, output_tokens, cache_read_tokens, cost_cny
         from usage_record where account_id=$1 and dossier_id=$2 order by recorded_at limit 5000`,
      [account, dossier],
    )
  ).rows;

  // Search / Fetch 这类按次的调用单独列，不混进模型 token。
  const tools = rows.filter((row) => String(row.model ?? "").startsWith("tools-"));
  const models = rows.filter((row) => !String(row.model ?? "").startsWith("tools-"));

  const byPurpose = PURPOSES.map((purpose) => {
    const group = models.filter(
      (row) => (PURPOSES.includes(row.purpose) ? row.purpose : "planning") === purpose,
    );
    return {
      purpose,
      calls: group.length,
      input: sumOrNull(group.map((row) => (typeof row.input_tokens === "number" ? row.input_tokens : null))),
      output: sumOrNull(group.map((row) => (typeof row.output_tokens === "number" ? row.output_tokens : null))),
      cache: sumOrNull(group.map((row) => (typeof row.cache_read_tokens === "number" ? row.cache_read_tokens : null))),
    };
  }).filter((entry) => entry.calls > 0);

  const modelNames = [...new Set(models.map((row) => String(row.model)))];
  const byModel = modelNames.map((model) => {
    const group = models.filter((row) => String(row.model) === model);
    return {
      model,
      input: sumOrNull(group.map((row) => (typeof row.input_tokens === "number" ? row.input_tokens : null))),
      output: sumOrNull(group.map((row) => (typeof row.output_tokens === "number" ? row.output_tokens : null))),
    };
  });

  const toolNames = [...new Set(tools.map((row) => String(row.model).replace(/^tools-/, "")))];
  const toolRows = toolNames.map((name) => {
    const group = tools.filter((row) => String(row.model) === "tools-" + name);
    const costs = group.map((row) =>
      row.cost_cny === null || row.cost_cny === undefined ? null : Number(row.cost_cny),
    );
    return {
      name,
      calls: group.length,
      costCny: sumOrNull(costs),
    };
  });

  return {
    byPurpose,
    byModel,
    tools: toolRows,
    unknownCalls: models.filter((row) => row.known === false).length,
  };
}
