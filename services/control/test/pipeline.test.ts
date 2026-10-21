import { beforeAll, afterAll, it, expect, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { allocateBudget } from "../src/budget";
import { RuntimePipeline } from "../src/bridge/openscience/pipeline";
import {
  RoleRuntime,
  type RuntimeObservationPort,
} from "../src/bridge/openscience/role-runtime";
import { DecisionService } from "../src/bridge/openscience/decisions";
import { DEEPSEEK_PRICING_VERSION } from "../src/bridge/openscience/deepseek-pricing";
const admin = new pg.Pool({
    connectionString: "postgres://postgres@127.0.0.1:55432/reinlab_test",
    max: 2,
  }),
  pool = new pg.Pool({
    connectionString: "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    max: 4,
  }),
  db = new Database(pool);
const price = {
  currency: "CNY",
  window: "peak",
  usdCnyRate: "7.2",
  pricingVersion: DEEPSEEK_PRICING_VERSION,
  validFrom: 1,
  validUntil: 9999999999999,
};
beforeAll(() => applyMigrations(admin, resolve("infra/supabase/migrations")));
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function fixture(unknown = false) {
  const account = randomUUID(),
    dossier = randomUUID(),
    run = randomUUID();
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','pipeline',$3)",
    [dossier, account, "/data/dossiers/" + dossier],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'queued',1)",
    [run, account, dossier, randomUUID()],
  );
  await db.withAccount(account, async (c) => {
    const parent = await allocateBudget(c, account, {
      dossierId: dossier,
      amountCny: "1",
    });
    await allocateBudget(c, account, {
      dossierId: dossier,
      runId: run,
      parentId: parent.id,
      amountCny: "1",
    });
  });
  let session = "",
    requestID = "",
    accepted = false;
  const snapshots = vi.fn(async () => ({
    sessionID: session,
    runs: accepted
      ? [
          {
            runID: "runtime_" + run,
            sessionID: session,
            requestID,
            state: "running" as const,
            acceptedAt: 1,
          },
        ]
      : [],
    oldestSequence: 0,
    latestSequence: 0,
    permissions: [],
    questions: [],
    decisionScope: "connected_runtime" as const,
  }));
  const subscribed = vi.fn(async function* (
    _s: string,
    _c: number,
    signal: AbortSignal,
  ) {
    await new Promise<void>((done) => {
      if (signal.aborted) done();
      else signal.addEventListener("abort", () => done(), { once: true });
    });
  });
  const reader: RuntimeObservationPort = {
    snapshot: snapshots,
    replay: async () => ({ events: [], oldestSequence: 0, latestSequence: 0 }),
    subscribe: subscribed,
    messages: vi.fn(),
    getRun: vi.fn(),
    capabilities: vi.fn(),
  };
  const prompt = vi.fn(async (input?: { requestID: string }) => {
    requestID = input?.requestID ?? "";
    if (unknown) throw new Error("fixture-private-network");
    accepted = true;
    return { runID: "runtime_" + run, acceptedAt: 1 };
  });
  const runtime = {
    capabilities: async () => ({
      protocolVersion: "1.0",
      serverVersion: "2.0.150",
      idempotentPrompts: true,
      runSnapshots: true,
      crashRecovery: "interrupt",
    }),
    createSession: async (_title: string, id: string) => {
      session = id;
      return { sessionID: id };
    },
    snapshot: snapshots,
    restoreSession: async (id: string) => {
      session = id;
    },
    prompt,
    reader: () => Object.freeze(reader),
  } as unknown as RoleRuntime;
  const definitionLoader = vi.fn(async () => ({
      role: {
        dossierId: dossier,
        role: {
          id: "research-read",
          prompt: "fixture",
          toolGrants: {},
          writeTargets: [],
          steps: 1,
        },
        model: "fixture/confirmed",
        memory: "",
      },
      message: "fixture",
    })),
    factory = vi.fn(async () => runtime);
  return {
    account,
    dossier,
    run,
    prompt,
    snapshots,
    subscribed,
    factory,
    definitionLoader,
  };
}
it("composes accepted submission with read-only observation and explicit decision service", async () => {
  const f = await fixture(),
    pipeline = new RuntimePipeline(db, f);
  try {
    expect(pipeline.decisions).toBeInstanceOf(DecisionService);
    expect((await pipeline.submit(f.account, f.run)).status).toBe("accepted");
    await vi.waitFor(() => expect(f.subscribed).toHaveBeenCalledTimes(1));
    expect(f.prompt).toHaveBeenCalledTimes(1);
  } finally {
    await pipeline.shutdown();
  }
});
it("unknown submission writes one stable gate without automatically resubmitting", async () => {
  const f = await fixture(true),
    pipeline = new RuntimePipeline(db, f);
  try {
    expect((await pipeline.submit(f.account, f.run)).status).toBe(
      "indeterminate",
    );
    expect((await pipeline.submit(f.account, f.run)).status).toBe(
      "indeterminate",
    );
    expect(await pipeline.recoverAccount(f.account)).toBe(0);
    expect(f.prompt).toHaveBeenCalledTimes(1);
    const events = (
      await admin.query(
        "select payload from event where run_id=$1 and action='runtime_submission_indeterminate'",
        [f.run],
      )
    ).rows;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("fixture-private");
  } finally {
    await pipeline.shutdown();
  }
});
it("recovery observes accepted bindings after restart and never calls submit or definition again", async () => {
  const f = await fixture(),
    first = new RuntimePipeline(db, f);
  await first.submit(f.account, f.run);
  await first.shutdown();
  f.definitionLoader.mockClear();
  const second = new RuntimePipeline(db, f);
  try {
    expect(await second.recoverAccount(f.account)).toBe(1);
    await vi.waitFor(() =>
      expect(f.factory.mock.calls.length).toBeGreaterThan(1),
    );
    expect(f.prompt).toHaveBeenCalledTimes(1);
    expect(f.definitionLoader).not.toHaveBeenCalled();
  } finally {
    await second.shutdown();
  }
});
it("persists strict pricing before prompt and retains the original nonnull context", async () => {
  const f = await fixture();
  const originalSend = f.prompt.getMockImplementation()!;
  f.prompt.mockImplementation(async (input) => {
    const saved = (
      await admin.query(
        "select pricing_context from os_binding where run_id=$1",
        [f.run],
      )
    ).rows[0].pricing_context;
    expect(saved).toEqual({ ...price, requestedModel: "fixture/confirmed" });
    return originalSend(input);
  });
  const first = new RuntimePipeline(db, { ...f, pricingContext: price });
  await first.submit(f.account, f.run);
  await first.shutdown();
  const second = new RuntimePipeline(db, {
    ...f,
    pricingContext: { ...price, window: "offpeak" },
  });
  try {
    await second.submit(f.account, f.run);
    expect(
      (
        await admin.query(
          "select pricing_context from os_binding where run_id=$1",
          [f.run],
        )
      ).rows[0].pricing_context,
    ).toEqual({ ...price, requestedModel: "fixture/confirmed" });
    expect(f.prompt).toHaveBeenCalledTimes(1);
  } finally {
    await second.shutdown();
  }
});
it("missing pricing remains null, including an already submitted unknown binding", async () => {
  const f = await fixture(true),
    first = new RuntimePipeline(db, f);
  await first.submit(f.account, f.run);
  await first.shutdown();
  const second = new RuntimePipeline(db, { ...f, pricingContext: price });
  try {
    await second.submit(f.account, f.run);
    expect(
      (
        await admin.query(
          "select pricing_context from os_binding where run_id=$1",
          [f.run],
        )
      ).rows[0].pricing_context,
    ).toBeNull();
    expect(f.prompt).toHaveBeenCalledTimes(1);
  } finally {
    await second.shutdown();
  }
});
it("rejects bad pricing contexts and disallows production test dependency injection", () => {
  for (const patch of [
    { usdCnyRate: "7.3" },
    { currency: "EUR" },
    { window: "guessed" },
    { pricingVersion: "unknown" },
    { validUntil: 0 },
    { validUntil: 1 },
    { extra: true },
  ])
    expect(
      () => new RuntimePipeline(db, { pricingContext: { ...price, ...patch } }),
    ).toThrow();
  vi.stubEnv("NODE_ENV", "production");
  try {
    expect(() => new RuntimePipeline(db, { factory: vi.fn() })).toThrow();
    expect(
      () => new RuntimePipeline(db, { definitionLoader: vi.fn() }),
    ).toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});
it("shutdown prevents new explicit submissions", async () => {
  const f = await fixture(),
    pipeline = new RuntimePipeline(db, f);
  await pipeline.shutdown();
  await expect(pipeline.submit(f.account, f.run)).rejects.toMatchObject({
    code: "RUNTIME_PIPELINE_CLOSED",
  });
  expect(f.prompt).not.toHaveBeenCalled();
});
