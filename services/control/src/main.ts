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

const config = runtimeConfiguration();
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
  pricingContext: runtimePricingFromEnvironment(config),
  cleanupCapabilities: async (account, run) => {
    await mcpAccount.cleanup(account, run);
  },
  prepareCapabilities: async (account, run) => {
    const token = await authority.issue(account, run);
    if (!config.REINLAB_CONTROL_URL)
      throw new Error("MCP_CONTROL_URL_REQUIRED");
    await mcpAccount.bootstrap(account, run, token, config.REINLAB_CONTROL_URL);
  },
});
const app = await createApp({
  pool,
  session: config.SUPABASE_ANON_KEY
    ? { url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY }
    : undefined,
  pricing: pricingFromEnvironment(config),
  pipeline,
  mcp,
  auth: {
    issuer: config.SUPABASE_URL.replace(/\/$/, "") + "/auth/v1",
    secret: config.SUPABASE_JWT_SECRET
      ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET)
      : undefined,
  },
});
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
