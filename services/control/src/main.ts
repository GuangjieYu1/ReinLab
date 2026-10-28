import { runtimeConfiguration } from "./configuration";
import { pricingFromEnvironment } from "./budget/pricing";
import { paperHandlers } from "./mcp/papers";
import { homedir } from "node:os";
import path from "node:path";
import { ensureSigningKey } from "./mcp/token";
import { CapabilityAuthority } from "./mcp/authority";
import { CapabilityEngine } from "./mcp/engine";
import { dataHandlers } from "./mcp/data-handlers";
import { accountPort } from "./mcp/account-port";
import { serve } from "@hono/node-server";
import pg from "pg";
import nodeProcess from "node:process";
import { createApp } from "./api/app";
import { Database } from "./db/database";
import { provisionerFromEnvironment } from "./provisioner";
import { RuntimePipeline } from "./bridge/openscience/pipeline";
import { runtimePricingFromEnvironment } from "./bridge/openscience/pricing-environment";
import { startAuthProvisioner } from "./provisioner/auth-worker";
import { localPeakPricing } from "./model/peak-pricing";
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
const database = new Database(pool),
  mcpAccount = accountPort(database);
const authority = new CapabilityAuthority(
  database,
  await ensureSigningKey(
    config.REINLAB_MCP_SIGNING_KEY_FILE ??
      path.join(homedir(), ".config/reinlab/mcp/signing.pem"),
  ),
);
const mcp = new CapabilityEngine(authority, {
  ...mcpAccount.handlers,
  ...dataHandlers(database, mcpAccount.cardDeposit),
  ...paperHandlers(
    database,
    path.join(homedir(), ".local/state/reinlab/papers"),
    mcpAccount.deposit,
  ),
});
const pipeline = new RuntimePipeline(database, {
  realModels,
  pricingContext: realModels ? localPeakPricing() : runtimePricingFromEnvironment(config),
  cleanupCapabilities: async (account, run) => {
    await mcpAccount.cleanup(account, run);
  },
  prepareCapabilities: async (account, run) => {
    const token = await authority.issue(account, run);
    if (!config.REINLAB_CONTROL_URL)
      throw new Error("MCP_CONTROL_URL_REQUIRED");
    const modelGateway = await database.withAccount(
      account,
      async (c) =>
        (
          await c.query(
            "select role_options->>'modelGateway' enabled from os_binding where run_id=$1",
            [run],
          )
        ).rows[0]?.enabled === "true",
    );
    const clarify = await database.withAccount(
      account,
      async (c) =>
        (
          await c.query("select run_id from read_clarify_run where run_id=$1", [
            run,
          ])
        ).rowCount,
    );
    await mcpAccount.bootstrap(
      account,
      run,
      token,
      config.REINLAB_CONTROL_URL,
      modelGateway && realModels
        ? await authority.issueRuntimeModel(account, run, token)
        : clarify
          ? await authority.issueModel(account, run, token)
          : undefined,
    );
  },
});
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
    io: {
      mkdir: async (dir: string) => void (await mkdir(dir, { recursive: true, mode: 0o700 })),
      write: async (file: string, body: string, mode = 0o600) =>
        void (await writeFile(file, body, { mode })),
      remove: async (file: string) => void (await rm(file, { force: true })),
    },
  },
});
const app = await createApp({
  pool,
  session: config.SUPABASE_ANON_KEY
    ? { url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY,
        usernameAlias: config.PROVISIONER_DRIVER === 'docker'
          ? readLocalLoginAlias(path.join(path.dirname(nodeProcess.env.REINLAB_RUNTIME_CONFIG_FILE!), 'login-alias.env'))
          : undefined }
    : undefined,
  pricing: pricingFromEnvironment(config),
  pipeline,
  mcp,
  kernel,
  kernelTools: { auth: kernelAuth, dispatch: kernelDispatch },
  clarifyAuthorizationFile: config.REINLAB_CLARIFY_AUTHORIZATION_FILE,
  realModelsEnabled: realModels,
  auth: {
    issuer: config.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1",
    secret: config.SUPABASE_JWT_SECRET
      ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET)
      : undefined,
  },
});
if (realModels) {
  // The kernel's model egress: run token in, host-held key out. One usage row
  // per provider request; nothing else writes this request's usage.
  const providerKey = readRuntimeConfiguration(
    path.join(homedir(), ".config/reinlab/local.env"),
  ).DEEPSEEK_API_KEY;
  if (!providerKey || /[\r\n]/.test(providerKey))
    throw Error("LOCAL_MODEL_KEY_UNAVAILABLE");
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
const stopProvisioner = config.DATABASE_URL_PROVISIONER
  ? await startAuthProvisioner(
      config.DATABASE_URL_PROVISIONER,
      provisionerFromEnvironment(new Database(pool)),
    )
  : undefined;
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
      await pipeline.shutdown();
      await stopProvisioner?.();
      await closed;
    } finally {
      clearTimeout(force);
      await pool.end();
    }
  })().catch(() => {
    console.error(JSON.stringify({ code: "CONTROL_SHUTDOWN_FAILED" }));
    process.exitCode = 1;
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
