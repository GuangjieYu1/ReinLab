import { createHash } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import type { JsonValue } from "@reinlab/contracts";
import { Database } from "../../db/database";
import { ApiFailure, denied } from "../../api/errors";
import { canonical } from "../../api/context";
import { appendEvent } from "../../ledger";
import { lockBudget, settleObservedRun } from "../../budget";
import { BindingStore, bindingRow } from "./binding-store";
import type { ObservationSink } from "./observer";
import { mapRuntimeEvent } from "./mapping";
import { mcpAutoReply, pendingMcpApproval } from "../../mcp/approval-bridge";
import {
  priceDeepSeekUsage,
  DEEPSEEK_PRICING_VERSION,
} from "./deepseek-pricing";
const Envelope = z
  .object({
    sequence: z.number().int().positive().safe(),
    sessionID: z.string().min(1).max(200),
    runID: z.string().min(1).max(200),
    type: z.string().min(1).max(500),
    properties: z.record(z.unknown()),
    time: z.number().int().nonnegative().safe(),
  })
  .strict();
const Pricing = z
  .object({
    currency: z.enum(["CNY", "USD"]),
    window: z.enum(["peak", "offpeak"]),
    usdCnyRate: z.literal("7.2"),
    requestedModel: z.string(),
    pricingVersion: z.literal(DEEPSEEK_PRICING_VERSION),
    validFrom: z.number().int().nonnegative().safe(),
    validUntil: z.number().int().positive().safe(),
  })
  .strict();
const sha = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const snapshotId = z.string().min(1).max(200),
  snapshotCount = z.number().int().nonnegative().safe();
const Snapshot = z.object({
  sessionID: snapshotId,
  latestSequence: snapshotCount,
  runs: z
    .array(
      z.object({
        runID: snapshotId,
        sessionID: snapshotId,
        requestID: snapshotId,
        state: z.enum([
          "accepted",
          "running",
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ]),
      })
    )
    .max(1024),
  permissions: z
    .array(z.object({ id: snapshotId, sessionID: snapshotId }))
    .max(1024),
  questions: z
    .array(z.object({ id: snapshotId, sessionID: snapshotId }))
    .max(1024),
});
const terminalStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
function terminalConflict(run: Record<string, any>, state: string) {
  if (
    run.ended_at !== null &&
    (run.state === "paused_budget" ? "completed" : run.state) !== state
  )
    throw new ApiFailure(
      "RUNTIME_TERMINAL_CONFLICT",
      409,
      "终态证据与已结束的运行不一致，需要先核对。"
    );
}
async function lockedRun(client: pg.PoolClient, runId: string) {
  const run = (
    await client.query("select * from run where id=$1 for update", [runId])
  ).rows[0];
  if (!run) throw denied();
  return run;
}
async function finishTerminal(
  client: pg.PoolClient,
  accountId: string,
  runId: string,
  state: string,
  complete: boolean,
  previous: Record<string, any>
) {
  terminalConflict(previous, state);
  if (previous.ended_at !== null) return;
  const expired = await client.query(
    "update approval set state='expired' where account_id=$1 and run_id=$2 and state='pending' and kind in ('permission','question') returning id",
    [accountId, runId]
  );
  if (expired.rowCount)
    await appendEvent(client, accountId, {
      dossierId: previous.dossier_id,
      runId,
      roleId: previous.role_id,
      kind: "approval",
      action: "runtime_approvals_expired",
      payload: { count: expired.rowCount },
      dedupeKey: "runtime-approvals-expired:" + runId,
    });
  await settleObservedRun(client, accountId, runId, complete);
  await client.query(
    "update run set state=case when $2='completed' and state='paused_budget' then state else $2 end,ended_at=now() where id=$1",
    [runId, state]
  );
}
export type PendingSnapshot = {
  sessionID: string;
  permissions: Array<{ id: string; sessionID: string }>;
  questions: Array<{ id: string; sessionID: string }>;
};
/** Projection + checkpoint are a single account transaction. No runtime write port. */
export class ObservationStore {
  constructor(
    private readonly db: Database,
    private readonly onTerminal?: (
      account: string,
      run: string
    ) => Promise<void>,
    /** 已批准能力调用的原生权限请求：由控制面按账本决定自动答复，不再让用户批第二次。 */
    private readonly onMcpPermission?: (
      account: string,
      run: string,
      sessionID: string,
      requestID: string,
      reply: "once" | "reject"
    ) => Promise<void>
  ) {}
  async ingest(
    accountId: string,
    runId: string,
    raw: unknown,
    pending?: PendingSnapshot
  ) {
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success)
      throw new ApiFailure(
        "OS_EVENT_INVALID",
        503,
        "内核事件缺少可核对的游标。"
      );
    const event = parsed.data,
      hash = sha(raw);
    const result = await this.db.withAccount(accountId, async (c) => {
      await lockBudget(c, accountId);
      const binding = await bindingRow(c, runId, true),
        run = await lockedRun(c, runId);
      if (
        event.sessionID !== binding.sessionId ||
        event.runID !== binding.receipt?.runID
      )
        throw new ApiFailure("SCOPE_DENIED", 403, "事件不属于已登记的运行。");
      const old = await c.query(
        "select source_hash from os_observation where session_id=$1 and sequence=$2",
        [binding.sessionId, event.sequence]
      );
      if (old.rowCount) {
        if (old.rows[0].source_hash !== hash)
          throw new ApiFailure(
            "DEDUPE_CONFLICT",
            409,
            "同一游标的事件内容不同。"
          );
        return { cursor: binding.cursor, autoReply: undefined };
      }
      if (event.sequence <= binding.cursor)
        return { cursor: binding.cursor, autoReply: undefined }; // Before the durable pre-admission baseline.
      if (event.sequence !== binding.cursor + 1)
        throw new ApiFailure(
          "CURSOR_GAP",
          409,
          "事件游标存在缺口，需要恢复快照。"
        );
      const mapped = mapRuntimeEvent(raw, {
        toolGrants: binding.role.role.toolGrants,
      });
      let autoReply:
        | {
            sessionID: string;
            requestID: string;
            approvalId: string;
            capability: string;
            reply: "once" | "reject";
          }
        | undefined;
      let cost: string | null = null,
        kind = mapped.kind,
        action = mapped.action,
        payload = mapped.payload,
        usageInsert:
          | {
              part: Record<string, any>;
              hash: string;
              metadata: Record<string, JsonValue>;
            }
          | undefined;
      const part = event.properties.part as Record<string, any> | undefined;
      if (run.ended_at !== null) {
        if (mapped.usage || part?.type === "step-finish")
          throw new ApiFailure(
            "LATE_USAGE_AFTER_TERMINAL",
            409,
            "运行结束后收到新的费用用量，需要人工核对。"
          );
        if (event.type === "runtime.accepted")
          throw new ApiFailure(
            "RUNTIME_TERMINAL_CONFLICT",
            409,
            "已结束的运行不能重新接受执行。"
          );
      }
      // 只有映射明确标了 uncertain（认出来的坏用量/冲突）才动费用完整性；
      // 未知事件、未知 part、被容忍的进度字段一律 accountingImpact=none。
      if (
        mapped.accountingImpact === "uncertain" ||
        (part?.type === "step-finish" && !mapped.usage)
      )
        await c.query(
          "update os_binding set usage_uncertain=true where run_id=$1",
          [runId]
        );
      if (mapped.usage) {
        const sourceHash = sha(part),
          prior = await c.query(
            "select source_hash from os_usage where session_id=$1 and part_id=$2",
            [binding.sessionId, mapped.usage.partID]
          );
        if (prior.rowCount) {
          if (prior.rows[0].source_hash !== sourceHash) {
            kind = "error";
            action = "usage_conflict";
            await c.query(
              "update os_binding set usage_uncertain=true where run_id=$1",
              [runId]
            );
          } else {
            kind = "gate";
            action = "usage_duplicate";
          }
        } else {
          const source = (
              await c.query(
                "select pricing_context from os_binding where run_id=$1",
                [runId]
              )
            ).rows[0].pricing_context,
            priceContext = Pricing.safeParse(source);
          const inWindow =
            priceContext.success &&
            typeof part?.usage?.time === "number" &&
            part.usage.time >= priceContext.data.validFrom &&
            part.usage.time < priceContext.data.validUntil;
          const priced =
            inWindow &&
            part?.sessionID === binding.sessionId &&
            mapped.usage.status === "observed"
              ? priceDeepSeekUsage(part, priceContext.data)
              : {
                  costCny: null,
                  metadata: {
                    status: "unknown",
                    unknownReason: "UNVERIFIED_USAGE_OR_PRICE_WINDOW",
                    source: "direct_provider_usage",
                    usdCnyRate: "7.2",
                  },
                };
          cost = priced.costCny;
          payload = {
            ...payload,
            pricing: { ...priced.metadata, source: "direct_provider_usage" },
          };
          usageInsert = {
            part: part!,
            hash: sourceHash,
            metadata: { ...priced.metadata, source: "direct_provider_usage" },
          };
        }
      }
      const ledger = await appendEvent(c, accountId, {
        dossierId: binding.dossierId,
        runId,
        roleId: binding.logicalRoleId,
        kind,
        action,
        risk: mapped.risk ?? null,
        costCny: cost === null ? null : Number(cost),
        credentialKind: mapped.usage ? "api_key" : null,
        payload,
        dedupeKey: binding.sessionId + ":" + event.sequence,
      });
      if (usageInsert)
        await c.query(
          "insert into os_usage(account_id,dossier_id,run_id,session_id,part_id,message_id,source_hash,cost_cny,metadata,event_seq) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
          [
            accountId,
            binding.dossierId,
            runId,
            binding.sessionId,
            mapped.usage!.partID,
            mapped.usage!.messageID,
            usageInsert.hash,
            cost,
            JSON.stringify(usageInsert.metadata),
            ledger.seq,
          ]
        );
      if (mapped.approval) {
        const approval = mapped.approval;
        if (approval.sessionID === binding.sessionId) {
          if (approval.state === "historical_pending") {
            // 人已经在账本里批过这次 MCP 能力调用，内核却按插件再问一次权限：
            // 不再给用户出第二张卡，改由控制面按已批准的决定自动答复（run8 R4）。
            const bridged =
              approval.kind === "permission"
                ? pendingMcpApproval(payload?.properties ?? payload)
                : null;
            if (bridged) {
              const decision = (
                await c.query(
                  "select decision,consumed from mcp_approval where id=$1 and account_id=$2 and run_id=$3",
                  [bridged.approvalId, accountId, runId]
                )
              ).rows[0];
              const auto = mcpAutoReply(decision);
              if (auto) {
                autoReply = {
                  sessionID: binding.sessionId,
                  requestID: approval.requestID,
                  approvalId: bridged.approvalId,
                  capability: bridged.capability,
                  reply: auto,
                };
                await appendEvent(c, accountId, {
                  dossierId: binding.dossierId,
                  runId,
                  roleId: binding.logicalRoleId,
                  kind: "gate",
                  action: "mcp_permission_auto_reply",
                  payload: {
                    approvalId: bridged.approvalId,
                    capability: bridged.capability,
                    reply: autoReply.reply,
                  },
                  dedupeKey: "mcp-auto-reply:" + runId + ":" + approval.requestID,
                });
              }
            }
            // 已经自动答复过的不再出卡，用户不会再被问第二次。
            if (!autoReply) {
              const live =
                pending?.sessionID === binding.sessionId &&
                (approval.kind === "permission"
                  ? pending.permissions
                  : pending.questions
                ).some(
                  (item) =>
                    item.id === approval.requestID &&
                    item.sessionID === binding.sessionId
                );
              await c.query(
                `insert into approval(account_id,run_id,os_request_id,os_session_id,kind,title,effects,risk,state) values($1,$2,$3,$4,$5,$6,$7::jsonb,'write',$8) on conflict do nothing`,
                [
                  accountId,
                  runId,
                  approval.requestID,
                  binding.sessionId,
                  approval.kind,
                  approval.kind === "permission"
                    ? "执行权限等待你的决定"
                    : "问题等待你的回答",
                  JSON.stringify([payload]),
                  live ? "pending" : "expired",
                ]
              );
            }
          } else if (approval.state === "resolved")
            await c.query(
              "update approval set state=case when decision_hash is null then 'expired' else 'indeterminate' end where run_id=$1 and os_session_id=$2 and os_request_id=$3 and state='pending'",
              [runId, binding.sessionId, approval.requestID]
            );
          else
            await c.query(
              "update approval set state=$4 where run_id=$1 and os_session_id=$2 and os_request_id=$3 and state='pending'",
              [
                runId,
                binding.sessionId,
                approval.requestID,
                approval.state === "rejected" ? "rejected" : "expired",
              ]
            );
        }
      }
      if (mapped.runState && mapped.runState !== "accepted") {
        const uncertain = (
          await c.query(
            "select usage_uncertain from os_binding where run_id=$1",
            [runId]
          )
        ).rows[0].usage_uncertain;
        await finishTerminal(
          c,
          accountId,
          runId,
          mapped.runState,
          mapped.runState === "completed" && !uncertain,
          run
        );
      }
      await c.query(
        "insert into os_observation(account_id,run_id,session_id,sequence,source_hash,event_seq) values($1,$2,$3,$4,$5,$6)",
        [accountId, runId, binding.sessionId, event.sequence, hash, ledger.seq]
      );
      await c.query("update os_binding set cursor=$2 where run_id=$1", [
        runId,
        event.sequence,
      ]);
      return { cursor: event.sequence, autoReply };
    });
    // 游标已经推进且决定已落库，再去答复内核；答复失败也不回滚观察。
    if (result.autoReply && this.onMcpPermission) {
      await this.onMcpPermission(
        accountId,
        runId,
        result.autoReply.sessionID,
        result.autoReply.requestID,
        result.autoReply.reply,
      ).catch(() => {});
    }
    return result.cursor;
  }
  private async cleanupTerminal(accountId: string, runId: string) {
    if (!this.onTerminal) return;
    const terminal = await this.db.withAccount(
      accountId,
      async (c) =>
        (
          await c.query(
            "select 1 from run where id=$1 and (ended_at is not null or state in ('completed','failed','cancelled','interrupted'))",
            [runId]
          )
        ).rowCount
    );
    if (terminal) await this.onTerminal(accountId, runId);
  }
  sink(accountId: string, runId: string): ObservationSink {
    const bindings = new BindingStore(this.db);
    return Object.freeze({
      cursor: async () => (await bindings.get(accountId, runId)).cursor,
      ingest: async (raw: unknown, pending?: PendingSnapshot) => {
        await this.ingest(accountId, runId, raw, pending);
        await this.cleanupTerminal(accountId, runId);
      },
      gap: async (latest: number, reason: "CURSOR_EXPIRED" | "CURSOR_GAP") => {
        await this.gap(accountId, runId, latest, reason);
      },
      failed: async (code: string) => {
        await this.failed(accountId, runId, code);
      },
      synchronize: async (snapshot: unknown) => {
        await this.synchronize(accountId, runId, snapshot);
        await this.cleanupTerminal(accountId, runId);
      },
    });
  }
  async failed(accountId: string, runId: string, code: string) {
    const stable = [
      "CURSOR_AHEAD",
      "OS_OBSERVATION_INVALID",
      "OS_UNAVAILABLE",
      "OS_STREAM_CLOSED",
      "OS_NOT_FOUND",
      "SCOPE_DENIED",
    ].includes(code)
      ? code
      : "OS_OBSERVATION_FAILED";
    return this.db.withAccount(accountId, async (c) => {
      await lockBudget(c, accountId);
      const b = await bindingRow(c, runId, true),
        run = await lockedRun(c, runId);
      const hold = (
        await c.query("select state from budget_hold where id=$1", [b.holdId])
      ).rows[0];
      if (run.ended_at !== null && hold?.state === "settled") return;
      await appendEvent(c, accountId, {
        dossierId: b.dossierId,
        runId,
        roleId: b.logicalRoleId,
        kind: "error",
        action: "runtime_observation_failed",
        payload: { source: "observer", code: stable, historyComplete: false },
        dedupeKey:
          "os-observer-failed:" + b.sessionId + ":" + b.cursor + ":" + stable,
      });
      await c.query(
        "update os_binding set usage_uncertain=true where run_id=$1",
        [runId]
      );
      await settleObservedRun(c, accountId, runId, false);
      if (run.ended_at !== null)
        await c.query("update run set state=$2 where id=$1", [
          runId,
          run.state,
        ]);
    });
  }
  async synchronize(accountId: string, runId: string, raw: unknown) {
    const parsed = Snapshot.safeParse(raw);
    if (!parsed.success)
      throw new ApiFailure(
        "OS_EVENT_INVALID",
        503,
        "快照缺少可核对的运行身份。"
      );
    const snapshot = parsed.data;
    return this.db.withAccount(accountId, async (c) => {
      await lockBudget(c, accountId);
      const b = await bindingRow(c, runId, true),
        run = await lockedRun(c, runId);
      const matches = snapshot.runs.filter(
        (item) => item.runID === b.receipt?.runID
      );
      if (
        b.phase !== "accepted" ||
        !b.receipt ||
        snapshot.sessionID !== b.sessionId ||
        matches.length !== 1 ||
        matches[0].sessionID !== b.sessionId ||
        matches[0].requestID !== b.requestId
      )
        throw new ApiFailure("SCOPE_DENIED", 403, "快照不属于已登记的运行。");
      if (snapshot.latestSequence < b.cursor)
        throw new ApiFailure(
          "CURSOR_AHEAD",
          409,
          "快照历史落后于已提交游标，拒绝回退。"
        );
      const actual = matches[0],
        terminal = terminalStates.has(actual.state);
      if (terminal) terminalConflict(run, actual.state);
      const permissionIds = snapshot.permissions
          .filter((item) => item.sessionID === b.sessionId)
          .map((item) => item.id)
          .sort(),
        questionIds = snapshot.questions
          .filter((item) => item.sessionID === b.sessionId)
          .map((item) => item.id)
          .sort();
      const source = {
        sessionID: b.sessionId,
        runID: b.receipt.runID,
        requestID: b.requestId,
        state: actual.state,
        latestSequence: snapshot.latestSequence,
        permissionIds,
        questionIds,
      };
      const key = "os-snapshot:" + b.sessionId + ":" + sha(source);
      if (
        (
          await c.query(
            "select seq from event where account_id=$1 and dedupe_key=$2",
            [accountId, key]
          )
        ).rowCount
      )
        return;
      if (!terminal && run.ended_at !== null) return;
      const expired = await c.query(
        `update approval set state='expired' where run_id=$1 and os_session_id=$2 and state in ('pending','indeterminate') and ((kind='permission' and not(os_request_id=any($3::text[]))) or (kind='question' and not(os_request_id=any($4::text[])))) returning id`,
        [runId, b.sessionId, permissionIds, questionIds]
      );
      const incomplete = terminal && snapshot.latestSequence > b.cursor;
      if (expired.rowCount || incomplete)
        await c.query(
          "update os_binding set usage_uncertain=true where run_id=$1",
          [runId]
        );
      if (!terminal && !expired.rowCount) return;
      const uncertain = (
        await c.query(
          "select usage_uncertain from os_binding where run_id=$1",
          [runId]
        )
      ).rows[0].usage_uncertain;
      await appendEvent(c, accountId, {
        dossierId: b.dossierId,
        runId,
        roleId: b.logicalRoleId,
        kind: terminal ? "gate" : "error",
        action: terminal
          ? "runtime_snapshot_reconciled"
          : "runtime_pending_expired",
        payload: {
          source: "snapshot",
          sessionID: b.sessionId,
          runID: b.receipt.runID,
          requestID: b.requestId,
          state: actual.state,
          latestSequence: snapshot.latestSequence,
          observedCursor: b.cursor,
          historyComplete: !uncertain && snapshot.latestSequence === b.cursor,
          expiredPendingCount: expired.rowCount ?? 0,
        },
        dedupeKey: key,
      });
      if (terminal)
        await finishTerminal(
          c,
          accountId,
          runId,
          actual.state,
          actual.state === "completed" && !uncertain && !expired.rowCount,
          run
        );
      else {
        await settleObservedRun(c, accountId, runId, false);
        await c.query(
          "update run set state='interrupted',ended_at=now() where id=$1",
          [runId]
        );
      }
    });
  }
  async gap(accountId: string, runId: string, latest: number, reason: string) {
    if (!Number.isSafeInteger(latest) || latest < 0)
      throw new ApiFailure("OS_EVENT_INVALID", 503, "快照游标不合法。");
    return this.db.withAccount(accountId, async (c) => {
      await lockBudget(c, accountId);
      const b = await bindingRow(c, runId, true),
        run = await lockedRun(c, runId);
      if (latest < b.cursor)
        throw new ApiFailure(
          "CURSOR_AHEAD",
          409,
          "内核历史落后于持久游标，拒绝回退。"
        );
      await appendEvent(c, accountId, {
        dossierId: b.dossierId,
        runId,
        roleId: b.logicalRoleId,
        kind: "error",
        action: "runtime_cursor_gap",
        payload: {
          from: b.cursor,
          to: latest,
          reason: reason === "CURSOR_EXPIRED" ? "CURSOR_EXPIRED" : "CURSOR_GAP",
          historyComplete: false,
        },
        dedupeKey: "os-gap:" + b.sessionId + ":" + b.cursor + ":" + latest,
      });
      await c.query(
        "update os_binding set cursor=$2,usage_uncertain=true where run_id=$1",
        [runId, latest]
      );
      await c.query(
        "update approval set state='expired' where run_id=$1 and state='pending' and kind in ('permission','question')",
        [runId]
      );
      await settleObservedRun(c, accountId, runId, false);
      if (run.ended_at !== null)
        await c.query("update run set state=$2 where id=$1", [
          runId,
          run.state,
        ]);
      return latest;
    });
  }
}
