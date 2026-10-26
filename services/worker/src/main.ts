import pg from "pg";
import { HatchetClient } from "@hatchet-dev/typescript-sdk";
import { readRuntimeConfiguration } from "../../control/src/configuration";
import { Database } from "../../control/src/db/database";
import { RuntimePipeline } from "../../control/src/bridge/openscience/pipeline";
import { accountPort } from "../../control/src/mcp/account-port";
import { RecoveryDiscovery } from "./discovery";
import { recoveryWorkflows } from "./workflows";

let app: pg.Pool | undefined,
  discoveryPool: pg.Pool | undefined,
  pipeline: RuntimePipeline | undefined;
let worker: Awaited<ReturnType<HatchetClient["worker"]>> | undefined;
async function stop() {
  await worker?.stop();
  await pipeline?.shutdown();
  await app?.end();
  await discoveryPool?.end();
}
try {
  if (
    [
      "DEEPSEEK_API_KEY",
      "HATCHET_CLIENT_TOKEN",
      "DATABASE_URL_APP",
      "DATABASE_URL_DISCOVERY",
    ].some((k) => process.env[k])
  )
    throw Error();
  if (!process.env.REINLAB_WORKER_CONFIG_FILE) throw Error();
  const config = readRuntimeConfiguration(
    process.env.REINLAB_WORKER_CONFIG_FILE
  );
  const runtime = readRuntimeConfiguration(config.RUNTIME_CONFIG_FILE);
  const url = new URL(config.HATCHET_API_URL);
  if (
    url.origin !== config.HATCHET_API_URL ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^127\.0\.0\.1:[0-9]{1,5}$/.test(config.HATCHET_HOST_PORT)
  )
    throw Error();
  // Only a path enters process.env. Account resolver values remain in the strict private reader.
  process.env.REINLAB_RUNTIME_CONFIG_FILE = config.RUNTIME_CONFIG_FILE;
  app = new pg.Pool({ connectionString: runtime.DATABASE_URL_APP, max: 6 });
  discoveryPool = new pg.Pool({
    connectionString: config.DATABASE_URL_DISCOVERY,
    max: 2,
  });
  const db = new Database(app),
    discovery = new RecoveryDiscovery(discoveryPool);
  await db.assertSafeRole();
  await discovery.assertSafe();
  const port = accountPort(db);
  pipeline = new RuntimePipeline(db, {
    readOnlyRecovery: true,
    cleanupCapabilities: async (a, r) => {
      await port.cleanup(a, r);
    },
  });
  const safeLogger = () => ({
    debug() {},
    info() {},
    green() {},
    warn() {
      console.error(JSON.stringify({ code: "HATCHET_WARNING" }));
    },
    error() {
      console.error(JSON.stringify({ code: "HATCHET_ERROR" }));
    },
  });
  const hatchet = HatchetClient.init({
    token: config.HATCHET_TOKEN,
    tenant_id: config.HATCHET_TENANT_ID,
    host_port: config.HATCHET_HOST_PORT,
    api_url: config.HATCHET_API_URL,
    tls_config: { tls_strategy: "none" },
    log_level: "OFF",
    logger: safeLogger,
  });
  const tasks = recoveryWorkflows(hatchet, discovery, pipeline);
  worker = await hatchet.worker("reinlab-recovery", {
    workflows: Object.values(tasks),
    slots: 4,
    handleKill: false,
  });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (!stopping) {
        stopping = true;
        void stop().catch(() => {});
      }
    });
  const running = worker.start();
  void running.catch(() => {});
  await worker.waitUntilReady(30_000);
  console.log(
    JSON.stringify({ code: "RECOVERY_WORKER_READY", modelRequests: 0 })
  );
  const marker = process.argv.indexOf("--instance"), instance = process.argv[marker + 1];
  if (process.connected && process.send && marker >= 0 && /^[a-f0-9-]{36}$/.test(instance))
    process.send({ type: "reinlab.control.ready", instance, pid: process.pid, port: 0 });
  await running;
} catch {
  console.error(JSON.stringify({ code: "RECOVERY_WORKER_FAILED" }));
  await stop().catch(() => {});
  process.exitCode = 1;
}
