import { bindRunCapabilities, loadCapabilityCatalog } from "../mcp/authority";
import type { HarnessStore } from "../harness/store";
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  EstimateRequest,
  RunCreate,
  BudgetAppend,
  BudgetEstimate,
  QueuedRun,
  RunBudgetState,
} from "@reinlab/contracts";
import type { Database } from "../db/database";
import { PricingService } from "../budget/pricing";
import {
  allocateBudget,
  prepareDossierBudget,
  lockBudget,
  increaseRunBudget,
} from "../budget";
import { cny, micros } from "../budget/money";
import { requireDossier, appendEvent, scrub } from "../ledger";
import { mutate, type ApiEnv } from "./context";
import { ApiFailure, denied } from "./errors";

export function registerBudget(
  app: Hono<ApiEnv>,
  database: Database,
  pricing: PricingService,
  harness: HarnessStore,
  onRunQueued?: (accountId: string, runId: string) => Promise<void>,
) {
  app.post("/v1/runs/estimate", (c) =>
    mutate(c, database, EstimateRequest, async (client, input) => {
      await requireDossier(client, input.dossierId);
      const effective = await harness.effectiveClient(
          client,
          c.get("accountId"),
          input.dossierId,
        ),
        role =
          effective.manifest.roles[effective.manifest.entrypoints[input.mode]],
        tier = effective.manifest.model_slots[role.model_slot];
      if (input.modelTier && input.modelTier !== tier)
        throw new ApiFailure(
          "ESTIMATE_MISMATCH",
          409,
          "模型档与有效工作台配置不一致。",
        );
      const baseQuote = await pricing.estimate(
        { mode: input.mode, modelTier: tier, size: input.size },
        {
          modelTier: tier,
          defaultBudgetCny:
            effective.manifest.budget.by_mode[input.mode] === null
              ? null
              : cny(
                  effective.manifest.budget.by_mode[input.mode] ??
                    effective.manifest.budget.default_cny ??
                    0,
                ),
        },
      );
      const quote = {
        ...baseQuote,
        assumptions: {
          ...baseQuote.assumptions,
          benchVersion: effective.manifest.version,
          effectiveConfigDigest: effective.digest,
        },
      };
      const id = randomUUID(),
        result = await client.query(
          "insert into budget_estimate(id,account_id,dossier_id,mode,model_tier,quote,expires_at) values($1,$2,$3,$4,$5,$6::jsonb,now()+interval '10 minutes') returning expires_at",
          [
            id,
            c.get("accountId"),
            input.dossierId,
            input.mode,
            quote.modelTier,
            JSON.stringify(quote),
          ],
        );
      return {
        status: 201,
        body: BudgetEstimate.parse({
          id,
          ...quote,
          expiresAt: result.rows[0].expires_at.toISOString(),
        }),
      };
    }),
  );
  app.post("/v1/runs", async (c) => {
    let created = false;
    const response = await mutate(
      c,
      database,
      RunCreate,
      async (client, input) => {
        const accountId = c.get("accountId"),
          amount = cny(input.budget.cny);
        await lockBudget(client, accountId);
        await requireDossier(client, input.dossierId);
        const found = await client.query(
          "select *,expires_at>now() valid from budget_estimate where id=$1",
          [input.estimateId],
        );
        if (!found.rowCount) throw denied();
        const estimate = found.rows[0];
        const effective = await harness.effectiveClient(
            client,
            accountId,
            input.dossierId,
          ),
          expectedRole = effective.manifest.entrypoints[input.mode];
        const role = effective.manifest.roles[expectedRole],
          tier = effective.manifest.model_slots[role.model_slot];
        if (
          !estimate.valid ||
          estimate.dossier_id !== input.dossierId ||
          estimate.mode !== input.mode ||
          estimate.model_tier !== tier ||
          estimate.quote.model !== pricing.route(tier) ||
          input.roleId !== expectedRole ||
          estimate.quote.assumptions?.effectiveConfigDigest !== effective.digest
        )
          throw new ApiFailure(
            "ESTIMATE_MISMATCH",
            409,
            "估算已过期，或工作台有效配置已变化。",
          );
        if (
          (
            await client.query("select id from run where estimate_id=$1", [
              input.estimateId,
            ])
          ).rowCount
        )
          throw new ApiFailure(
            "ESTIMATE_CONSUMED",
            409,
            "该估算已经用于一个运行，请重新预估。",
          );
        const quota = input.budget.quotaRuns ?? 0,
          gpu = (input.budget.gpuMinutes ?? 0) * 60;
        if (
          !Number.isSafeInteger(gpu) ||
          gpu > 2147483647 ||
          quota > 2147483647
        )
          throw new ApiFailure(
            "INVALID_INPUT",
            400,
            "GPU预算必须能换算为整数秒，额度不得溢出。",
          );
        if (micros(amount) <= 0n)
          throw new ApiFailure("INVALID_INPUT", 400, "运行预算必须大于零。");
        const root = await prepareDossierBudget(
            client,
            accountId,
            input.dossierId,
            amount,
          ),
          id = randomUUID(),
          requestId = randomUUID();
        await client.query(
          "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit,estimate_id,input) values($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11::jsonb)",
          [
            id,
            accountId,
            input.dossierId,
            input.roleId,
            input.mode,
            requestId,
            amount,
            quota,
            gpu,
            input.estimateId,
            JSON.stringify(scrub(input.input)),
          ],
        );
        await client.query(
          "insert into run_harness(account_id,dossier_id,run_id,bench,version,effective_digest,model_route) values($1,$2,$3,$4,$5,$6,$7)",
          [
            accountId,
            input.dossierId,
            id,
            effective.manifest.id,
            effective.manifest.version,
            effective.digest,
            estimate.quote.model,
          ],
        );
        await bindRunCapabilities(client, accountId, id, effective, input.roleId, input.input, await loadCapabilityCatalog());
        await allocateBudget(client, accountId, {
          dossierId: input.dossierId,
          runId: id,
          parentId: root.id,
          amountCny: amount,
        });
        await appendEvent(client, accountId, {
          dossierId: input.dossierId,
          runId: id,
          kind: "gate",
          action: "run_queued",
          risk: "write",
          payload: {
            benchVersion: effective.manifest.version,
            effectiveConfigDigest: effective.digest,
            estimateId: input.estimateId,
            model: estimate.quote.model,
            budgetCny: amount,
            quotaRuns: quota,
            gpuSeconds: gpu,
            confirmed: true,
          },
          dedupeKey: "run-queued:" + id,
        });
        created = true;
        return {
          status: 201,
          body: QueuedRun.parse({
            id,
            dossierId: input.dossierId,
            mode: input.mode,
            state: "queued",
            budgetCny: amount,
            spentCny: "0.000000",
            quotaRuns: 0,
            gpuSeconds: 0,
          }),
        };
      },
    );
    if (created && onRunQueued && response.status === 201) {
      const receipt = (await response.clone().json()) as { id: string };
      try {
        await onRunQueued(c.get("accountId"), receipt.id);
      } catch {
        await database
          .withAccount(c.get("accountId"), async (client) => {
            const row = (
              await client.query("select dossier_id from run where id=$1", [
                receipt.id,
              ])
            ).rows[0];
            if (!row) throw denied();
            return appendEvent(client, c.get("accountId"), {
              dossierId: row.dossier_id,
              runId: receipt.id,
              kind: "error",
              action: "run_admission_deferred",
              payload: { code: "ADMISSION_DEFERRED" },
              dedupeKey: "admission-deferred:" + receipt.id,
            });
          })
          .catch(() => {});
      }
    }
    return response;
  });
  app.post("/v1/runs/:id/budget", (c) =>
    mutate(c, database, BudgetAppend, async (client, input) => ({
      status: 200,
      body: RunBudgetState.parse(
        await increaseRunBudget(
          client,
          c.get("accountId"),
          c.req.param("id"),
          input,
        ),
      ),
    })),
  );
}
