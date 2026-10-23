import { registerApprovalInbox, decideInboxCard } from "./inbox-approvals";
import type { CapabilityEngine } from "../mcp/engine";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { BenchPatch, type JsonValue } from "@reinlab/contracts";
import type { Database } from "../db/database";
import type { HarnessStore } from "../harness/store";
import type { RuntimePipeline } from "../bridge/openscience/pipeline";
import { lockBudget } from "../budget";
import { cny } from "../budget/money";
import { appendEvent } from "../ledger";
import { mutate, type ApiContext, type ApiEnv } from "./context";
import { ApiFailure, denied } from "./errors";
export type RuntimeApiPort = Pick<
  RuntimePipeline,
  "submit" | "recoverAccount" | "decisions"
>;
const Empty = z.object({}).strict(),
  uuid = z.string().uuid();
const Decision = z
  .object({
    decision: z.enum(["approve", "reject"]),
    scope: z.enum(["once", "session"]).default("once"),
    answers: z
      .array(z.array(z.string().max(4000)).min(1).max(64))
      .min(1)
      .max(64)
      .optional(),
  })
  .strict();
const HarnessDecision = z
  .object({ decision: z.enum(["approve", "reject"]) })
  .strict();
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

function id(value: string) {
  if (!uuid.safeParse(value).success) throw denied();
  return value;
}
function idem(c: ApiContext) {
  const key = c.req.header("Idempotency-Key");
  if (!key || !/^[-A-Za-z0-9_.:]{1,200}$/.test(key))
    throw new ApiFailure(
      "IDEMPOTENCY_KEY_REQUIRED",
      400,
      "写入请求需要有效的 Idempotency-Key。",
    );
}
function available(pipeline?: RuntimeApiPort) {
  if (!pipeline)
    throw new ApiFailure("RUNTIME_UNAVAILABLE", 503, "执行管线尚未配置。");
  return pipeline;
}
/** Post-commit errors must not rewrite an immutable accepted HTTP receipt. */
async function deferred(
  db: Database,
  account: string,
  run: string,
  action: string,
  code: string,
) {
  try {
    await db.withAccount(account, async (c) => {
      await lockBudget(c, account);
      const row = (
        await c.query("select dossier_id,role_id from run where id=$1", [run])
      ).rows[0];
      if (!row) return;
      await appendEvent(c, account, {
        dossierId: row.dossier_id,
        runId: run,
        roleId: row.role_id,
        kind: "error",
        action,
        payload: { code },
        dedupeKey: action + ":" + run,
      });
    });
  } catch {
    console.error(JSON.stringify({ code: "RUNTIME_DELIVERY_DEFERRED" }));
  }
}
export function registerRuntime(
  app: Hono<ApiEnv>,
  db: Database,
  pipeline?: RuntimeApiPort,
  mcp?: CapabilityEngine,
) {
  app.get("/v1/runs/:id", (c) =>
    db.withAccount(c.get("accountId"), async (client) => {
      const run = id(c.req.param("id")),
        row = (
          await client.query(
            `select r.id,r.dossier_id,r.role_id,r.mode,r.state,r.budget_cny::text,r.spent_cny::text,r.ended_at,b.phase,(coalesce(b.usage_uncertain,false) or exists(select 1 from os_usage u where u.run_id=r.id and u.cost_cny is null) or exists(select 1 from budget_hold h where h.id=b.hold_id and h.state='unpriced')) usage_unknown from run r left join os_binding b on b.account_id=r.account_id and b.run_id=r.id where r.id=$1`,
            [run],
          )
        ).rows[0];
      if (!row) throw denied();
      return c.json({
        id: row.id,
        dossierId: row.dossier_id,
        roleId: row.role_id,
        mode: row.mode,
        state: row.state,
        budgetCny: cny(row.budget_cny),
        spentCny: cny(row.spent_cny),
        endedAt: row.ended_at?.toISOString() ?? null,
        submissionPhase: row.phase ?? null,
        usageUnknown: row.usage_unknown ?? false,
      });
    }),
  );
  app.post("/v1/runs/:id/submit", async (c) => {
    const port = available(pipeline),
      run = id(c.req.param("id")),
      account = c.get("accountId");
    let created = false;
    const response = await mutate(c, db, Empty, async (client) => {
      await lockBudget(client, account);
      const row = (
        await client.query(
          "select r.dossier_id,r.role_id,r.state,r.ended_at,h.run_id,h.model_route from run r left join run_harness h on h.account_id=r.account_id and h.dossier_id=r.dossier_id and h.run_id=r.id where r.id=$1",
          [run],
        )
      ).rows[0];
      if (!row) throw denied();
      if (!row.run_id || !row.model_route)
        throw new ApiFailure(
          "HARNESS_SNAPSHOT_MISSING",
          409,
          "运行尚未绑定已确认的工作台与模型。",
        );
      if (
        row.ended_at !== null ||
        !["queued", "running", "waiting", "paused_budget"].includes(row.state)
      )
        throw new ApiFailure("RUN_NOT_ACTIVE", 409, "该运行已不能提交或恢复。");
      await appendEvent(client, account, {
        dossierId: row.dossier_id,
        runId: run,
        roleId: row.role_id,
        kind: "gate",
        action: "runtime_submit_requested",
        payload: { source: "explicit_user", status: "submission_requested" },
        dedupeKey: "runtime-submit-intent:" + run,
      });
      created = true;
      return {
        status: 202,
        body: { runId: run, status: "submission_requested" },
      };
    });
    if (created)
      try {
        await port.submit(account, run);
      } catch {
        await deferred(
          db,
          account,
          run,
          "runtime_submit_deferred",
          "SUBMISSION_DEFERRED",
        );
      }
    return response;
  });
  registerApprovalInbox(app, db);
  app.post("/v1/approvals/:id/decide", async (c) => {
    idem(c);
    const card = await decideInboxCard(c, db, mcp);
    if (card) return card;
    const port = available(pipeline),
      approval = id(c.req.param("id")),
      account = c.get("accountId");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiFailure("INVALID_INPUT", 400, "请求不是有效的JSON。");
    }
    const parsed = Decision.safeParse(raw);
    if (!parsed.success)
      throw new ApiFailure("INVALID_INPUT", 400, "决定参数无效。");
    await port.decisions.validate(account, approval, parsed.data);
    let run: string | undefined;
    const response = await mutate(c, db, Decision, async (client, input) => {
      const row = (
        await client.query("select run_id from approval where id=$1", [
          approval,
        ])
      ).rows[0];
      if (!row) throw denied();
      run = row.run_id;
      return {
        status: 202,
        body: json(
          await port.decisions.prepare(client, account, approval, input),
        ),
      };
    });
    try {
      await port.decisions.dispatch(account, approval);
    } catch {
      try {
        if (!run)
          run = await db.withAccount(
            account,
            async (client) =>
              (
                await client.query("select run_id from approval where id=$1", [
                  approval,
                ])
              ).rows[0]?.run_id,
          );
        if (run)
          await deferred(
            db,
            account,
            run,
            "runtime_decision_deferred",
            "DECISION_DEFERRED",
          );
      } catch {
        console.error(JSON.stringify({ code: "RUNTIME_DELIVERY_DEFERRED" }));
      }
    }

    return response;
  });
  app.post("/v1/runs/:id/cancel", async (c) => {
    const port = available(pipeline),
      run = id(c.req.param("id")),
      account = c.get("accountId");
    const response = await mutate(c, db, Empty, async (client) => {
      await lockBudget(client, account);
      const row = (
        await client.query(
          "select r.dossier_id,r.role_id,b.phase,b.receipt from run r left join os_binding b on b.account_id=r.account_id and b.run_id=r.id where r.id=$1",
          [run],
        )
      ).rows[0];
      if (!row) throw denied();
      if (row.phase !== "accepted" || !row.receipt)
        throw new ApiFailure(
          "CANCEL_NOT_READY",
          409,
          "运行尚无已接受的执行绑定。",
        );
      await appendEvent(client, account, {
        dossierId: row.dossier_id,
        runId: run,
        roleId: row.role_id,
        kind: "gate",
        action: "runtime_cancel_requested",
        payload: { source: "explicit_user" },
        dedupeKey: "runtime-cancel-intent:" + run,
      });
      return {
        status: 202,
        body: { runId: run, status: "cancellation_requested" },
      };
    });
    try {
      await port.decisions.cancel(account, run);
    } catch {
      await deferred(
        db,
        account,
        run,
        "runtime_cancel_deferred",
        "CANCELLATION_DEFERRED",
      );
    }
    return response;
  });
}
export function registerHarness(
  app: Hono<ApiEnv>,
  db: Database,
  harness: HarnessStore,
) {
  app.get("/v1/dossiers/:id/harness", async (c) => {
    const effective = await harness.effective(
        c.get("accountId"),
        id(c.req.param("id")),
      ),
      manifest = effective.manifest;
    const roles = Object.fromEntries(
      Object.entries(manifest.roles).map(([roleId, role]) => [
        roleId,
        {
          modelSlot: role.model_slot,
          steps: role.steps,
          tools: role.tools,
          writeTargets: role.write_targets,
          memory: role.memory,
        },
      ]),
    );
    return c.json({
      bench: manifest.id,
      version: manifest.version,
      digest: effective.digest,
      bundleDigest: effective.bundleDigest,
      registryHash: effective.registryHash,
      entrypoints: manifest.entrypoints,
      modelSlots: manifest.model_slots,
      budget: manifest.budget,
      roles,
    });
  });
  app.post("/v1/dossiers/:id/harness/patch", (c) =>
    mutate(c, db, BenchPatch, async (client, input) => ({
      status: 201,
      body: json(
        await harness.proposeClient(
          client,
          c.get("accountId"),
          id(c.req.param("id")),
          input,
          randomUUID(),
        ),
      ),
    })),
  );
  app.post("/v1/harness/proposals/:id/decide", (c) =>
    mutate(c, db, HarnessDecision, async (client, input) => ({
      status: 200,
      body: json(
        await harness.decideClient(
          client,
          c.get("accountId"),
          id(c.req.param("id")),
          input.decision,
        ),
      ),
    })),
  );
}
