import { prepareHumanPaperChoice } from "../../clarify/candidates";
import {
  bridgeMcpDecision,
  pendingMcpApproval,
} from "../../mcp/approval-bridge";
import type pg from "pg";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Database } from "../../db/database";
import { ApiFailure, denied } from "../../api/errors";
import { canonical } from "../../api/context";
import { lockBudget } from "../../budget";
import { appendEvent, scrub } from "../../ledger";
import { bindingRow, type Binding } from "./binding-store";
import type { RoleRuntime } from "./role-runtime";

export type DecisionRuntimePort = Pick<
  RoleRuntime,
  "snapshot" | "decide" | "cancel"
>;
export interface DecisionRuntimeAccess {
  runtime(accountId: string, runId: string): Promise<DecisionRuntimePort>;
}
export interface DecisionReceipt {
  approvalId: string;
  status: "prepared" | "resolved" | "indeterminate" | "expired";
  decision: "approve" | "reject";
  scope: "once" | "session";
  code?: string;
}
export interface CancelReceipt {
  status: "resolved" | "indeterminate";
  state?: string;
}
const uuid = z.string().uuid();
const text = z
  .string()
  .max(4000)
  .refine((value) => value.trim().length > 0);
const Input = z
  .object({
    decision: z.enum(["approve", "reject"]),
    scope: z.enum(["once", "session"]).default("once"),
    answers: z.array(z.array(text).min(1).max(64)).min(1).max(64).optional(),
  })
  .strict();
type Intent = z.output<typeof Input>;
const Question = z.object({
  questions: z
    .array(
      z.object({
        options: z
          .array(z.object({ label: text }))
          .min(1)
          .max(64),
        multiple: z.boolean().optional(),
        custom: z.boolean().optional(),
      })
    )
    .min(1)
    .max(64),
});
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const invalid = () => new ApiFailure("INVALID_INPUT", 400, "决定参数无效。");
const unavailable = () =>
  new ApiFailure(
    "OS_UNAVAILABLE",
    503,
    "执行内核暂时不可用，请核对已保存的决定收据。"
  );
const hash = (input: Intent) =>
  createHash("sha256").update(canonical(input)).digest("hex");
function normalize(raw: unknown, kind: string): Intent {
  const parsed = Input.safeParse(raw);
  if (!parsed.success) throw invalid();
  const input = parsed.data;
  if (
    (kind === "permission" && input.answers !== undefined) ||
    (kind === "question" && input.scope !== "once") ||
    (input.decision === "reject" &&
      (input.answers !== undefined || input.scope !== "once")) ||
    (kind === "question" &&
      input.decision === "approve" &&
      input.answers === undefined)
  )
    throw invalid();
  return input;
}
function savedIntent(row: Record<string, any>): Intent {
  try {
    const input = normalize(row.decision_input, row.kind);
    if (!row.decision_hash || hash(input) !== row.decision_hash)
      throw new Error("invalid intent");
    return input;
  } catch {
    throw new ApiFailure("DECISION_CORRUPT", 503, "决定意图校验失败。");
  }
}
function questionsValid(raw: unknown, answers: string[][]) {
  const request = Question.safeParse(raw);
  const bad = () =>
    new ApiFailure("INVALID_ANSWER", 400, "答案不符合当前问题的选项要求。");
  if (!request.success || request.data.questions.length !== answers.length)
    throw bad();
  request.data.questions.forEach((question, index) => {
    const selected = answers[index];
    if (
      new Set(selected).size !== selected.length ||
      (!question.multiple && selected.length !== 1) ||
      (question.custom === false &&
        selected.some(
          (answer) =>
            !question.options.some((option) => option.label === answer)
        ))
    )
      throw bad();
  });
}
function verifySnapshot(
  binding: Binding,
  snapshot: Awaited<ReturnType<DecisionRuntimePort["snapshot"]>>
) {
  if (
    !snapshot ||
    snapshot.sessionID !== binding.sessionId ||
    !Array.isArray(snapshot.runs) ||
    !Array.isArray(snapshot.permissions) ||
    !Array.isArray(snapshot.questions)
  )
    throw denied();
  const run = snapshot.runs.find(
    (item) => item.runID === binding.receipt?.runID
  );
  if (
    run &&
    (run.sessionID !== binding.sessionId || run.requestID !== binding.requestId)
  )
    throw new ApiFailure("SCOPE_DENIED", 403, "快照与已登记的运行身份不符。");
  return run;
}
/** Explicit user-intent delivery. Runtime mutations always happen outside DB transactions. */
export class DecisionService {
  constructor(
    private readonly db: Database,
    private readonly access: DecisionRuntimeAccess
  ) {}
  private async load(
    client: pg.PoolClient,
    accountId: string,
    approvalId: string
  ) {
    if (!uuid.safeParse(approvalId).success) throw denied();
    await lockBudget(client, accountId);
    const row = (
      await client.query("select * from approval where id=$1 for update", [
        approvalId,
      ])
    ).rows[0];
    if (
      !row ||
      row.account_id !== accountId ||
      !["permission", "question"].includes(row.kind)
    )
      throw denied();
    const binding = await bindingRow(client, row.run_id, true);
    if (
      binding.accountId !== accountId ||
      binding.sessionId !== row.os_session_id ||
      !row.os_request_id ||
      binding.phase !== "accepted" ||
      !binding.receipt
    )
      throw denied();
    return { row, binding };
  }
  async listPending(accountId: string) {
    return this.db.withAccount(accountId, async (client) => {
      const rows = await client.query(
        `select a.id,a.run_id,a.kind,a.title,a.effects,a.risk,a.state,a.decision_sent from approval a
        join os_binding b on b.run_id=a.run_id and b.account_id=a.account_id and b.session_id=a.os_session_id
        where a.account_id=$1 and a.kind in ('permission','question') and a.state in ('pending','indeterminate') and a.os_request_id is not null and b.phase='accepted' and b.receipt is not null order by a.id limit 200`,
        [accountId]
      );
      return rows.rows.map((row) => ({
        id: row.id,
        runId: row.run_id,
        kind: row.kind,
        title: scrub(row.title.slice(0, 300)),
        effects: scrub(row.effects),
        risk: row.risk,
        state: row.state,
        sent: row.decision_sent,
      }));
    });
  }
  private validatePending(
    binding: Binding,
    row: Record<string, any>,
    input: Intent,
    pending: unknown
  ) {
    if (row.kind === "question" && input.decision === "approve")
      questionsValid(pending, input.answers!);
    if (row.kind === "permission" && input.decision === "approve") {
      const permission =
        pending &&
        typeof pending === "object" &&
        "permission" in pending &&
        typeof pending.permission === "string"
          ? pending.permission
          : "";
      if (permission === "reinlab_mcp_approval") {
        const requested = pendingMcpApproval(pending);
        const effects = Array.isArray(row.effects) ? row.effects : [];
        const recorded = effects
          .map((e) => pendingMcpApproval(e?.properties ?? e))
          .find(Boolean);
        const grant = binding.role.mcp?.grants.find(
          (g) => g.name === requested?.capability
        );
        if (
          !requested ||
          !recorded ||
          canonical(requested) !== canonical(recorded) ||
          input.scope !== "once" ||
          !grant ||
          (grant.permission !== "ask" && grant.risk !== "danger")
        )
          throw new ApiFailure(
            "MCP_APPROVAL_INVALID",
            403,
            "内核批准与冻结的能力请求不一致。"
          );
        return;
      }
      const grant = Object.hasOwn(binding.role.role.toolGrants, permission)
        ? binding.role.role.toolGrants[permission]
        : undefined;
      if (!grant || grant.risk === "danger" || grant.permission === "deny")
        throw new ApiFailure(
          "SCOPE_DENIED",
          403,
          "该权限不在本角色可批准的范围。"
        );
    }
  }
  /** Preflight before the API commits a new immutable intent. This method never writes intent. */
  async validate(
    accountId: string,
    approvalId: string,
    raw: unknown
  ): Promise<void> {
    const { row, binding } = await this.db.withAccount(accountId, (client) =>
        this.load(client, accountId, approvalId)
      ),
      input = normalize(raw, row.kind);
    if (row.decision_hash) {
      savedIntent(row);
      if (hash(input) !== row.decision_hash)
        throw new ApiFailure(
          "IDEMPOTENCY_CONFLICT",
          409,
          "此决定已经保存了不同的用户意图。"
        );
      return; // A repeated immutable intent must retain its original delivery receipt.
    }
    if (row.state !== "pending")
      throw new ApiFailure("DECISION_EXPIRED", 409, "该请求已不再等待决定。");
    const runtime = await this.runtime(accountId, row.run_id),
      snapshot = await this.snapshot(runtime, binding.sessionId),
      run = verifySnapshot(binding, snapshot);
    const pending = (
      row.kind === "permission" ? snapshot.permissions : snapshot.questions
    ).find(
      (item) =>
        item.id === row.os_request_id && item.sessionID === binding.sessionId
    );
    if (!run || terminal.has(run.state) || !pending)
      throw new ApiFailure("DECISION_EXPIRED", 409, "该请求已不再等待决定。");
    this.validatePending(binding, row, input, pending);
    if (pendingMcpApproval(pending) && input.scope !== "once") throw invalid();
  }
  async prepare(
    client: pg.PoolClient,
    accountId: string,
    approvalId: string,
    raw: unknown
  ): Promise<DecisionReceipt> {
    const { row } = await this.load(client, accountId, approvalId),
      input = normalize(raw, row.kind),
      digest = hash(input);
    if (row.decision_hash) {
      savedIntent(row);
      if (!row.decision_receipt)
        throw new ApiFailure("DECISION_CORRUPT", 503, "决定收据校验失败。");
      if (row.decision_hash !== digest)
        throw new ApiFailure(
          "IDEMPOTENCY_CONFLICT",
          409,
          "此决定已经保存了不同的用户意图。"
        );
      return row.decision_receipt;
    }
    if (row.state !== "pending")
      throw new ApiFailure("DECISION_EXPIRED", 409, "该请求已不再等待决定。");
    await bridgeMcpDecision(
      client,
      accountId,
      row.run_id,
      row.effects,
      input.decision,
      input.scope
    );
    await prepareHumanPaperChoice(client, accountId, row, input);
    const receipt: DecisionReceipt = {
      approvalId,
      status: "prepared",
      decision: input.decision,
      scope: input.scope,
    };
    await client.query(
      "update approval set decision_hash=$2,decision_input=$3::jsonb,decision_receipt=$4::jsonb where id=$1",
      [approvalId, digest, JSON.stringify(input), JSON.stringify(receipt)]
    );
    return receipt;
  }
  /** 控制面替内核答复一次原生权限请求（只用于账本里已经批准/拒绝过的 MCP 能力调用）。 */
  async autoReplyPermission(
    accountId: string,
    runId: string,
    sessionID: string,
    requestID: string,
    reply: "once" | "reject"
  ) {
    if (!uuid.safeParse(accountId).success || !uuid.safeParse(runId).success)
      throw invalid();
    const runtime = await this.runtime(accountId, runId);
    const result = await runtime.decide({
      kind: "permission",
      sessionID,
      requestID,
      reply,
    });
    return {
      replied: result?.status === "resolved" && result.requestID === requestID,
    };
  }
  private async runtime(accountId: string, runId: string) {
    try {
      return await this.access.runtime(accountId, runId);
    } catch {
      throw unavailable();
    }
  }
  private async snapshot(runtime: DecisionRuntimePort, sessionId: string) {
    try {
      return await runtime.snapshot(sessionId);
    } catch {
      throw unavailable();
    }
  }
  private async finish(
    accountId: string,
    approvalId: string,
    status: "resolved" | "indeterminate" | "expired"
  ): Promise<DecisionReceipt> {
    return this.db.withAccount(accountId, async (client) => {
      const { row } = await this.load(client, accountId, approvalId),
        input = savedIntent(row);
      if (row.decision_receipt?.status === "resolved")
        return row.decision_receipt;
      if (row.state === "expired" && status !== "resolved") status = "expired";
      if (row.decision_receipt?.status === "expired" && status !== "resolved")
        return row.decision_receipt;
      const receipt: DecisionReceipt = {
        approvalId,
        status,
        decision: input.decision,
        scope: input.scope,
        ...(status === "indeterminate" ? { code: "DECISION_UNCONFIRMED" } : {}),
      };
      await client.query(
        "update approval set state=$2,decision_receipt=$3::jsonb,decided_at=case when $2 in ('approved','rejected') then now() else decided_at end,decided_scope=$4 where id=$1",
        [
          approvalId,
          status === "resolved"
            ? input.decision === "approve"
              ? "approved"
              : "rejected"
            : status,
          JSON.stringify(receipt),
          input.scope,
        ]
      );
      if (status === "expired")
        await client.query(
          "update run set state='interrupted',ended_at=now() where id=$1 and state not in ('completed','failed','cancelled')",
          [row.run_id]
        );
      return receipt;
    });
  }
  async dispatch(
    accountId: string,
    approvalId: string
  ): Promise<DecisionReceipt> {
    const prepared = await this.db.withAccount(accountId, (client) =>
      this.load(client, accountId, approvalId)
    );
    const { row, binding } = prepared;
    if (!row.decision_hash)
      throw new ApiFailure(
        "DECISION_NOT_PREPARED",
        409,
        "请先保存明确的用户决定。"
      );
    const input = savedIntent(row);
    if (["resolved", "expired"].includes(row.decision_receipt?.status))
      return row.decision_receipt;
    const runtime = await this.runtime(accountId, row.run_id),
      snapshot = await this.snapshot(runtime, binding.sessionId),
      run = verifySnapshot(binding, snapshot);
    const pending = (
      row.kind === "permission" ? snapshot.permissions : snapshot.questions
    ).find(
      (item) =>
        item.id === row.os_request_id && item.sessionID === binding.sessionId
    );
    if (!run || terminal.has(run.state) || !pending || row.state === "expired")
      return this.finish(accountId, approvalId, "expired");
    if (row.decision_sent)
      return this.finish(accountId, approvalId, "indeterminate");
    this.validatePending(binding, row, input, pending);
    const claimed = await this.db.withAccount(accountId, async (client) => {
      const current = await this.load(client, accountId, approvalId);
      if (current.row.decision_hash !== row.decision_hash)
        throw new ApiFailure("IDEMPOTENCY_CONFLICT", 409, "决定意图已经变化。");
      if (current.row.decision_sent || current.row.state !== "pending")
        return false;
      await client.query(
        "update approval set decision_sent=true,state='indeterminate',decision_receipt=$2::jsonb where id=$1",
        [
          approvalId,
          JSON.stringify({
            approvalId,
            status: "indeterminate",
            decision: input.decision,
            scope: input.scope,
            code: "DECISION_UNCONFIRMED",
          }),
        ]
      );
      return true;
    });
    if (!claimed) {
      const current = await this.db.withAccount(accountId, (client) =>
        this.load(client, accountId, approvalId)
      );
      return this.finish(
        accountId,
        approvalId,
        current.row.state === "expired" ? "expired" : "indeterminate"
      );
    }
    let resolved = false;
    try {
      const result = await runtime.decide(
        row.kind === "permission"
          ? {
              kind: "permission",
              sessionID: binding.sessionId,
              requestID: row.os_request_id,
              reply: input.decision === "reject" ? "reject" : input.scope,
            }
          : input.decision === "reject"
          ? {
              kind: "question_reject",
              sessionID: binding.sessionId,
              requestID: row.os_request_id,
            }
          : {
              kind: "question",
              sessionID: binding.sessionId,
              requestID: row.os_request_id,
              answers: input.answers!,
            }
      );
      resolved =
        result?.status === "resolved" &&
        result.sessionID === binding.sessionId &&
        result.requestID === row.os_request_id;
    } catch {
      /* An ambiguous mutation must never be automatically resent. */
    }
    const receipt = await this.finish(
      accountId,
      approvalId,
      resolved ? "resolved" : "indeterminate"
    );
    if (resolved && input.decision === "approve") {
      // 人批准的是这条 MCP 能力审批，而内核的原生权限请求可能已经先到、还在等：
      // 按刚作出的决定替它答复一次，别让用户批第二次（run8 R4）。
      await this.autoReplyPendingNative(accountId, row).catch(() => {});
      // 选定论文后不再立刻取消这次澄清运行：模型还要把这一轮答完，run 应该正常
      // 以 completed 收尾（run8 C5）。真要掐断走「换一篇 / 取消澄清」。
    }
    return receipt;
  }
  /** 内核为同一次能力调用发的原生权限请求若还挂着，按账本决定替它答复。 */
  private async autoReplyPendingNative(
    accountId: string,
    row: Record<string, any>
  ) {
    const bound = (
      await this.db.withAccount(accountId, (client) =>
        client.query(
          "select id,os_request_id,os_session_id,effects from approval where account_id=$1 and run_id=$2 and kind='permission' and state='pending' and os_request_id is not null",
          [accountId, row.run_id]
        )
      )
    ).rows.filter((native) => {
      try {
        const binding = pendingMcpApproval(
          Array.isArray(native.effects) ? native.effects[0] : native.effects
        );
        return binding?.approvalId === row.id;
      } catch {
        return false;
      }
    });
    if (!bound.length) return;
    const reply = savedIntent(row).decision === "approve" ? "once" : "reject";
    const runtime = await this.runtime(accountId, row.run_id);
    for (const native of bound) {
      try {
        await runtime.decide({
          kind: "permission",
          sessionID: native.os_session_id,
          requestID: native.os_request_id,
          reply,
        });
      } catch {
        continue; /* 内核已经自己收尾的情况不算失败。 */
      }
      await this.db.withAccount(accountId, async (client) => {
        await client.query(
          "update approval set state=$2,decided_scope='once',decided_at=now() where id=$1 and state='pending'",
          [native.id, reply === "once" ? "approved" : "rejected"]
        );
        await appendEvent(client, accountId, {
          dossierId: row.dossier_id,
          runId: row.run_id,
          roleId: row.role_id,
          kind: "gate",
          action: "mcp_permission_auto_reply",
          payload: { approvalId: row.id, requestId: native.os_request_id, reply },
          dedupeKey: "mcp-auto-reply:" + row.run_id + ":" + native.os_request_id,
        });
      });
    }
  }
  async cancel(accountId: string, runId: string): Promise<CancelReceipt> {
    const get = async (client: pg.PoolClient) => {
      await lockBudget(client, accountId);
      const binding = await bindingRow(client, runId, true);
      if (
        binding.accountId !== accountId ||
        binding.phase !== "accepted" ||
        !binding.receipt
      )
        throw denied();
      const raw = (
        await client.query(
          "select cancel_sent,cancel_receipt from os_binding where run_id=$1",
          [runId]
        )
      ).rows[0];
      return { binding, raw };
    };
    const { binding, raw } = await this.db.withAccount(accountId, get);
    if (raw.cancel_receipt?.status === "resolved") return raw.cancel_receipt;
    const runtime = await this.runtime(accountId, runId),
      snapshot = await this.snapshot(runtime, binding.sessionId),
      run = verifySnapshot(binding, snapshot);
    const save = (receipt: CancelReceipt) =>
      this.db.withAccount(accountId, async (client) => {
        const current = await get(client);
        if (current.raw.cancel_receipt?.status === "resolved")
          return current.raw.cancel_receipt;
        await client.query(
          "update os_binding set cancel_receipt=$2::jsonb where run_id=$1",
          [runId, JSON.stringify(receipt)]
        );
        return receipt;
      });
    if (run && terminal.has(run.state))
      return save({ status: "resolved", state: run.state });
    if (raw.cancel_sent || !run) return save({ status: "indeterminate" });
    const claimed = await this.db.withAccount(accountId, async (client) => {
      const current = await get(client);
      if (
        current.raw.cancel_sent ||
        current.raw.cancel_receipt?.status === "resolved"
      )
        return false;
      await client.query(
        'update os_binding set cancel_sent=true,cancel_receipt=\'{"status":"indeterminate"}\' where run_id=$1',
        [runId]
      );
      return true;
    });
    if (!claimed) return save({ status: "indeterminate" });
    try {
      const result = await runtime.cancel(
        binding.sessionId,
        binding.receipt!.runID
      );
      if (
        result &&
        result.sessionID === binding.sessionId &&
        result.runID === binding.receipt!.runID &&
        result.requestID === binding.requestId &&
        terminal.has(result.state)
      )
        return save({ status: "resolved", state: result.state });
    } catch {
      /* The sent fence remains durable across unknown cancellation outcomes. */
    }
    return save({ status: "indeterminate" });
  }
}
