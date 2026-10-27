import type pg from "pg";
import { z } from "zod";
import { ApiFailure } from "../api/errors";
const Binding = z
  .object({
    approvalId: z.string().uuid(),
    capability: z.string(),
    requestId: z.string(),
    argsHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const deny = () =>
  new ApiFailure("MCP_APPROVAL_INVALID", 403, "内核批准与能力调用不一致。");
export function pendingMcpApproval(pending: unknown) {
  if (!pending || typeof pending !== "object") return null;
  const p = pending as Record<string, unknown>;
  if (p.permission !== "reinlab_mcp_approval") return null;
  const m = p.metadata as Record<string, unknown> | null;
  const parsed = Binding.safeParse(m?.reinlabMcp);
  if (!parsed.success) throw deny();
  return parsed.data;
}
/** 账本里已经作出决定、且尚未被消费的 MCP 审批：原生权限请求可以按它自动答复。 */
export function mcpAutoReply(
  row: { decision?: string | null; consumed?: boolean } | undefined,
): "once" | "reject" | null {
  if (!row || row.consumed) return null;
  if (row.decision === "approve") return "once";
  if (row.decision === "reject") return "reject";
  return null;
}
/** Called in the same user-decision transaction; session grants cannot approve MCP effects. */
export async function bridgeMcpDecision(
  client: pg.PoolClient,
  account: string,
  run: string,
  effects: unknown,
  decision: "approve" | "reject",
  scope: "once" | "session",
) {
  const records = Array.isArray(effects) ? effects : [];
  for (const effect of records) {
    const binding = pendingMcpApproval(effect?.properties ?? effect);
    if (!binding) continue;
    if (scope !== "once") throw deny();
    const row = (
      await client.query(
        "select * from mcp_approval where id=$1 and account_id=$2 and run_id=$3 for update",
        [binding.approvalId, account, run],
      )
    ).rows[0];
    if (
      !row ||
      row.capability !== binding.capability ||
      row.request_id !== binding.requestId ||
      row.args_hash !== binding.argsHash ||
      row.consumed ||
      (row.decision && row.decision !== decision)
    )
      throw deny();
    await client.query("update mcp_approval set decision=$2 where id=$1", [
      row.id,
      decision,
    ]);
    await client.query(
      "update approval set state=$2,decided_scope='once',decided_at=now() where id=$1",
      [row.id, decision === "approve" ? "approved" : "rejected"],
    );
  }
}
