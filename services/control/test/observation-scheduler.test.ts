import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import {
  ObservationScheduler,
  createObservationAccess,
  type ObservationAccess,
} from "../src/bridge/openscience/observation-scheduler";
import type { ObservationSink } from "../src/bridge/openscience/observer";
import type { RuntimeObservationPort } from "../src/bridge/openscience/role-runtime";
const admin = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres@127.0.0.1:55432/reinlab_test",
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ??
    "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 3,
});
const db = new Database(pool);
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
}, 30000);
afterAll(async () => {
  await pool.end();
  await admin.end();
});
afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  const account = randomUUID(),
    run = randomUUID(),
    sessionID = "ses_scheduler_fixture",
    runtimeRunID = "runtime_fixture";
  const releases: Array<() => void> = [],
    sink: ObservationSink = {
      cursor: vi.fn(async () => 0),
      ingest: vi.fn(async () => {}),
      gap: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
      synchronize: vi.fn(async () => {}),
    };
  const reader = {
    snapshot: vi.fn(async () => ({
      sessionID,
      runs: [],
      oldestSequence: 0,
      latestSequence: 0,
      permissions: [],
      questions: [],
      decisionScope: "connected_runtime" as const,
    })),
    replay: vi.fn(async () => ({
      events: [],
      oldestSequence: 0,
      latestSequence: 0,
    })),
    subscribe: vi.fn(async function* (
      _session: string,
      _cursor: number,
      signal: AbortSignal,
    ) {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (!signal.aborted)
        yield {
          sessionID,
          runID: runtimeRunID,
          sequence: 1,
          type: "runtime.completed",
          time: 1,
          properties: { messageID: "msg_fixture" },
        };
    }),
    messages: vi.fn(),
    getRun: vi.fn(),
    capabilities: vi.fn(),
  } satisfies RuntimeObservationPort;
  const access = {
    binding: vi.fn(async (accountId: string, runId: string) => ({
      accountId,
      runId,
      sessionID,
      runtimeRunID,
    })),
    recoverable: vi.fn(async () => [run]),
    reader: vi.fn(async () => reader),
  } satisfies ObservationAccess;
  const onFailure = vi.fn(),
    sinkFactory = vi.fn(() => sink);
  return {
    account,
    run,
    sessionID,
    runtimeRunID,
    releases,
    sink,
    reader,
    access,
    onFailure,
    sinkFactory,
  };
}
it("deduplicates one account/run and shuts down its subscription without recording failure", async () => {
  const f = fixture(),
    scheduler = new ObservationScheduler(f.access, f.sinkFactory, {
      onFailure: f.onFailure,
    });
  expect(scheduler.start(f.account, f.run)).toBe(true);
  expect(scheduler.start(f.account, f.run)).toBe(false);
  await vi.waitFor(() => expect(f.reader.subscribe).toHaveBeenCalledTimes(1));
  await scheduler.shutdown();
  expect(f.access.reader).toHaveBeenCalledExactlyOnceWith(f.account, f.run);
  expect(f.sink.failed).not.toHaveBeenCalled();
  expect(f.onFailure).not.toHaveBeenCalled();
  expect(scheduler.start(f.account, randomUUID())).toBe(false);
});
it("bounds concurrency and drains another accepted run only after the active observer ends", async () => {
  const f = fixture(),
    scheduler = new ObservationScheduler(f.access, f.sinkFactory, {
      maxConcurrent: 1,
    });
  scheduler.start(f.account, f.run);
  scheduler.start(f.account, randomUUID());
  await vi.waitFor(() => expect(f.reader.subscribe).toHaveBeenCalledTimes(1));
  expect(f.access.reader).toHaveBeenCalledTimes(1);
  f.releases[0]();
  await vi.waitFor(() => expect(f.reader.subscribe).toHaveBeenCalledTimes(2));
  await scheduler.shutdown();
});
it("shutdown does not start queued SDK work", async () => {
  const f = fixture(),
    scheduler = new ObservationScheduler(f.access, f.sinkFactory, {
      maxConcurrent: 1,
    });
  scheduler.start(f.account, f.run);
  scheduler.start(f.account, randomUUID());
  await vi.waitFor(() => expect(f.reader.subscribe).toHaveBeenCalledTimes(1));
  await scheduler.shutdown();
  expect(f.access.reader).toHaveBeenCalledTimes(1);
});
it("recoverAccount queries only its authenticated account and deduplicates recovered run IDs", async () => {
  const f = fixture();
  f.access.recoverable.mockResolvedValue([f.run, f.run, randomUUID()]);
  const scheduler = new ObservationScheduler(f.access, f.sinkFactory);
  expect(await scheduler.recoverAccount(f.account)).toBe(2);
  expect(f.access.recoverable).toHaveBeenCalledExactlyOnceWith(f.account);
  await vi.waitFor(() => expect(f.access.reader).toHaveBeenCalledTimes(2));
  expect(
    f.access.reader.mock.calls.every((args) => args[0] === f.account),
  ).toBe(true);
  await scheduler.shutdown();
});
it("a non-ready target never constructs a runtime reader", async () => {
  const f = fixture();
  f.access.binding.mockResolvedValue(null as any);
  const scheduler = new ObservationScheduler(f.access, f.sinkFactory);
  scheduler.start(f.account, f.run);
  await vi.waitFor(() => expect(f.access.binding).toHaveBeenCalledTimes(1));
  await scheduler.shutdown();
  expect(f.access.reader).not.toHaveBeenCalled();
  expect(f.sinkFactory).not.toHaveBeenCalled();
});
it("does not start a target whose returned account scope differs", async () => {
  const f = fixture();
  f.access.binding.mockResolvedValue({
    accountId: randomUUID(),
    runId: f.run,
    sessionID: f.sessionID,
    runtimeRunID: f.runtimeRunID,
  });
  const scheduler = new ObservationScheduler(f.access, f.sinkFactory, {
    onFailure: f.onFailure,
  });
  scheduler.start(f.account, f.run);
  await vi.waitFor(() =>
    expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(
      "OBSERVATION_SCHEDULER_FAILED",
    ),
  );
  expect(f.access.reader).not.toHaveBeenCalled();
  await scheduler.shutdown();
});
it("observer exhaustion is not silently wrapped in another infinite reconnect loop", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.reader.snapshot.mockRejectedValue(new Error("fixture private text"));
  const scheduler = new ObservationScheduler(f.access, f.sinkFactory, {
    onFailure: f.onFailure,
  });
  scheduler.start(f.account, f.run);
  await vi.runAllTimersAsync();
  expect(f.reader.snapshot).toHaveBeenCalledTimes(3);
  expect(f.sink.failed).toHaveBeenCalledExactlyOnceWith("OS_UNAVAILABLE");
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.access.reader).toHaveBeenCalledTimes(1);
  await scheduler.shutdown();
});
it("production adapter checks real binding/RLS and returns only the reader facet", async () => {
  const account = randomUUID(),
    foreign = randomUUID(),
    dossier = randomUUID(),
    run = randomUUID();
  await admin.query("insert into account(id) values($1),($2)", [
    account,
    foreign,
  ]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','scheduler',$3)",
    [dossier, account, "/data/dossiers/" + dossier],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'queued',1)",
    [run, account, dossier, randomUUID()],
  );
  const binding = await new BindingStore(db).prepare(account, run, {
    role: {
      dossierId: dossier,
      role: {
        id: "research-read",
        prompt: "fixture",
        toolGrants: {},
        writeTargets: [],
        steps: 1,
      },
      memory: "",
      model: "deepseek/deepseek-v4-flash",
    },
    message: "fixture",
  });
  const f = fixture(),
    mutation = vi.fn(),
    rawRuntime = {
      reader: vi.fn(() => f.reader),
      prompt: mutation,
      decide: mutation,
      cancel: mutation,
    },
    bridge = { runtime: vi.fn(async () => rawRuntime) },
    access = createObservationAccess(db, bridge);
  expect(await access.binding(account, run)).toBeNull();
  await admin.query(
    "update os_binding set phase='accepted',receipt=$2 where run_id=$1",
    [run, { runID: "runtime_" + run, acceptedAt: 1 }],
  );
  await admin.query("update run set state='running' where id=$1", [run]);
  expect(await access.binding(account, run)).toEqual({
    accountId: account,
    runId: run,
    sessionID: binding.sessionId,
    runtimeRunID: "runtime_" + run,
  });
  expect(await access.recoverable(account)).toEqual([run]);
  expect(await access.recoverable(foreign)).toEqual([]);
  await expect(access.binding(foreign, run)).rejects.toMatchObject({
    status: 404,
  });
  expect(await access.reader(account, run)).toBe(f.reader);
  expect(await access.reader(account, run)).not.toHaveProperty("prompt");
  expect(mutation).not.toHaveBeenCalled();
  await admin.query("update run set ended_at=now() where id=$1", [run]);
  expect(await access.binding(account, run)).toBeNull();
  expect(await access.recoverable(account)).toEqual([]);
});
