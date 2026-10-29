import { createHash } from "node:crypto";
import { z } from "zod";
import type { Hono } from "hono";
import type { JsonValue } from "@reinlab/contracts";
import type { Database } from "../db/database";
import { reconcileAccount } from "../kernel/lifecycle";
import { appendEvent, scrub } from "../ledger";
import { mutate, canonical, type ApiEnv, type ApiContext } from "./context";
import { ApiFailure, denied } from "./errors";

const Decision = z
  .object({
    decision: z.enum(["approve", "reject"]),
    scope: z.literal("once").default("once"),
  })
  .strict();
const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
const capabilityLabel: Record<string, string> = {
  "papers.search": "检索论文",
  "papers.fetch": "下载论文全文",
  "papers.pages": "按页读取原文",
  "cards.card.layer": "写入分层讲解",
  "cards.card.quiz": "写入检查题",
  "cards.card.finding": "记录发现",
};
const conflict = () =>
  new ApiFailure(
    "APPROVAL_CONFLICT",
    409,
    "审批已处理、过期或请求对象已变化，请刷新。",
  );
/** 卡片里只有给人看的短句；参数哈希留在账本里，不回给界面。 */
function describe(effects: any) {
  const capability =
    typeof effects?.capability === "string" ? effects.capability : "";
  if (!capability) return [];
  return [
    "操作：" + (capabilityLabel[capability] ?? capability) + "（" + capability + "）",
    "只处理这一次请求；参数变化后需要重新批准。",
  ];
}
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

/**
 * Reading approvals: the only cards left are kernel ones (`effect_key` set) and
 * in-conversation questions. Deciding one records the user's one-shot consent;
 * the consuming worker call is what actually reads the approval back.
 */
export function registerApprovalInbox(
  app: Hono<ApiEnv>,
  db: Database,
  isLive?: (runId: string) => boolean,
) {
  app.get("/v1/approvals", async (c) => {
    // 有人来看待办时先核对一次：超时没处理的请求、没有执行者的残留都在这收尾，
    // 不靠人工 SQL，也不让一个任务永远停在执行中。
    await reconcileAccount(db, c.get("accountId"), { isLive }).catch(() => {});
    return db.withAccount(c.get("accountId"), async (client) => {
      const state = z
        .enum(["pending", "indeterminate", "approved", "rejected", "expired"])
        .safeParse(c.req.query("state") ?? "pending");
      if (!state.success)
        throw new ApiFailure("INVALID_INPUT", 400, "待处理决定状态无效。");
      const rows = (
        await client.query(
          `select a.id,a.run_id "runId",a.kind,a.title,a.effects,a.risk,a.state,
                  a.decision_sent "sent",r.dossier_id "dossierId",d.title "dossierTitle",
                  r.role_id "roleId",r.state "runState"
             from approval a
             join run r on r.account_id=a.account_id and r.id=a.run_id
             join dossier d on d.account_id=r.account_id and d.id=r.dossier_id
            where a.account_id=$1 and a.state=$2 and a.effect_key is not null
            order by a.id limit 200`,
          [c.get("accountId"), state.data],
        )
      ).rows;
      return c.json({
        items: rows.map((row) => ({
          id: row.id,
          runId: row.runId,
          kind: row.kind,
          title: scrub(String(row.title).slice(0, 300)),
          effects: scrub(describe(row.effects) as JsonValue),
          risk: row.risk,
          state: row.state,
          sent: row.sent ?? false,
          source: {
            dossierId: row.dossierId,
            dossierTitle: scrub(row.dossierTitle),
            runId: row.runId,
            roleId: row.roleId,
          },
        })),
      });
    });
  });
}

/** Called by the runtime route for `/v1/approvals/:id/decide`. */
export async function decideInboxCard(
  c: ApiContext,
  db: Database,
  resume?: (account: string, runId: string, prompt: string) => void,
): Promise<Response | null> {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) throw denied();
  const account = c.get("accountId");
  return mutate(c, db, Decision, async (client, input) => {
    const row = (
      await client.query(
        `select a.*,r.dossier_id,r.role_id,r.state run_state,r.ended_at
           from approval a join run r on r.account_id=a.account_id and r.id=a.run_id
          where a.id=$1 and a.effect_key is not null for update of a`,
        [id.data],
      )
    ).rows[0];
    if (!row) throw denied();
    // 一次决定落在同一个请求上：同参数重复提交返回同一回执，不同参数报冲突。
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
    const receipt = {
      approvalId: row.id,
      decision: input.decision,
      scope: "once",
    } as unknown as Record<string, JsonValue>;
    await client.query(
      `update approval
          set state=$2, decided_scope='once', decided_at=now(), decision_sent=true,
              decision_hash=$3, decision_input=$4
        where id=$1`,
      [
        row.id,
        input.decision === "approve" ? "approved" : "rejected",
        hash,
        json(input),
      ],
    );
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
    await client.query(
      "insert into card_decision(account_id,approval_id,request_hash,receipt)values($1,$2,$3,$4)",
      [account, row.id, hash, json(receipt)],
    );
    // 等待期间执行段已经让出：落定之后按同一会话续上，把这次决定作为输入
    // 送回原任务。是否续得上由运行服务自己判断，接口不因此失败。
    if (row.run_state === "waiting")
      resume?.(
        account,
        row.run_id,
        input.decision === "approve"
          ? `用户已批准这次请求（审批 ${row.id}）。继续原来的任务；如果还要执行同一个动作，直接再来一次即可，不要重复请求批准。`
          : `用户驳回/拒绝了这次请求（审批 ${row.id}）。不要重复请求同一个批准；照实说明并收尾，已完成的成果保留。`,
      );
    return { status: 200, body: receipt };
  });
}
