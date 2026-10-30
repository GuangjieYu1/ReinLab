import { runtimeConfiguration } from "./configuration";
import { pricingFromEnvironment } from "./budget/pricing";
import { homedir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import pg from "pg";
import nodeProcess from "node:process";
import { createApp } from "./api/app";
import { Database } from "./db/database";
import { readLocalLoginAlias } from "./local-login";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { ensureKernelAuth } from "./kernel/auth";
import { KernelService } from "./kernel/service";
import { createHarnessFactory, resolveDshModule } from "./kernel/dsh/harness";
import { localAccountPort } from "./kernel/local-account";
import { createKernelDispatch } from "./kernel/dispatch";
import { registerWebToolsProxy } from "./model/web-tools-proxy";
import { registerMessagesProxy } from "./model/messages-proxy";
import { recordUsage } from "./run/usage";
import { readRuntimeConfiguration } from "./configuration";
import { mapConfigFrom } from "./explore/map-config";
import { localExploreStorage } from "./explore/storage";
import { configureGeoProviders } from "./explore/providers";
import { generateBook } from "./explore/book-job";
import { createWeatherJudge } from "./explore/weather-judge";
import { createWeatherScheduler } from "./explore/schedule";
import { runWeatherCheck } from "./explore/weather-check";
import { publishAccountEvent } from "./dossier/service";

// dsh will not boot inside Electron. The local stack entry sets
// REINLAB_LOCAL_STACK=1 so this fails fast with a readable reason, while tests
// that import this module are unaffected.
if (
  process.env.REINLAB_LOCAL_STACK === "1" &&
  (process.versions as { electron?: string }).electron
)
  throw new Error("CONTROL_ELECTRON_RUNTIME_FORBIDDEN");
const config = runtimeConfiguration();
const realModels = config.REINLAB_REAL_MODELS_ENABLED === "1";
if (
  realModels &&
  (process.env.CI ||
    process.env.NODE_ENV === "test" ||
    process.env.DEEPSEEK_API_KEY)
)
  throw Error("LOCAL_REAL_MODELS_FORBIDDEN");
if (
  !process.env.REINLAB_RUNTIME_CONFIG_FILE ||
  !config.DATABASE_URL_APP ||
  !config.SUPABASE_URL
)
  throw new Error("CONFIG_MISSING: 需要应用数据库连接与Supabase地址");
const pool = new pg.Pool({
  connectionString: config.DATABASE_URL_APP,
  max: 10,
});
const database = new Database(pool);
const kernelHome =
  config.REINLAB_KERNEL_HOME ?? path.join(homedir(), ".local/state/reinlab/kernel");
const kernelAuth = await ensureKernelAuth(
  config.REINLAB_KERNEL_SIGNING_KEY_FILE ??
    path.join(homedir(), ".config/reinlab/mcp/kernel.pem"),
);
const kernelAccount = localAccountPort(kernelHome);
const kernelDispatch = createKernelDispatch({
  db: database,
  cacheRoot: path.join(homedir(), ".local/state/reinlab/papers"),
  deposit: kernelAccount.deposit,
  cardDeposit: kernelAccount.cardDeposit,
  // 工作区登记论文要用它定位当前档案的工作区目录。
  kernelHome,
});
const kernel = new KernelService({
  db: database,
  auth: kernelAuth,
  factory: createHarnessFactory(),
  model: config.REINLAB_KERNEL_MODEL ?? "deepseek-v4-flash",
  controlUrl: config.REINLAB_CONTROL_URL ?? "",
  maxTokens: Number(config.REINLAB_KERNEL_MAX_TOKENS ?? 32768),
  layout: {
    home: kernelHome,
    shimModule: path.resolve("services/control/src/kernel/dsh/shim.mjs"),
    shimContainerModule: "/opt/reinlab/shim.mjs",
    dshModule: resolveDshModule(),
    restrictPatch: path.resolve("plugins/reinlab-read-plugin/restrict.patch.yml"),
    pluginEntry:
      "file://" + path.resolve("plugins/reinlab-read-plugin/index.js"),
    shimMode: config.REINLAB_KERNEL_TRANSPORT === "container" ? "docker" : "host",
    // 容器模式：dsh 跑在每账户容器里，挂载与凭据边界由 container.ts 的规格约束。
    ...(config.REINLAB_KERNEL_TRANSPORT === "container"
      ? {
          container: {
            image: config.REINLAB_ACCOUNT_IMAGE ?? "reinlab-account:local",
            home: "/opt/reinlab-account",
            dshHome: "/opt/reinlab-account/dsh-home",
            // 与宿主 <home>/accounts/<account>/dossiers 对应（账户卷挂到 /opt/reinlab-account）。
            workspace: "/opt/reinlab-account/dossiers",
            dshModule: "/opt/reinlab/node_modules/@deepseek-ai/dsh/lib/bin.js",
            pluginEntry: "file:///opt/reinlab/plugins/reinlab-read-plugin/index.js",
            // 容器模式基础工具全开：只禁自派生 agent 的工具。
            restrictPatch: "/opt/reinlab/plugins/reinlab-read-plugin/container.patch.yml",
          },
        }
      : {}),
    io: {
      mkdir: async (dir: string) => void (await mkdir(dir, { recursive: true, mode: 0o700 })),
      write: async (file: string, body: string, mode = 0o600) =>
        void (await writeFile(file, body, { mode })),
      remove: async (file: string) => void (await rm(file, { force: true })),
    },
  },
});
// 天气判断用的模型通道：和内核同一条 Anthropic 兼容入口，宿主自己带 key 调。
const localSecrets = realModels
  ? readRuntimeConfiguration(path.join(homedir(), ".config/reinlab/local.env"))
  : undefined;
const providerKey = localSecrets?.DEEPSEEK_API_KEY;
if (realModels && (!providerKey || /[\r\n]/.test(providerKey)))
  throw Error("LOCAL_MODEL_KEY_UNAVAILABLE");
const weatherJudge = providerKey
  ? createWeatherJudge({
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: providerKey,
      model: config.REINLAB_WEATHER_JUDGE_MODEL ?? config.REINLAB_KERNEL_MODEL ?? "deepseek-v4-flash",
      provider: "deepseek-official",
    })
  : undefined;

// 地点搜索与步行路线：国内高德、海外 ORS。密钥只在进程里，不发给浏览器。
configureGeoProviders({
  amapKey: config.AMAP_KEY ?? null,
  orsKey: config.ORS_KEY ?? null,
  ...(config.ORS_BASE_URL ? { orsBaseUrl: config.ORS_BASE_URL } : {}),
});

const exploreStorage = localExploreStorage(kernelHome);
const pdfFontFile = config.REINLAB_PDF_FONT_FILE;
/** 助手要求生成计划书时用它点火：和页面按钮走同一套排版与存放。 */
const bookEngine = (account: string, dossier: string, plan: import("./explore/book-job").BookPlan) => {
  void generateBook(
    {
      db: database,
      storage: exploreStorage,
      fontFile: pdfFontFile,
      publish: (target, event) => publishAccountEvent(target, "exploration", event),
    },
    { account, dossier, plan },
  );
};

const app = await createApp({
  pool,
  session: config.SUPABASE_ANON_KEY
    ? { url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY,
        usernameAlias: config.PROVISIONER_DRIVER === 'docker'
          ? readLocalLoginAlias(path.join(path.dirname(nodeProcess.env.REINLAB_RUNTIME_CONFIG_FILE!), 'login-alias.env'))
          : undefined }
    : undefined,
  pricing: pricingFromEnvironment(config),
  // 只下发地图公开 key 与图层地址；其余服务凭据不出进程。
  mapConfig: () => mapConfigFrom(config),
  kernel,
  // 网图入档用的是同一个存放目录（createApp 里的 exploreStorage）。
  kernelTools: { auth: kernelAuth, dispatch: kernelDispatch, bookEngine },
  weatherJudge,
  // 参考图、以后的计划书 PDF 都存在档案自己的目录下。
  exploreStorage,
  // 中文 PDF 用的开源黑体；可用 REINLAB_PDF_FONT_FILE 指到别处。
  pdfFontFile,
  realModelsEnabled: realModels,
  auth: {
    issuer: config.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1",
    secret: config.SUPABASE_JWT_SECRET
      ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET)
      : undefined,
  },
});
if (realModels && providerKey) {
  // The kernel's model egress: run token in, host-held key out. One usage row
  // per provider request; nothing else writes this request's usage.
  registerMessagesProxy(app, {
    auth: kernelAuth,
    forward: (request: Request) => fetch(request, { redirect: "error" }),
    record: async (usage) => {
      // Cost from the configured per-million rates; without rates it stays
      // unknown instead of inventing a number.
      const inRate = Number(config.MODEL_INPUT_CNY_PER_MILLION ?? Number.NaN);
      const outRate = Number(config.MODEL_OUTPUT_CNY_PER_MILLION ?? Number.NaN);
      let cost: string | null = usage.costCny ?? null;
      if (
        cost === null &&
        usage.known &&
        Number.isFinite(inRate) &&
        Number.isFinite(outRate) &&
        usage.inputTokens !== null &&
        usage.outputTokens !== null
      )
        cost = (
          (usage.inputTokens * inRate + usage.outputTokens * outRate) /
          1_000_000
        ).toFixed(6);
      await database.withAccount(usage.account, (client) =>
        recordUsage(client, { ...usage, reasoningTokens: null, costCny: cost }),
      );
    },
    now: () => Math.floor(Date.now() / 1000),
    providerBaseUrl: "https://api.deepseek.com/anthropic",
    providerKey,
  });
  // DeepSeek Search / Fetch API：内核的 web_search / web_fetch 走这里，宿主密钥不外发。
  registerWebToolsProxy(app, {
    auth: kernelAuth,
    now: () => Math.floor(Date.now() / 1000),
    providerBaseUrl: "https://api.deepseek.com",
    providerKey,
    feeCny: config.DEEPSEEK_WEB_FEE_CNY ?? "0.005000",
    forward: (request: Request) => fetch(request, { redirect: "error" }),
    record: async (usage) => {
      await database.withAccount(usage.account, (client) => recordUsage(client, usage));
    },
  });
}
const server = serve(
  {
    fetch: app.fetch,
    port: Number(config.PORT ?? 3001),
    hostname: "0.0.0.0",
  },
  (info) => {
    console.log(JSON.stringify({ code: "CONTROL_READY", port: info.port }));
    const marker = process.argv.indexOf("--instance"),
      instance = marker < 0 ? undefined : process.argv[marker + 1];
    if (
      nodeProcess.connected &&
      nodeProcess.send &&
      instance &&
      /^[a-f0-9-]{36}$/.test(instance)
    )
      nodeProcess.send(
        {
          type: "reinlab.control.ready",
          pid: process.pid,
          instance,
          port: info.port,
        },
        () => {},
      );
  },
);
// 待执行计划的天气监测：账户时区 08/16/23，服务停过就补一次。
// 只在真实模式开——它要真实取预报、真实调判断模型（用量记到那份计划上）。
const weatherScheduler =
  realModels && weatherJudge
    ? createWeatherScheduler({
        db: database,
        log: (event) => console.log(JSON.stringify(event)),
        runCheck: async (account, dossier, when) => {
          const outcome = await database.withAccount(account, (client) =>
            runWeatherCheck(client, account, dossier, { judge: weatherJudge, now: when }),
          );
          publishAccountEvent(account, "exploration", outcome.event);
        },
      })
    : undefined;

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  if (
    "closeIdleConnections" in server &&
    typeof server.closeIdleConnections === "function"
  )
    server.closeIdleConnections();
  const force = setTimeout(() => {
    if (
      "closeAllConnections" in server &&
      typeof server.closeAllConnections === "function"
    )
      server.closeAllConnections();
  }, 1000);
  force.unref();
  void (async () => {
    try {
      await closed;
    } finally {
      clearTimeout(force);
      weatherScheduler?.stop();
      await pool.end();
    }
  })().catch(() => {
    console.error(JSON.stringify({ code: "CONTROL_SHUTDOWN_FAILED" }));
    process.exitCode = 1;
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
