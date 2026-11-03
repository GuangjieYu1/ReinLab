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
import { registerSwarmApi } from "./swarm-api";
import { registerApprovalInbox, registerReports, decideInboxCard } from "./inbox-approvals";
import { registerDossierApi } from "./dossier-api";
import { publishOps, registerExploreApi } from "./explore-api";
import { createUploads, type Uploads } from "../explore/uploads";
import { localPhotoStore, type PhotoStore } from "../explore/photo-store";
import { publishAccountEvent } from "../dossier/service";
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
  /** 群研的研究服务；没有就整个群研读写面不挂。 */
  swarm?: import("../swarm/service").SwarmService;
  kernelTools?: {
    auth: import("../kernel/auth").KernelAuth;
    dispatch: (call: KernelToolCall) => Promise<unknown>;
    bookEngine?: (account: string, dossier: string, plan: import("../explore/book-job").BookPlan) => void;
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
  /** 中文 PDF 用的字体文件。 */
  pdfFontFile?: string;
  /** 离线包代取瓦片/字形的取数通道；缺省真实 fetch，测试可注入。 */
  offlineFetch?: import("../explore/offline").OfflineFetch;
  /** 照片存放根目录（通常是 kernelHome）；没给也没有 photoStore 时上传明确不可用。 */
  photoRoot?: string;
  /** 照片存放端口；测试注入临时目录更方便。 */
  photoStore?: PhotoStore;
  /** 档案所在磁盘剩余字节；缺省按未知处理（空间检查照实说不够）。 */
  photoFreeBytes?: () => Promise<number>;
  /** 读图结论的模型通道（回顾看片）；没有就只能给统计提示。 */
  photoReader?: import("../explore/photo-reader").PhotoReader;
  /** 看图的峰值费率（每百万 token 人民币）；没配就只记用量、不估价。 */
  reviewPricing?: { inputPerMillion: number; outputPerMillion: number };
  /** 建筑场景缓存与 Overpass / 高程取数通道（B4）。 */
  sceneStore?: import("../explore/scene").SceneStore;
  overpass?: import("../explore/scene").OverpassTransport;
  elevation?: import("../explore/terrain").ElevationTransport;
  /** 网图抓取通道；缺省用真实 fetch，测试可注入。 */
  refTransport?: import("../explore/refs").WeatherLikeTransport;
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
  // 照片续传是分块流式接收：tus 自己按 8 MB 分片处理，这里不能再按整包截断。
  const isUploadsPath = (pathname: string) => /^\/v1\/explore\/uploads(\/|$)/.test(pathname);
  // 参考图、计划书地图快照（自身上限 4 MB）要能收几 MB 的图；其余接口仍然只收 1MB。
  const imageBody = bodyLimit({ maxSize: 8 * 1024 * 1024, onError: tooLarge });
  app.use("/v1/*", (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (isUploadsPath(pathname)) return next();
    if (c.req.method === "POST" && /^\/v1\/explore\/plans\/[^/]+\/(refs|snapshots)$/.test(pathname))
      return imageBody(c, next);
    return smallBody(c, next);
  });
  app.use("/v1/*", async (c, next) => {
    // 全部业务接口（含 SSE）只认 HttpOnly 会话 Cookie；写操作另校验同源 + 防伪造头。
    const pathname0 = new URL(c.req.url).pathname;
    c.set("accountId", await requireAccount(c, sessions));
    // 上传走 tus：Origin 由浏览器决定，改由 tus 钩子校验会话 + X-ReinLab-CSRF。
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !isUploadsPath(pathname0))
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
      !/^\/v1\/explore\/plans\/[^/]+\/refs\/[^/]+$/.test(pathname) &&
      !/^\/v1\/explore\/plans\/[^/]+\/photos\/[^/]+$/.test(pathname)
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
  // 照片目录：默认由宿主给根目录，测试可以直接注入一个临时目录。
  const photoStore = options.photoStore ?? (options.photoRoot ? localPhotoStore(options.photoRoot) : undefined);
  let uploads: Uploads | null = null;
  if (photoStore)
    uploads = createUploads({
      db: database,
      sessions,
      store: photoStore,
      deps: {
        store: photoStore,
        ...(options.photoFreeBytes ? { freeBytes: options.photoFreeBytes } : {}),
      },
      publish: (account, event) => publishAccountEvent(account, "exploration", event as never),
    });
  if (uploads)
    for (const path of ["/v1/explore/uploads", "/v1/explore/uploads/*"] as const)
      app.all(path, (c) => uploads!.handle(c.req.raw));

  registerExploreApi(app, database, {
    mapConfig: options.mapConfig,
    ...(options.sceneStore ? { sceneStore: options.sceneStore } : {}),
    ...(options.overpass ? { overpass: options.overpass } : {}),
    ...(options.elevation ? { elevation: options.elevation } : {}),
    ...(photoStore ? { photoStore } : {}),
    ...(options.photoFreeBytes ? { photoFreeBytes: options.photoFreeBytes } : {}),
    weatherTransport: options.weatherTransport,
    weatherJudge: options.weatherJudge,
    exploreStorage: options.exploreStorage,
    pdfFontFile: options.pdfFontFile,
    offlineFetch: options.offlineFetch,
  });
  app.post("/v1/approvals/:id/decide", async (c) => {
    // 群研的四张卡由群研服务自己处理：它要改运行状态，并在事务外把负责人续起来。
    if (options.swarm) {
      const body = (await c.req.json().catch(() => ({}))) as {
        decision?: unknown;
        answers?: unknown;
      };
      const handled = await options.swarm.decideCard(
        c.get("accountId"),
        c.req.param("id"),
        body,
      );
      if (handled) return c.json({ state: handled.state, runId: handled.runId, note: handled.note });
    }
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
  if (options.kernel)
    registerKernelRuns(app, {
      db: database,
      kernel: options.kernel,
      ...(options.swarm ? { swarm: options.swarm } : {}),
    });
  if (options.swarm) registerSwarmApi(app, { db: database, swarm: options.swarm });
  if (options.kernelTools)
    registerKernelTools(app, {
      auth: options.kernelTools.auth,
      db: database,
      now: () => Math.floor(Date.now() / 1000),
      dispatch: options.kernelTools.dispatch,
      // 用户插话不走工具返回（模型会当注入拒掉）：改走 DSH 原生收件箱，见 swarm/service.deliverToInbox。
      ...(options.kernelTools.bookEngine ? { bookEngine: options.kernelTools.bookEngine } : {}),
      // 网图入档和页面上传用同一个存放目录。
      ...(options.exploreStorage ? { exploreStorage: options.exploreStorage } : {}),
      ...(options.refTransport ? { refTransport: options.refTransport } : {}),
      ...(options.photoReader ? { photoReader: options.photoReader } : {}),
      ...(photoStore ? { photoStore } : {}),
      ...(options.reviewPricing ? { reviewPricing: options.reviewPricing } : {}),
      // 白模 / 楼影工具：同一份场景缓存与取数通道。
      lightOptions: {
        db: database,
        ...(options.sceneStore ? { sceneStore: options.sceneStore } : {}),
        ...(options.overpass ? { overpass: options.overpass } : {}),
        ...(options.elevation ? { elevation: options.elevation } : {}),
        publish: (account: string, event: Record<string, unknown>) =>
          publishAccountEvent(account, "exploration", event as never),
      },
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
