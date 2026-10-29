import { registerSession, type SessionPort } from "./session";
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
import { registerKernelRuns } from "./kernel-runs";
import { registerApprovalInbox, decideInboxCard } from "./inbox-approvals";
import { registerKernelTools, type KernelToolCall } from "./kernel-tools";
import { pricingFromEnvironment, type PricingService } from "../budget/pricing";
import { monthlyBudgetSnapshot, currentPeriod } from "../budget";

export async function createApp(options: {
  pool: pg.Pool;
  session?: SessionPort;
  auth: JwtConfig;
  pricing?: PricingService;
  kernel?: import("../kernel/service").KernelService;
  kernelTools?: {
    auth: import("../kernel/auth").KernelAuth;
    dispatch: (call: KernelToolCall) => Promise<unknown>;
  };
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
    if (c.req.method === "DELETE")
      throw new ApiFailure("SCOPE_DENIED", 403, "危险删除操作不开放。");
    await next();
  });
  app.use("/internal/*", () => {
    throw new ApiFailure("SCOPE_DENIED", 403, "账户容器调用尚未通过验证。");
  });
  if (options.session) registerSession(app, options.session);
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/v1/me", async (c) =>
    database.withAccount(c.get("accountId"), async (client) => {
      const account = await client.query(
        "select id,display_name,monthly_budget_cny from account where id=$1",
        [c.get("accountId")],
      );
      if (!account.rowCount)
        throw new ApiFailure("ACCOUNT_NOT_READY", 404, "账户尚未完成初始化。");
      return c.json(
        AccountProfile.parse(
          JSON.parse(
            JSON.stringify({
              id: account.rows[0].id,
              displayName: account.rows[0].display_name,
              monthlyBudgetCny: Number(account.rows[0].monthly_budget_cny),
              budget: await monthlyBudgetSnapshot(client),
              // 本机只有新内核：不再有 OpenScience 机器状态。
              machine: null,
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
          "2.0.0",
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
              gates: [],
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
  registerApprovalInbox(app, database);
  app.post("/v1/approvals/:id/decide", async (c) => {
    const card = await decideInboxCard(c, database);
    if (card) return card;
    throw denied();
  });
  if (options.kernel) registerKernelRuns(app, { db: database, kernel: options.kernel });
  if (options.kernelTools)
    registerKernelTools(app, {
      auth: options.kernelTools.auth,
      db: database,
      now: () => Math.floor(Date.now() / 1000),
      dispatch: options.kernelTools.dispatch,
    });
  app.notFound((c) =>
    c.json({ code: "NOT_FOUND", message: "接口不存在。" }, 404),
  );
  app.onError((error, c) => {
    if (error instanceof ApiFailure)
      return c.json({ code: error.code, message: error.message }, error.status);
    console.error(
      JSON.stringify({
        code: "API_UNEXPECTED",
        path: c.req.path,
        message: String((error as Error)?.message ?? error).slice(0, 300),
      }),
    );
    return c.json(
      { code: "INTERNAL_ERROR", message: "服务暂时无法处理请求，请稍后重试。" },
      500,
    );
  });
  return app;
}
