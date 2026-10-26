import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Hono } from "hono";
import type { JsonValue } from "@reinlab/contracts";
import type { Database } from "../db/database";
import type { CapabilityEngine } from "../mcp/engine";
import { pendingMcpApproval } from "../mcp/approval-bridge";
import { appendEvent, scrub } from "../ledger";
import { lockBudget } from "../budget";
import { transitionGate } from "../gates";
import { mutate, canonical, type ApiEnv, type ApiContext } from "./context";
import { ApiFailure, denied } from "./errors";
const Decision = z
  .object({
    decision: z.enum(["approve", "reject"]),
    scope: z.literal("once").default("once"),
  })
  .strict();
const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
const conflict = () =>
  new ApiFailure(
    "APPROVAL_CONFLICT",
    409,
    "审批已处理、过期或请求对象已变化，请刷新。",
  );
function publicValue(v: any): JsonValue {
  if (Array.isArray(v)) return v.map(publicValue);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            ![
              "sessionID",
              "sessionId",
              "requestID",
              "requestId",
              "runID",
              "os_session_id",
              "os_request_id",
              "reinlabMcp",
            ].includes(k),
        )
        .map(([k, x]) => [k, publicValue(x)]),
    );
  return v;
}
export function registerApprovalInbox(app: Hono<ApiEnv>, db: Database) {
  app.get("/v1/approvals", (c) =>
    db.withAccount(c.get("accountId"), async (client) => {
      const state = z
        .enum(["pending", "indeterminate"])
        .safeParse(c.req.query("state") ?? "pending");
      if (!state.success)
        throw new ApiFailure("INVALID_INPUT", 400, "待处理决定状态无效。");
      const rows = (
        await client.query(
          `select a.*,r.dossier_id,r.role_id,r.state run_state,r.ended_at,d.bench,d.title dossier_title, ma.id mcp_id from approval a join run r on r.account_id=a.account_id and r.id=a.run_id join dossier d on d.account_id=r.account_id and d.id=r.dossier_id left join os_binding b on b.account_id=a.account_id and b.run_id=a.run_id and b.session_id=a.os_session_id left join mcp_approval ma on ma.account_id=a.account_id and ma.id=a.id where a.account_id=$1 and a.state=$2 and not(r.role_id='research-clarify' and a.kind='question') and ((a.os_request_id is not null and b.phase='accepted' and b.receipt is not null and a.kind in ('permission','question')) or (a.os_request_id is null and r.state in ('running','waiting') and r.ended_at is null and (ma.id is not null or a.effects->>'operation' in ('approval.request','gate.request_open')))) order by a.id limit 200`,
          [c.get("accountId"), state.data],
        )
      ).rows;
      const wrapped = new Set<string>();
      for (const row of rows.filter((r) => r.os_request_id))
        for (const e of Array.isArray(row.effects) ? row.effects : []) {
          const binding = pendingMcpApproval(e?.properties ?? e);
          if (binding) wrapped.add(binding.approvalId);
        }
      return c.json({
        items: rows
          .filter((r) => !wrapped.has(r.id))
          .map((r) => ({
            id: r.id,
            runId: r.run_id,
            kind: r.kind,
            title: scrub(String(r.title).slice(0, 300)),
            effects: scrub(publicValue(r.effects)),
            risk: r.risk,
            state: r.state,
            sent: r.decision_sent ?? false,
            source: {
              bench: r.bench,
              dossierId: r.dossier_id,
              dossierTitle: scrub(r.dossier_title),
              runId: r.run_id,
              roleId: r.role_id,
            },
          })),
      });
    }),
  );
}
/** Returns null only for an existing native approval; native prepare/dispatch stays unchanged. */
export async function decideInboxCard(
  c: ApiContext,
  db: Database,
  mcp?: CapabilityEngine,
): Promise<Response | null> {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) throw denied();
  const account = c.get("accountId"),
    native = await db.withAccount(
      account,
      async (client) =>
        (
          await client.query("select os_request_id from approval where id=$1", [
            id.data,
          ])
        ).rows[0],
    );
  if (!native) throw denied();
  if (native.os_request_id) return null;
  return mutate(c, db, Decision, async (client, input) => {
    await lockBudget(client, account);
    const row = (
      await client.query(
        "select a.*,r.dossier_id,r.role_id,r.state run_state,r.ended_at from approval a join run r on r.account_id=a.account_id and r.id=a.run_id where a.id=$1 for update of a",
        [id.data],
      )
    ).rows[0];
    if (!row) throw denied();
    const hash = createHash("sha256").update(canonical(input)).digest("hex"),
      old = (
        await client.query(
          "select request_hash,receipt from card_decision where approval_id=$1",
          [id.data],
        )
      ).rows[0];
    if (old) {
      if (old.request_hash !== hash) throw conflict();
      return { status: 200, body: old.receipt };
    }
    if (
      row.state !== "pending" ||
      !["running", "waiting"].includes(row.run_state) ||
      row.ended_at
    )
      throw conflict();
    const cap = (
      await client.query("select id from mcp_approval where id=$1", [id.data])
    ).rows[0];
    let receipt: Record<string, JsonValue>;
    if (cap) {
      if (!mcp)
        throw new ApiFailure("MCP_UNAVAILABLE", 503, "能力层暂不可用。");
      receipt = await mcp.decideClient(
        client,
        account,
        id.data,
        input.decision,
      );
    } else {
      const effects = row.effects;
      if (
        !["approval.request", "gate.request_open"].includes(effects?.operation)
      )
        throw conflict();
      if (
        input.decision === "approve" &&
        effects.operation === "gate.request_open"
      ) {
        const snapshot = z
          .object({
            gateId: z.string().uuid(),
            state: z.literal("review"),
            revision: z.number().int().nonnegative(),
            artifactId: z.string().uuid(),
          })
          .strict()
          .safeParse(effects.gateSnapshot);
        if (!snapshot.success) throw conflict();
        const gate = (
          await client.query(
            "select dossier_id,review_artifact_id from gate where id=$1",
            [snapshot.data.gateId],
          )
        ).rows[0];
        if (
          !gate ||
          gate.dossier_id !== row.dossier_id ||
          gate.review_artifact_id !== snapshot.data.artifactId
        )
          throw conflict();
        await transitionGate(client, account, {
          gateId: snapshot.data.gateId,
          expectedState: "review",
          expectedRevision: snapshot.data.revision,
          targetState: "approved",
          actor: "user",
          operationId: randomUUID(),
        });
      }
      await client.query(
        "update approval set state=$2,decided_scope='once',decided_at=now() where id=$1",
        [row.id, input.decision === "approve" ? "approved" : "rejected"],
      );
      receipt = { approvalId: row.id, decision: input.decision, scope: "once" };
      await appendEvent(client, account, {
        dossierId: row.dossier_id,
        runId: row.run_id,
        roleId: row.role_id,
        kind: "approval",
        action: "approval.decided",
        risk: "write",
        payload: receipt,
        dedupeKey: "inbox-approval-decided:" + row.id,
      });
    }
    await client.query(
      "insert into card_decision(account_id,approval_id,request_hash,receipt)values($1,$2,$3,$4)",
      [account, row.id, hash, json(receipt)],
    );
    return { status: 200, body: receipt };
  });
}
