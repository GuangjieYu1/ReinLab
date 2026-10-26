import { registerSession, type SessionPort } from "./session";
import { registerPromotions } from "./promotions";
import { registerMcp } from "../mcp/protocol";
import type { CapabilityEngine } from "../mcp/engine";
import {
  registerRuntime,
  registerHarness,
  type RuntimeApiPort,
} from "./runtime";
import { HarnessStore } from "../harness/store";
import { loadBenchBundle, loadToolRegistry } from "../harness/manifest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  DossierCreate,
  Dossier,
  AccountProfile,
  DossierDetail,
} from "@reinlab/contracts";
import { Database } from "../db/database";
import { createVerifier, type JwtConfig } from "./auth";
import { mutate, type ApiEnv } from "./context";
import { ApiFailure, denied } from "./errors";
import { registerLedger } from "./ledger";
import { registerReadView } from "./read-view";
import { registerReadClarify } from "./read-clarify";
import { registerClarifyModel, authorizedModelPort } from "../clarify/model";
import { registerRuntimeModel } from "../model/gateway";
import { localModelPort } from "../model/host-port";
import { registerGates } from "./gates";
import { registerBudget } from "./budget";
import { pricingFromEnvironment, type PricingService } from "../budget/pricing";
import { monthlyBudgetSnapshot, currentPeriod } from "../budget";

export async function createApp(options: {
  pool: pg.Pool;
  session?: SessionPort;
  auth: JwtConfig;
  pricing?: PricingService;
  harness?: HarnessStore;
  pipeline?: RuntimeApiPort;
  mcp?: CapabilityEngine;
  onRunQueued?: (accountId: string, runId: string) => Promise<void>;
  clarifyAuthorizationFile?: string;
  realModelsEnabled?: boolean;
  testOnlyRuntimeModelTransport?: (body: Buffer) => Promise<Response>;
  testOnlyClarifyModelTransport?: (body: Buffer) => Promise<Response>;
}) {
  if (
    ((options.testOnlyClarifyModelTransport ||
      options.testOnlyRuntimeModelTransport) &&
      process.env.NODE_ENV !== "test") ||
    (options.realModelsEnabled &&
      (process.env.CI || process.env.NODE_ENV === "test"))
  )
    throw new ApiFailure(
      "TEST_DEPENDENCY_FORBIDDEN",
      503,
      "模型fixture不可用于生产。",
    );
  const database = new Database(options.pool);
  await database.assertSafeRole();
  const registry = options.harness ? undefined : await loadToolRegistry();
  const harness =
    options.harness ??
    new HarnessStore(
      database,
      await loadBenchBundle({ benchId: "research", registry: registry! }),
      registry!,
    );
  const verify = createVerifier(options.auth);
  const app = new Hono<ApiEnv>();
  app.use("*", secureHeaders());
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json({ code: "PAYLOAD_TOO_LARGE", message: "请求内容过大。" }, 413),
    }),
  );
  app.use("/v1/*", async (c, next) => {
    c.set("accountId", await verify(c.req.header("Authorization")));
    const exists = await database.withAccount(c.get("accountId"), (client) =>
      client.query("select id from account where id=$1", [c.get("accountId")]),
    );
    if (!exists.rowCount)
      throw new ApiFailure("ACCOUNT_NOT_READY", 404, "账户尚未完成初始化。");
    const readOnlyView =
      c.req.query("view") === "read" ||
      /\/read-(state|events)$/.test(c.req.path);
    if (c.req.method === "GET" && options.pipeline && !readOnlyView)
      try {
        await options.pipeline.recoverAccount(c.get("accountId"));
      } catch {
        console.error(JSON.stringify({ code: "RUNTIME_RECOVERY_DEFERRED" }));
      }
    if (c.req.method === "DELETE")
      throw new ApiFailure("SCOPE_DENIED", 403, "危险删除操作不开放。");
    await next();
  });
  app.use("/internal/*", () => {
    throw new ApiFailure("SCOPE_DENIED", 403, "账户容器调用尚未通过验证。");
  });
  if (options.session) registerSession(app, options.session);
  app.get("/health", (c) => c.json({ status: "ok" }));
  registerReadView(app, database);
  app.get("/v1/me", async (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const account = await client.query(
        "select id,display_name,monthly_budget_cny from account where id=$1",
        [c.get("accountId")],
      );
      if (!account.rowCount)
        throw new ApiFailure("ACCOUNT_NOT_READY", 404, "账户尚未完成初始化。");
      const machine = await client.query(
        'select state,os_version as "osVersion",last_health_at as "lastHealthAt" from account_machine where account_id=$1',
        [c.get("accountId")],
      );
      return c.json(
        AccountProfile.parse(
          JSON.parse(
            JSON.stringify({
              id: account.rows[0].id,
              displayName: account.rows[0].display_name,
              monthlyBudgetCny: Number(account.rows[0].monthly_budget_cny),
              budget: await monthlyBudgetSnapshot(client),
              machine: machine.rows[0] ?? null,
            }),
          ),
        ),
      );
    }),
  );
  app.get("/v1/dossiers", async (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const result = await client.query(
        'select id,bench,title,created_at as "createdAt",archived_at as "archivedAt" from dossier where account_id=$1 order by created_at,id',
        [c.get("accountId")],
      );
      return c.json({
        items: result.rows.map((row) =>
          Dossier.parse(JSON.parse(JSON.stringify(row))),
        ),
      });
    }),
  );
  app.post("/v1/dossiers", (c) =>
    mutate(c, database, DossierCreate, async (client, input) => {
      const id = randomUUID();
      const result = await client.query(
        'insert into dossier(id,account_id,bench,title,workspace_path,bench_version) values($1,$2,$3,$4,$5,$6) returning id,bench,title,created_at as "createdAt"',
        [
          id,
          c.get("accountId"),
          input.bench,
          input.title,
          "/data/dossiers/" + id,
          harness.bundle.manifest.version,
        ],
      );
      return {
        status: 201,
        body: Dossier.parse(JSON.parse(JSON.stringify(result.rows[0]))),
      };
    }),
  );
  app.get("/v1/dossiers/:id", async (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const id = c.req.param("id");
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        throw denied();
      const dossier = await client.query(
        'select id,bench,title,created_at as "createdAt",archived_at as "archivedAt" from dossier where account_id=$1 and id=$2',
        [c.get("accountId"), id],
      );
      if (!dossier.rowCount) throw denied();
      const gates = await client.query(
        "select id,subject,state,revision from gate where dossier_id=$1",
        [id],
      );
      const runs = await client.query(
        'select id,mode,state,budget_cny as "budgetCny",spent_cny as "spentCny" from run where dossier_id=$1 order by created_at',
        [id],
      );
      const budget = await client.query(
        "select coalesce(sum(a.amount_cny),0) as allocated,coalesce(sum(a.spent_cny),0) as spent from budget_allocation a where a.dossier_id=$1 and a.period=$2 and(a.parent_id is null or not exists(select 1 from budget_allocation p where p.id=a.parent_id and p.dossier_id=$1))",
        [id, currentPeriod()],
      );
      return c.json(
        DossierDetail.parse(
          JSON.parse(
            JSON.stringify({
              dossier: dossier.rows[0],
              gates: gates.rows,
              activeRuns: runs.rows
                .filter(
                  (r) =>
                    !["completed", "failed", "cancelled"].includes(r.state),
                )
                .map((r) => ({
                  ...r,
                  budgetCny: Number(r.budgetCny),
                  spentCny: Number(r.spentCny),
                })),
              budget: {
                allocatedCny: Number(budget.rows[0].allocated),
                spentCny: Number(budget.rows[0].spent),
              },
            }),
          ),
        ),
      );
    }),
  );
  if (options.mcp) {
    app.use(
      "/mcp/*",
      bodyLimit({
        maxSize: 5 * 1024 * 1024,
        onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE" }, 413),
      }),
    );
    registerClarifyModel(
      app,
      options.mcp.authority,
      options.testOnlyClarifyModelTransport
        ? {
            async prepare() {
              return options.testOnlyClarifyModelTransport!;
            },
          }
        : authorizedModelPort(options.clarifyAuthorizationFile),
    );
    registerRuntimeModel(
      app,
      options.mcp.authority,
      options.testOnlyRuntimeModelTransport
        ? { prepare: async () => options.testOnlyRuntimeModelTransport! }
        : localModelPort(options.realModelsEnabled === true),
    );
    app.get("/mcp/clarify-candidates", async (c) => {
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1],
        a = await options.mcp!.authority.validate(token);
      if (a.claims.role !== "research-clarify" || !["1.2.0", "1.2.1"].includes(a.claims.version))
        throw denied();
      const requested = c.req.query('paperIds')?.split(',');
      if (requested && (!requested.length || requested.length>5 || new Set(requested).size!==requested.length || requested.some(id=>!/^W[0-9]{1,30}$/.test(id)))) throw denied();
      const rows = await database.withAccount(
        a.claims.account,
        async (client) =>
          (
            await client.query(
              "select distinct on(paper_id) paper_id,metadata from read_candidate where run_id=$1 and ($2::text[] is null or paper_id=any($2::text[])) order by paper_id,created_at desc limit 5",
              [a.claims.run,requested??null],
            )
          ).rows,
      );
      if (requested && rows.length!==requested.length) throw denied();
      if (requested) rows.sort((x,y)=>requested.indexOf(x.paper_id)-requested.indexOf(y.paper_id));
      return c.json({
        options: [
          ...rows.map((r) => ({
            label: r.paper_id,
            description: String(r.metadata.title).slice(0, 180),
          })),
          { label: "都不是", description: "请继续澄清，不替你选第一项。" },
        ],
      });
    });
    registerMcp(app, options.mcp);
  }
  registerPromotions(app, database);
  registerLedger(app, database);
  registerGates(app, database);
  registerBudget(
    app,
    database,
    options.pricing ?? pricingFromEnvironment(),
    harness,
    options.onRunQueued ??
      (options.pipeline
        ? async (account, run) => {
            await options.pipeline!.submit(account, run);
          }
        : undefined),
  );
  registerRuntime(app, database, options.pipeline, options.mcp);
  registerReadClarify(
    app,
    database,
    harness,
    options.pricing ?? pricingFromEnvironment(),
    options.pipeline,
    options.onRunQueued ??
      (options.pipeline
        ? async (account, run) => {
            await options.pipeline!.submit(account, run);
          }
        : undefined),
  );
  registerHarness(app, database, harness);
  app.notFound((c) =>
    c.json({ code: "NOT_FOUND", message: "接口不存在。" }, 404),
  );
  app.onError((error, c) => {
    if (error instanceof ApiFailure)
      return c.json({ code: error.code, message: error.message }, error.status);
    return c.json(
      { code: "INTERNAL_ERROR", message: "服务暂时无法处理请求，请稍后重试。" },
      500,
    );
  });
  return app;
}
