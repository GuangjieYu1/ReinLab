import { registerSession, type SessionPort } from "./session";
import {
  BrowserSessions,
  assertSameOriginWrite,
  requireAccount,
} from "./browser-session";
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
import { registerApprovalInbox, registerReports, decideInboxCard } from "./inbox-approvals";
import { registerDossierApi } from "./dossier-api";
import { publishOps, registerExploreApi } from "./explore-api";
import type { OpsOutcome } from "../explore/service";
import type { MapConfig } from "../explore/map-config";
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
  /** 地图公开配置（只含地图公开 key 与图层地址）。 */
  mapConfig?: () => MapConfig;
  /** 天气取数通道；缺省用真实 fetch。 */
  weatherTransport?: import("../explore/weather").WeatherTransport;
  /** 天气判断的模型通道；没有就只记录数据变化、不下结论。 */
  weatherJudge?: import("../explore/weather-judge").WeatherJudge;
  /** 参考图等文件的存放端口；没有就只记录资料、不存副本。 */
  exploreStorage?: import("../explore/refs").ExploreStorage;
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
  // 浏览器不再用 Bearer 认身份（越权入口整个去掉）。这里仍校验 JWT 配置：
  // 半套配置直接拒绝启动，不让它以「反正不用」的名义留在运行态。
  createVerifier(options.auth);
  const sessions = new BrowserSessions(options.pool);
  const app = new Hono<ApiEnv>();
  app.use("*", secureHeaders());
  const tooLarge = (c: any) =>
    c.json({ code: "PAYLOAD_TOO_LARGE", message: "请求内容过大。" }, 413);
  const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  // 参考图上传要能收几 MB 的图；其余接口仍然只收 1MB。
  const imageBody = bodyLimit({ maxSize: 8 * 1024 * 1024, onError: tooLarge });
  app.use("/v1/*", (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (c.req.method === "POST" && /^\/v1\/explore\/plans\/[^/]+\/refs$/.test(pathname))
      return imageBody(c, next);
    return smallBody(c, next);
  });
  app.use("/v1/*", async (c, next) => {
    // 全部业务接口（含 SSE）只认 HttpOnly 会话 Cookie；写操作另校验同源 + 防伪造头。
    c.set("accountId", await requireAccount(c, sessions));
    if (c.req.method !== "GET" && c.req.method !== "HEAD")
      assertSameOriginWrite(c);
    const exists = await database.withAccount(c.get("accountId"), (client) =>
      client.query("select id from account where id=$1", [c.get("accountId")]),
    );
    if (!exists.rowCount)
      throw new ApiFailure("ACCOUNT_NOT_READY", 404, "账户尚未完成初始化。");
    // 只放开这几种 DELETE：都是逻辑删除，不删原件。
    const pathname = new URL(c.req.url).pathname;
    if (
      c.req.method === "DELETE" &&
      !/^\/v1\/dossiers\/[^/]+\/artifacts\/[^/]+$/.test(pathname) &&
      !/^\/v1\/profiles\/[^/]+$/.test(pathname) &&
      !/^\/v1\/explore\/plans\/[^/]+\/refs\/[^/]+$/.test(pathname)
    )
      throw new ApiFailure("SCOPE_DENIED", 403, "危险删除操作不开放。");
    await next();
  });
  app.use("/internal/*", () => {
    throw new ApiFailure("SCOPE_DENIED", 403, "账户容器调用尚未通过验证。");
  });
  registerSession(app, { identity: options.session, sessions });
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
  registerApprovalInbox(app, database, options.kernel ? (id) => options.kernel!.isLive(id) : undefined);
  registerReports(app, database);
  registerDossierApi(app, database);
  registerExploreApi(app, database, {
    mapConfig: options.mapConfig,
    weatherTransport: options.weatherTransport,
    weatherJudge: options.weatherJudge,
    exploreStorage: options.exploreStorage,
  });
  app.post("/v1/approvals/:id/decide", async (c) => {
    let applied: OpsOutcome | null = null;
    const card = await decideInboxCard(
      c,
      database,
      (account, runId, prompt) => {
        // 回答之后接着跑同一段任务；失败不影响这次决定本身。
        void options.kernel?.resumeAfterAnswer(account, runId, prompt).catch(() => {});
      },
      // 计划修改卡批准后，事务提交完再推给页面。
      (outcome) => {
        applied = outcome;
      },
    );
    if (applied) publishOps(c.get("accountId"), applied);
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
      return c.json({ code: error.code, message: error.message, ...(error.extra ?? {}) }, error.status);
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
