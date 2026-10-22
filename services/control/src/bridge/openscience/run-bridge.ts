import { z } from "zod";
import { DEEPSEEK_PRICING_VERSION } from "./deepseek-pricing";
import { Database } from "../../db/database";
import { ApiFailure } from "../../api/errors";
import { authorizeTool, lockBudget } from "../../budget";
import { appendEvent } from "../../ledger";
import { BindingStore, type Binding } from "./binding-store";
import type { RoleProjectRequest } from "./role-project";
import { RoleRuntime } from "./role-runtime";
export const PricingWindowSnapshot = z
  .object({
    currency: z.enum(["CNY", "USD"]),
    window: z.enum(["peak", "offpeak"]),
    usdCnyRate: z.literal("7.2"),
    pricingVersion: z.literal(DEEPSEEK_PRICING_VERSION),
    validFrom: z.number().int().nonnegative().safe(),
    validUntil: z.number().int().positive().safe(),
  })
  .strict()
  .refine((value) => value.validUntil > value.validFrom);
export type RunBridgeOptions = {
  pricingContext?: unknown;
  prepareCapabilities?: (accountId: string, runId: string) => Promise<void>;
};
export type RuntimeFactory = (
  accountId: string,
  role: z.infer<typeof RoleProjectRequest>,
) => Promise<RoleRuntime>;
export type RunDefinition = {
  role: z.infer<typeof RoleProjectRequest>;
  message: string;
};
export type Submission =
  | { status: "accepted"; receipt: { runID: string; acceptedAt: number } }
  | { status: "indeterminate" | "preparing"; sessionID: string };
/** Only explicit user admission calls submit; observation has no access to this method. */
export class RunBridge {
  readonly store: BindingStore;
  private readonly pricingContext?: z.infer<typeof PricingWindowSnapshot>;
  constructor(
    private readonly db: Database,
    private readonly factory: RuntimeFactory,
    private readonly definition?: (
      accountId: string,
      runId: string,
    ) => Promise<RunDefinition>,
    private readonly options: RunBridgeOptions = {},
  ) {
    this.store = new BindingStore(db);
    if (options.pricingContext !== undefined) {
      const parsed = PricingWindowSnapshot.safeParse(options.pricingContext);
      if (!parsed.success)
        throw new ApiFailure(
          "PRICING_CONTEXT_INVALID",
          503,
          "固定计费窗口配置无效。",
        );
      this.pricingContext = Object.freeze(parsed.data);
    }
  }
  private async persistPricing(accountId: string, binding: Binding) {
    if (!this.pricingContext) return;
    await this.db.withAccount(accountId, (c) =>
      c.query(
        "update os_binding set pricing_context=$2::jsonb where run_id=$1 and pricing_context is null and phase in ('planned','preparing','prepared')",
        [
          binding.runId,
          JSON.stringify({
            ...this.pricingContext,
            requestedModel: binding.role.model,
          }),
        ],
      ),
    );
  }
  async runtime(accountId: string, runId: string): Promise<RoleRuntime> {
    const binding = await this.store.get(accountId, runId);
    const runtime = await this.factory(accountId, binding.role);
    await runtime.restoreSession(binding.sessionId);
    return runtime;
  }
  private async recover(
    accountId: string,
    binding: Binding,
  ): Promise<Submission> {
    if (binding.receipt)
      return { status: "accepted", receipt: binding.receipt };
    const runtime = await this.runtime(accountId, binding.runId);
    const snapshot = await runtime.snapshot(binding.sessionId);
    const run = snapshot.runs.find(
      (item) =>
        item.requestID === binding.requestId &&
        item.sessionID === binding.sessionId,
    );
    if (!run) return { status: "indeterminate", sessionID: binding.sessionId };
    const receipt = { runID: run.runID, acceptedAt: run.acceptedAt };
    await this.store.receipt(accountId, binding.runId, receipt);
    return { status: "accepted", receipt };
  }
  async submit(
    accountId: string,
    runId: string,
    definition?: RunDefinition,
  ): Promise<Submission> {
    let binding: Binding;
    if (definition)
      binding = await this.store.prepare(accountId, runId, definition);
    else {
      try {
        binding = await this.store.get(accountId, runId);
      } catch (error) {
        if (
          !(error instanceof ApiFailure) ||
          error.code !== "RLS_DENIED" ||
          !this.definition
        )
          throw error;
        binding = await this.store.prepare(
          accountId,
          runId,
          await this.definition(accountId, runId),
        );
      }
    }
    if (binding.receipt)
      return { status: "accepted", receipt: binding.receipt };
    if (binding.phase === "submitting") return this.recover(accountId, binding);
    await this.persistPricing(accountId, binding);
    const lease = await this.store.claim(accountId, runId);
    if (!lease) return { status: "preparing", sessionID: binding.sessionId };
    const runtime = await this.factory(accountId, binding.role);
    const capabilities = await runtime.capabilities();
    if (
      capabilities.protocolVersion !== "1.0" ||
      capabilities.serverVersion !== "2.0.150" ||
      capabilities.idempotentPrompts !== true ||
      capabilities.runSnapshots !== true ||
      capabilities.crashRecovery !== "interrupt"
    )
      throw new ApiFailure(
        "OS_PROTOCOL_MISMATCH",
        503,
        "账户执行内核的恢复协议不匹配。",
      );
    await runtime.createSession(
      "ReinLab " + binding.logicalRoleId,
      binding.sessionId,
    );
    const snapshot = await runtime.snapshot(binding.sessionId);
    if (snapshot.runs.length)
      throw new ApiFailure(
        "BINDING_SESSION_OCCUPIED",
        409,
        "新绑定的会话已有执行记录，需要先核对。",
      );
    await this.store.baseline(accountId, runId, lease, snapshot.latestSequence);
    const admitted = await this.db.withAccount(accountId, async (c) => {
      await lockBudget(c, accountId);
      // A lease is checked again inside the run's budget transaction, before any model admission.
      const owned = await c.query(
        "select run_id from os_binding where run_id=$1 and lease_id=$2 and lease_until>now() and phase='prepared' for update",
        [runId, lease],
      );
      if (!owned.rowCount)
        throw new ApiFailure(
          "BINDING_LEASE_LOST",
          409,
          "准备会话的租约已失效。",
        );
      const found = await c.query(
        "select state,budget_cny::text budget from run where id=$1 for update",
        [runId],
      );
      if (!["queued", "running"].includes(found.rows[0]?.state))
        throw new ApiFailure("RUN_NOT_QUEUED", 409, "运行当前不能提交。");
      await c.query("update run set state='running' where id=$1", [runId]);
      const hold = await authorizeTool(c, accountId, {
        runId,
        requestId: "model-run:" + binding.requestId,
        maximumCny: found.rows[0].budget,
      });
      if (!hold.allowed) return false;
      await c.query("update os_binding set hold_id=$2 where run_id=$1", [
        runId,
        hold.holdId,
      ]);
      await appendEvent(c, accountId, {
        dossierId: binding.dossierId,
        runId,
        roleId: binding.logicalRoleId,
        kind: "gate",
        action: "runtime_admitted",
        payload: {
          sessionID: binding.sessionId,
          requestID: binding.requestId,
          definitionHash: binding.definitionHash,
        },
        dedupeKey: "runtime-admitted:" + runId,
      });
      return true;
    });
    if (!admitted)
      throw new ApiFailure(
        "BUDGET_EXCEEDED",
        409,
        "模型运行没有可用的费用预留。",
      );
    await this.options.prepareCapabilities?.(accountId, runId);
    await this.store.sendIntent(accountId, runId, lease);
    try {
      const receipt = await runtime.prompt({
        sessionID: binding.sessionId,
        requestID: binding.requestId,
        message: binding.message,
      });
      await this.store.receipt(accountId, runId, receipt);
      return { status: "accepted", receipt };
    } catch (error) {
      if ((error as { code?: string })?.code === "IDEMPOTENCY_CONFLICT")
        throw error;
      // Intent was committed. A lost acknowledgement cannot authorize another prompt.
      return { status: "indeterminate", sessionID: binding.sessionId };
    }
  }
}
