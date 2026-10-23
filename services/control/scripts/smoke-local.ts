import { readRuntimeConfiguration } from "../src/configuration";
import assert from "node:assert/strict";
import { cleanupSmoke } from "../../../tooling/local/smoke-cleanup";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getuid } from "node:process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import pg from "pg";
import { readPrivateEnv, writePrivateEnv } from "../../../tooling/local/config";
import { localPaths } from "../../../tooling/local/paths";
import { authenticateVerificationUser } from "../../../tooling/local/verification-auth";
import { quietCommand } from "../../../tooling/local/process";
import { smokePlan, smokeAuthorization } from "../../../tooling/local/smoke-plan";
import {
  startOneShotSmokeGuard,
  type OneShotSmokeGuard,
} from "../../../tooling/local/one-shot-smoke-guard";
import { Database } from "../src/db/database";
import { createApp } from "../src/api/app";
import { RuntimePipeline } from "../src/bridge/openscience/pipeline";
import { createProductionRuntimeFactory } from "../src/bridge/openscience/production-factory";
import type { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { HarnessStore } from "../src/harness/store";
import { materializeHarnessRole } from "../src/harness/materialize";

// Explicit CLI only. No real-model path is imported by a test or a CI job.
const paths = localPaths();
let privateDirectory = join(paths.state, "p110-one-shot"),
  marker = join(privateDirectory, "model-forwarded.marker");
let pool: pg.Pool | undefined,
  pipeline: RuntimePipeline | undefined,
  guard: OneShotSmokeGuard | undefined,
  runtime: RoleRuntime | undefined,
  server: ReturnType<typeof serve> | undefined;
const report: Record<string, unknown> = {
  realInfrastructure: true,
  realModel: true,
  startedAt: new Date().toISOString(),
  budgetCny: 1,
  completed: false,
  providerInvoiceReconciled: false,
};
const evidence =
  process.env.REINLAB_EVIDENCE_OUT ??
  join(paths.state, "p110-smoke-evidence-" + Date.now());
let stage = "plan";
async function captureEvidence() {
  if (
    !pool ||
    typeof report.accountId !== "string" ||
    report.evidenceCaptured === true
  )
    return;
  const accountId = report.accountId;
  const runId =
    typeof report.runId === "string"
      ? report.runId
      : typeof report.estimateId === "string"
        ? await new Database(pool).withAccount(
            accountId,
            async (c) =>
              (
                await c.query("select id from run where estimate_id=$1", [
                  report.estimateId,
                ])
              ).rows[0]?.id,
          )
        : undefined;
  if (!runId) return;
  report.runId = runId;
  const detail = await new Database(pool).withAccount(accountId, async (c) => ({
    binding: (
      await c.query(
        "select session_id,request_id,phase,cursor,receipt,pricing_context,usage_uncertain from os_binding where run_id=$1",
        [runId],
      )
    ).rows[0],
    usage: (
      await c.query(
        "select part_id,message_id,cost_cny::text,metadata from os_usage where run_id=$1",
        [runId],
      )
    ).rows,
    events: (
      await c.query(
        "select seq,at,kind,action,risk,cost_cny::text,payload from event where run_id=$1 order by seq",
        [runId],
      )
    ).rows,
    holds: (
      await c.query(
        "select state,maximum_cny::text,actual_cny::text from budget_hold where run_id=$1",
        [runId],
      )
    ).rows,
  }));
  Object.assign(report, detail);
  report.evidenceCaptured = true;
  report.run = await new Database(pool).withAccount(
    accountId,
    async (c) =>
      (
        await c.query(
          "select state,ended_at,spent_cny::text from run where id=$1",
          [runId],
        )
      ).rows[0],
  );
  return detail;
}

try {
  assert.notEqual(process.env.NODE_ENV, "test");
  const [currency, window, validFrom, validUntil, authorization, ...extra] =
    process.argv.slice(2);
  assert.equal(extra.length, 0);
  const attempt = smokeAuthorization(authorization);
  privateDirectory = join(paths.state, attempt.directory);
  marker = join(privateDirectory, "model-forwarded.marker");
  report.authorization = { id: attempt.id, label: attempt.label };
  const plan = smokePlan(
    { currency, window, validFrom, validUntil },
    Date.now(),
  );
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const dir = await lstat(privateDirectory);
  assert.equal(
    dir.isDirectory() &&
      !dir.isSymbolicLink() &&
      (dir.mode & 0o777) === 0o700 &&
      dir.uid === getuid?.(),
    true,
  );
  try {
    await lstat(marker);
    throw Error("SMOKE_ALREADY_CONSUMED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Keep the earlier zero-forward failure's identity/admission intact. The
  // shared model-forwarded.marker above remains the sole paid-call authority.
  const admissionFile = join(privateDirectory, "admission.env");
  let admission: Record<string, string> = {};
  try {
    admission = await readPrivateEnv(admissionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assert.equal(admission.RUN_KEY, undefined);
  const env = readRuntimeConfiguration(paths.runtime);
  assert.equal(env.PROVISIONER_DRIVER, "docker");
  assert.equal(env.SUPABASE_URL, "http://127.0.0.1:54321");
  for (const key of [
    "MODEL_ROUTE_CHEAP",
    "MODEL_ROUTE_MID",
    "MODEL_ROUTE_STRONG",
  ])
    assert.equal(env[key], plan.model);
  assert.equal(env.MODEL_USD_CNY_RATE, "7.2");
  process.env.REINLAB_RUNTIME_CONFIG_FILE = paths.runtime;
  pool = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 5 });
  const db = new Database(pool);
  await db.assertSafeRole();
  stage = "dedicated-auth";
  const identityFile = join(privateDirectory, "identity.env");
  let identity: Record<string, string> = {};
  try {
    identity = await readPrivateEnv(identityFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  identity.EMAIL ??= "local-" + randomUUID() + "@reinlab.invalid";
  identity.PASSWORD ??= randomBytes(32).toString("base64url");
  await writePrivateEnv(identityFile, identity);
  const session = await authenticateVerificationUser(
    { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY },
    {
      email: identity.EMAIL,
      password: identity.PASSWORD,
      registered: identity.REGISTERED === "true",
    },
  );
  identity.REGISTERED = "true";
  identity.ACCOUNT_ID = session.id;
  await writePrivateEnv(identityFile, identity);
  report.accountId = session.id;
  stage = "provision";
  let ready = false;
  for (const deadline = Date.now() + 240000; Date.now() < deadline; ) {
    const machine = await db.withAccount(
      session.id,
      async (c) =>
        (
          await c.query(
            "select state,os_version,image from account_machine where account_id=$1",
            [session.id],
          )
        ).rows[0],
    );
    if (machine?.state === "ready") {
      assert.equal(machine.os_version, "2.0.150");
      assert.equal(machine.image, env.ACCOUNT_IMAGE);
      ready = true;
      break;
    }
    await delay(1000);
  }
  assert.equal(ready, true);
  const registry = await loadToolRegistry(),
    bundle = await loadBenchBundle({ benchId: "research", registry }),
    harness = new HarnessStore(db, bundle, registry);
  pipeline = new RuntimePipeline(db, { pricingContext: plan.pricingContext });
  const app = await createApp({
    pool,
    auth: { issuer: env.SUPABASE_URL + "/auth/v1" },
    harness,
    pipeline,
  });
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((done) =>
    server!.listening ? done() : server!.once("listening", done),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const api = async (path: string, body?: unknown, key?: string) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + session.token,
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": key ?? randomUUID(),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    });
    const parsed = (await response.json()) as Record<string, any>;
    if (!response.ok) throw Error("SMOKE_HTTP_" + response.status);
    return parsed;
  };
  stage = "dossier";
  if (!identity.DOSSIER_ID) {
    identity.DOSSIER_KEY ??= randomUUID();
    await writePrivateEnv(identityFile, identity);
    const dossier = await api(
      "/v1/dossiers",
      { bench: "research", title: "P1-10 单次真实链路冒烟" },
      identity.DOSSIER_KEY,
    );
    identity.DOSSIER_ID = dossier.id;
    await writePrivateEnv(identityFile, identity);
  }
  report.dossierId = identity.DOSSIER_ID;
  const effective = await harness.effective(session.id, identity.DOSSIER_ID),
    roleId = effective.manifest.entrypoints.read;
  const role = materializeHarnessRole(effective, registry, {
    dossierId: identity.DOSSIER_ID,
    roleId,
    modelRoutes: { cheap: plan.model, mid: plan.model, strong: plan.model },
    memory: "",
    maxSteps: plan.maxSteps,
  });
  runtime = await createProductionRuntimeFactory(db)(session.id, role);
  stage = "estimate";
  const quote = await api("/v1/runs/estimate", {
    dossierId: identity.DOSSIER_ID,
    mode: "read",
  });
  assert.equal(quote.model, plan.model);
  stage = "guard";
  const secrets = await readPrivateEnv(
    join(homedir(), ".config/reinlab/local.env"),
  );
  assert.ok(secrets.DEEPSEEK_API_KEY);
  const temporaryToken = randomBytes(32).toString("base64url");
  guard = await startOneShotSmokeGuard({
    bindHost: "127.0.0.1",
    incomingToken: temporaryToken,
    upstreamKey: secrets.DEEPSEEK_API_KEY,
    markerPath: marker,
  });
  // Reachability test has no Authorization header and cannot consume the marker.
  const machine = "rl-" + session.id.replaceAll("-", "");
  assert.equal(
    await quietCommand(
      "docker",
      [
        "exec",
        "--user",
        "1000:1000",
        machine,
        "node",
        "--input-type=module",
        "-e",
        "const r=await fetch(process.argv[1],{signal:AbortSignal.timeout(5000)});process.stdout.write(String(r.status));await r.body?.cancel();",
        "http://host.docker.internal:" + guard.port + "/guard-preflight",
      ],
      {
        env: { PATH: process.env.PATH, DOCKER_HOST: env.DOCKER_HOST },
        timeoutMs: 10000,
      },
    ),
    "401",
  );
  stage = "temporary-config";
  await runtime.configureSmokeGateway({
    origin: "http://host.docker.internal:" + guard.port,
    token: temporaryToken,
  });
  smokePlan({ currency, window, validFrom, validUntil }, Date.now());
  // A saved explicit admission intent precedes HTTP/model activity. Never mint a
  // replacement if an earlier invocation saved a run intent or consumed marker.
  assert.equal(admission.RUN_KEY, undefined);
  admission.RUN_KEY = randomUUID();
  admission.ESTIMATE_ID = quote.id;
  report.estimateId = quote.id;
  await writePrivateEnv(admissionFile, admission);
  stage = "one-confirmation";
  report.submittedAt = new Date().toISOString();
  const run = await api(
    "/v1/runs",
    {
      dossierId: identity.DOSSIER_ID,
      mode: "read",
      roleId,
      budget: { cny: plan.budgetCny },
      estimateId: quote.id,
      confirmed: true,
      input: {
        question:
          "这是后端链路冒烟。请只回复“链路已通”，不要调用任何工具或提出问题。",
        limits: { maxSteps: plan.maxSteps },
        memoryRefs: [],
      },
    },
    admission.RUN_KEY,
  );
  admission.RUN_ID = run.id;
  await writePrivateEnv(admissionFile, admission);
  report.runId = run.id;
  stage = "read-only-observation";
  let ended = false;
  for (const deadline = Date.now() + 120000; Date.now() < deadline; ) {
    const current = await api("/v1/runs/" + run.id);
    const terminal = await db.withAccount(
      session.id,
      async (c) =>
        (
          await c.query(
            "select state,ended_at,spent_cny::text from run where id=$1",
            [run.id],
          )
        ).rows[0],
    );
    report.run = terminal;
    report.publicRun = current;
    if (terminal?.ended_at) {
      ended = true;
      break;
    }
    await delay(500);
  }
  report.guard = guard.status();
  assert.equal(guard.status().forwardCount, 1);
  assert.equal(ended, true);
  assert.equal((report.run as { state?: string })?.state, "completed");
  const detail = await captureEvidence();
  assert.ok(detail);
  report.model = plan.model;
  report.pricingContext = plan.pricingContext;
  assert.equal(detail.binding.phase, "accepted");
  assert.equal(detail.binding.usage_uncertain, false);
  assert.equal(detail.usage.length, 1);
  assert.notEqual(detail.usage[0].cost_cny, null);
  assert.ok(Number(detail.usage[0].cost_cny) < 1);
  assert.equal(detail.holds[0]?.state, "settled");
  report.completed = true;
} catch (error) {
  report.failureStage = stage;
  const message = (error as Error)?.message;
  report.code =
    message && /^(?:SMOKE|LOCAL)_[A-Z0-9_]+$/.test(message)
      ? message
      : "SMOKE_CHECK_FAILED";
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.guard = guard?.status() ?? null;
  const cleanupFailures = await cleanupSmoke([
    {
      name: "evidence",
      close: async () => {
        await captureEvidence();
      },
    },
    {
      name: "temporary_config",
      close: async () => {
        await runtime?.cleanupSmokeGateway();
      },
    },
    {
      name: "observer",
      close: async () => {
        await pipeline?.shutdown();
      },
    },
    {
      name: "http",
      close: async () => {
        if (server) {
          if (
            "closeAllConnections" in server &&
            typeof server.closeAllConnections === "function"
          )
            server.closeAllConnections();
          await new Promise<void>((done) => server!.close(() => done()));
        }
      },
    },
    {
      name: "guard",
      close: async () => {
        await guard?.close();
      },
    },
    {
      name: "database",
      close: async () => {
        await pool?.end();
      },
    },
  ]);
  report.cleanupFailures = cleanupFailures;
  report.temporaryConfigurationCleaned =
    !cleanupFailures.includes("temporary_config");
  if (cleanupFailures.length) {
    report.completed = false;
    process.exitCode = 1;
  }
  await mkdir(resolve(evidence), { recursive: true, mode: 0o700 });
  await writeFile(
    join(resolve(evidence), "real-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      code: process.exitCode ? "SMOKE_REQUIRES_REVIEW" : "SMOKE_COMPLETED",
      completed: report.completed,
      failureStage: report.failureStage,
      forwardCount:
        (report.guard as { forwardCount?: number } | null)?.forwardCount ?? 0,
      evidenceDirectory: resolve(evidence),
    }),
  );
}
