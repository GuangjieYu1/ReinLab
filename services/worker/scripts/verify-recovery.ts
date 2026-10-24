/** Real Docker/Supabase/Hatchet/native protocol; only the model HTTP is a named fixture.
 * Own generated account. Approvals below authorize fixture content only. No real key is read.
 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { readPrivateEnv, writePrivateEnv } from "../../../tooling/local/config";
import { localPaths } from "../../../tooling/local/paths";
import { quietCommand } from "../../../tooling/local/process";
import { authenticateVerificationUser } from "../../../tooling/local/verification-auth";
import {
  stopOwnedControl,
  startControlProcess,
} from "../../../tooling/local/control-process";
import { readRuntimeConfiguration } from "../../control/src/configuration";
import { Database } from "../../control/src/db/database";
import { createProductionRuntimeFactory } from "../../control/src/bridge/openscience/production-factory";
import {
  loadToolRegistry,
  loadBenchBundle,
} from "../../control/src/harness/manifest";
import { HarnessStore } from "../../control/src/harness/store";
import { materializeHarnessRole } from "../../control/src/harness/materialize";
import { BindingStore } from "../../control/src/bridge/openscience/binding-store";
import { startRoleProvider } from "../../control/test/fixtures/role-provider";
const paths = localPaths(),
  config = readRuntimeConfiguration(paths.runtime);
process.env.REINLAB_RUNTIME_CONFIG_FILE = paths.runtime;
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOCKER_HOST: config.DOCKER_HOST,
  DOCKER_CONFIG: join(paths.state, "docker-client"),
};
const docker = (args: string[]) =>
  quietCommand("docker", args, { env: environment, timeoutMs: 45_000 });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL_APP, max: 3 }),
  db = new Database(pool);
const out = process.env.REINLAB_EVIDENCE_OUT ?? "/tmp/reinlab-p113-chaos";
await mkdir(out, { recursive: true });
const report: Record<string, any> = {
  fixtureModel: true,
  realModelRequests: 0,
  realKeyReads: 0,
  realInfrastructure: true,
  startedAt: new Date().toISOString(),
  checks: [],
  passed: false,
};
let originalRole: any,
  releaseCheckpoint: (() => void) | undefined,
  checkpoint: Promise<unknown> | undefined;
let stage = "auth",
  worker: ChildProcess | undefined,
  controlStopped = false,
  runtime: any,
  configured: any;
const provider = await startRoleProvider({
  bindHost: process.platform === "linux" ? "0.0.0.0" : "127.0.0.1",
});
const check = (name: string) => report.checks.push({ name, passed: true });
async function until(work: () => Promise<boolean>, timeout = 60_000) {
  for (const end = Date.now() + timeout; Date.now() < end; ) {
    if (await work()) return;
    await delay(500);
  }
  throw Error("RECOVERY_VERIFY_TIMEOUT");
}
function startWorker() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("services/worker/src/main.ts")],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        REINLAB_WORKER_CONFIG_FILE: join(paths.state, "hatchet/worker.env"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let ready = false;
  child.stdout!.on("data", (data) => {
    if (String(data).includes("RECOVERY_WORKER_READY")) ready = true;
  });
  child.stderr!.resume();
  return { child, ready: () => ready };
}
try {
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  const identityFile = join(paths.state, "p113-chaos-" + randomUUID() + ".env");
  let identity: Record<string, string> = {};
  try {
    identity = await readPrivateEnv(identityFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  identity.EMAIL ??= "local-" + randomUUID() + "@reinlab.invalid";
  identity.PASSWORD ??= randomBytes(32).toString("base64url");
  await writePrivateEnv(identityFile, identity);
  const session = await authenticateVerificationUser(
    { url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY },
    {
      email: identity.EMAIL,
      password: identity.PASSWORD,
      registered: identity.REGISTERED === "true",
    }
  );
  identity.REGISTERED = "true";
  await writePrivateEnv(identityFile, identity);
  report.accountId = session.id;
  stage = "provision";
  await until(
    async () =>
      Boolean(
        await db.withAccount(
          session.id,
          async (c) =>
            (
              await c.query(
                "select 1 from account_machine where account_id=$1 and state='ready' and image=$2",
                [session.id, config.ACCOUNT_IMAGE]
              )
            ).rowCount
        )
      ),
    240_000
  );
  const machine = "rl-" + session.id.replaceAll("-", "");
  const api = async (path: string, body?: unknown) => {
    report.httpOperation=path;
    const r = await fetch("http://127.0.0.1:3001" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + session.token,
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw Error("RECOVERY_HTTP_" + r.status);
    }
    return (await r.json()) as any;
  };
  const dossier = await api("/v1/dossiers", {
    bench: "research",
    title: "P1-13 独立账户机器重启混沌（fixture）",
  });
  report.dossierId = dossier.id;
  const registry = await loadToolRegistry(),
    bundle = await loadBenchBundle({ benchId: "research", registry }),
    harness = new HarnessStore(db, bundle, registry),
    effective = await harness.effective(session.id, dossier.id);
  assert.equal(effective.manifest.version, "1.1.0");
  const role = materializeHarnessRole(effective, registry, {
    dossierId: dossier.id,
    roleId: "research-read",
    modelRoutes: {
      cheap: "deepseek/deepseek-v4-flash",
      mid: "deepseek/deepseek-v4-flash",
      strong: "deepseek/deepseek-v4-flash",
    },
    memory: "",
    maxSteps: 4,
  });
  originalRole = role;
  runtime = await createProductionRuntimeFactory(db)(session.id, role);
  configured = await runtime.configureSmokeGateway({
    origin: provider.url.replace("127.0.0.1", "host.docker.internal"),
    token: randomBytes(32).toString("base64url"),
  });
  const marker = "CHAOS_" + randomUUID();
  const first = "findings/" + marker + "-approved.md",
    second = "findings/" + marker + "-pending.md";
  provider.plans.set(marker, [
    {
      name: "finding_record",
      arguments: {
        capability: "files.write",
        args: { path: first, content: "CHAOS_APPROVED_FIXTURE_ONCE" },
        requestId: "chaos-approved-" + marker,
      },
    },
    {
      name: "finding_record",
      arguments: {
        capability: "files.write",
        args: { path: second, content: "CHAOS_PENDING_MUST_NOT_WRITE" },
        requestId: "chaos-pending-" + marker,
      },
    },
  ]);
  stage = "confirm";
  const quote = await api("/v1/runs/estimate", {
    dossierId: dossier.id,
    mode: "read",
  });
  report.estimateId=quote.id;
  const run = await api("/v1/runs", {
    dossierId: dossier.id,
    mode: "read",
    roleId: "research-read",
    budget: { cny: 1 },
    estimateId: quote.id,
    confirmed: true,
    input: { question: marker, limits: { maxSteps: 4 }, memoryRefs: [] },
  });
  report.runId = run.id;
  let approvals: any[] = [];
  stage = "pending";
  await until(async () => {
    approvals = await db.withAccount(
      session.id,
      async (c) =>
        (
          await c.query(
            "select a.id,jsonb_path_query_first(a.effects,'$.**.reinlabMcp.requestId') #>> '{}' request_id from approval a where a.run_id=$1 and a.os_request_id is not null and a.state='pending' and jsonb_path_exists(a.effects,'$.**.reinlabMcp.requestId')",
            [run.id]
          )
        ).rows
    );
    return approvals.length === 2;
  });
  const approval = approvals.find(
    (v) => v.request_id === "chaos-approved-" + marker
  );
  assert.ok(approval);
  stage = "fixture_once_approval";
  await api("/v1/approvals/" + approval.id + "/decide", {
    decision: "approve",
    scope: "once",
  });
  const fixtureRead = async (path: string) =>
    docker([
      "exec",
      "--user",
      "1000:1000",
      machine,
      "node",
      "--input-type=module",
      "-e",
      'import{readFile}from"node:fs/promises";try{process.stdout.write(await readFile(process.argv[1],"utf8"))}catch(e){if(e.code==="ENOENT")process.stdout.write("ABSENT");else process.exit(1)}',
      "/data/dossiers/" + dossier.id + "/" + path,
    ]);
  await until(
    async () => (await fixtureRead(first)) === "CHAOS_APPROVED_FIXTURE_ONCE"
  );
  assert.equal(await fixtureRead(second), "ABSENT");
  check("one approved fixture write, second write remains pending");
  stage = "no_visitors";
  await stopOwnedControl(paths.process, resolve("tooling/local/control.ts"));
  controlStopped = true;
  // Real protocol setup creates original events after the API observer has stopped.
  // This is before the no-visitor interval, and never submits a model or approval.
  const bound = await new BindingStore(db).get(session.id, run.id);
  const setupRuntime = await createProductionRuntimeFactory(db)(
    session.id,
    bound.role
  );
  await setupRuntime.restoreSession(bound.sessionId);
  const unobserved = await setupRuntime.snapshot(bound.sessionId);
  report.before = await db.withAccount(session.id, async (c) => ({
    binding: (
      await c.query(
        "select cursor,session_id,receipt from os_binding where run_id=$1",
        [run.id]
      )
    ).rows[0],
    events: (
      await c.query(
        "select sequence from os_observation where run_id=$1 order by sequence",
        [run.id]
      )
    ).rows,
  }));
  report.setupNativeHighWater = unobserved.latestSequence;
  assert.ok(unobserved.latestSequence > Number(report.before.binding.cursor));
  check("real native events remain unobserved after the API observer stops");
  report.noVisitorStartedAt = new Date().toISOString();
  const requestsBefore = provider.requests.length;
  stage = "machine_crash";
  await docker(["kill", "--signal", "KILL", machine]);
  await docker(["start", machine]);
  check("real account container SIGKILL/start with preserved volume");
  stage = "active_worker_checkpoint_crash";
  let checkpointPid = 0,
    held!: () => void;
  const holding = new Promise<void>((done) => {
      held = done;
    }),
    release = new Promise<void>((done) => {
      releaseCheckpoint = done;
    });
  checkpoint = db.withAccount(session.id, async (c) => {
    checkpointPid = Number(
      (await c.query("select pg_backend_pid() pid")).rows[0].pid
    );
    await c.query("select run_id from os_binding where run_id=$1 for update", [
      run.id,
    ]);
    held();
    await release;
  });
  await Promise.race([holding, checkpoint]);
  let start = startWorker();
  worker = start.child;
  await until(async () => start.ready(), 35_000);
  // Wait for the REAL worker to reach the database checkpoint, not merely register.
  await until(
    async () =>
      Boolean(
        (
          await pool.query(
            "select 1 from pg_stat_activity where usename=current_user and $1=any(pg_blocking_pids(pid)) limit 1",
            [checkpointPid]
          )
        ).rowCount
      ),
    150_000
  );
  report.workerBlockedAtDurableCheckpoint = true;
  worker.kill("SIGKILL");
  await new Promise<void>((done) => worker!.once("close", () => done()));
  worker = undefined;
  assert.ok(releaseCheckpoint);
  releaseCheckpoint();
  releaseCheckpoint = undefined;
  await checkpoint;
  checkpoint = undefined;
  const unchanged = await new BindingStore(db).get(session.id, run.id);
  assert.equal(unchanged.cursor, Number(report.before.binding.cursor));
  check(
    "real worker SIGKILL during a blocked observation leaves durable cursor unchanged"
  );
  stage = "autonomous_cron";
  start = startWorker();
  worker = start.child;
  await until(async () => start.ready(), 35_000);
  // Only RLS database reads here: no control API, no native HTTP polling, no direct task trigger.
  await until(
    async () =>
      await db.withAccount(session.id, async (c) =>
        Boolean(
          (
            await c.query(
              "select 1 from run where id=$1 and state='interrupted' and ended_at is not null",
              [run.id]
            )
          ).rowCount
        )
      ),
    210_000
  );
  report.noVisitorEndedAt = new Date().toISOString();
  check(
    "Hatchet cron globally discovers/reconciles with control process stopped and zero user HTTP"
  );
  stage = "assert_replay";
  const stored = await db.withAccount(session.id, async (c) => ({
    run: (
      await c.query("select state,ended_at from run where id=$1", [run.id])
    ).rows[0],
    binding: (
      await c.query(
        "select cursor,session_id,receipt from os_binding where run_id=$1",
        [run.id]
      )
    ).rows[0],
    sequences: (
      await c.query(
        "select sequence from os_observation where run_id=$1 order by sequence",
        [run.id]
      )
    ).rows.map((r) => Number(r.sequence)),
    approvals: (
      await c.query(
        "select state from approval where run_id=$1 and kind in ('permission','question')",
        [run.id]
      )
    ).rows,
    receipts: (
      await c.query(
        "select request_id,state from mcp_invocation where run_id=$1",
        [run.id]
      )
    ).rows,
    events: (
      await c.query(
        "select seq,at,kind,action,payload from event where run_id=$1 order by seq",
        [run.id]
      )
    ).rows,
  }));
  const recovery = await createProductionRuntimeFactory(db, { readOnly: true })(
    session.id,
    (
      await new BindingStore(db).get(session.id, run.id)
    ).role
  );
  await recovery.restoreSession(stored.binding.session_id);
  const snapshot = await recovery.snapshot(stored.binding.session_id);
  assert.equal(Number(stored.binding.cursor), snapshot.latestSequence);
  assert.deepEqual(
    stored.sequences,
    Array.from({ length: snapshot.latestSequence }, (_, i) => i + 1)
  );
  check(
    "original event sequence continuous, cursor equals native high-water, no duplicates"
  );
  assert.ok(
    stored.approvals.every(
      (a) => a.state !== "pending" && a.state !== "indeterminate"
    )
  );
  check("pending native approval expires on interruption");
  assert.equal(await fixtureRead(first), "CHAOS_APPROVED_FIXTURE_ONCE");
  assert.equal(await fixtureRead(second), "ABSENT");
  assert.equal(provider.requests.length, requestsBefore);
  check(
    "no prompt resubmission, approved file unchanged, unapproved file absent"
  );
  const beforeCount = stored.events.length;
  const p = new (
    await import("../../control/src/bridge/openscience/pipeline")
  ).RuntimePipeline(db, { readOnlyRecovery: true });
  try {
    await p.reconcileRun(session.id, run.id);
    await p.reconcileRun(session.id, run.id);
  } finally {
    await p.shutdown();
  }
  assert.equal(
    await db.withAccount(session.id, async (c) =>
      Number(
        (
          await c.query("select count(*) n from event where run_id=$1", [
            run.id,
          ])
        ).rows[0].n
      )
    ),
    beforeCount
  );
  check("repeated reconciliation of terminal run adds no ledger events");
  report.after = stored;
  report.nativeHighWater = snapshot.latestSequence;
  report.fixtureProviderRequests = provider.requests.length;
  report.maximumFixtureRequestBytes = Math.max(
    0,
    ...provider.requests.map((request) =>
      Buffer.byteLength(JSON.stringify(request))
    )
  );
  report.passed = true;
} catch (error) {
  report.failure = {
    errorClass:["TimeoutError","TypeError","SyntaxError","AssertionError","Error"].includes((error as Error).name)?(error as Error).name:"Unknown",
    stage,
    code: /^[A-Z][A-Z0-9_]+$/.test((error as Error).message)
      ? (error as Error).message
      : "RECOVERY_ASSERTION_FAILED",
  };
  process.exitCode = 1;
} finally {
  releaseCheckpoint?.();
  await checkpoint?.catch(() => {});
  if (!report.passed && report.runId && report.accountId)
    try {
      const b = await new BindingStore(db).get(report.accountId, report.runId);
      const r = await createProductionRuntimeFactory(db)(
        report.accountId,
        b.role
      );
      await r.restoreSession(b.sessionId);
      if (b.receipt) await r.cancel(b.sessionId, b.receipt.runID);
    } catch {
      report.fixtureFailureCleanupIncomplete = true;
    }
  if (worker) {
    worker.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((done) => worker!.once("close", () => done())),
      delay(5000),
    ]);
  }
  if (controlStopped)
    try {
      await startControlProcess({
        script: resolve("tooling/local/control.ts"),
        cwd: paths.root,
        env: environment,
        recordFile: paths.process,
      });
    } catch {
      report.controlRestoreFailed = true;
      process.exitCode = 1;
    }
  try {
    if (configured) {
      const current = await createProductionRuntimeFactory(db)(
        report.accountId,
        originalRole
      );
      await configured.cleanup(current);
      report.fixtureGatewayCleaned = true;
    }
  } catch (error) {
    report.fixtureGatewayCleanupFailed = true;
    report.fixtureCleanupFailureStages = (
      error as { cleanupStages?: string[] }
    ).cleanupStages;
    process.exitCode = 1;
  }
  await provider.close();
  await pool.end();
  if (report.fixtureGatewayCleanupFailed || report.controlRestoreFailed)
    report.passed = false;
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      stage: report.failure?.stage,
      realModelRequests: 0,
    })
  );
}
