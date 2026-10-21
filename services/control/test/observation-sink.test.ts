import { beforeAll, afterAll, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { allocateBudget, authorizeTool } from "../src/budget";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { ObservationStore } from "../src/bridge/openscience/observation-store";
import { DEEPSEEK_PRICING_VERSION } from "../src/bridge/openscience/deepseek-pricing";
const admin = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      "postgres://postgres@127.0.0.1:55432/reinlab_test",
  }),
  pool = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL_APP ??
      "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    max: 4,
  }),
  db = new Database(pool),
  store = new BindingStore(db),
  account = randomUUID();
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [account]);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function fixture() {
  const dossier = randomUUID(),
    run = randomUUID();
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','observer',$3)",
    [dossier, account, "/data/dossiers/" + dossier],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'queued',1,'{}')",
    [run, account, dossier, randomUUID()],
  );
  const b = await store.prepare(account, run, {
    role: {
      dossierId: dossier,
      role: {
        id: "research-read",
        prompt: "测试",
        toolGrants: {},
        writeTargets: [],
        steps: 1,
      },
      memory: "",
      model: "deepseek/deepseek-v4-flash",
    },
    message: "fixture",
  });
  const lease = (await store.claim(account, run))!;
  await store.baseline(account, run, lease, 0);
  await store.sendIntent(account, run, lease);
  await store.receipt(account, run, { runID: "run_" + run, acceptedAt: 1 });
  await db.withAccount(account, async (c) => {
    await c.query("update run set state='running' where id=$1", [run]);
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
    const hold = await authorizeTool(c, account, {
      runId: run,
      requestId: "observed:" + run,
      maximumCny: "1",
    });
    await c.query(
      "update os_binding set hold_id=$2,pricing_context=$3::jsonb where run_id=$1",
      [
        run,
        hold.holdId,
        JSON.stringify({
          currency: "CNY",
          window: "peak",
          usdCnyRate: "7.2",
          requestedModel: "deepseek/deepseek-v4-flash",
          pricingVersion: DEEPSEEK_PRICING_VERSION,
          validFrom: 1,
          validUntil: 100000,
        }),
      ],
    );
  });
  return { run, dossier, sessionID: b.sessionId, runID: "run_" + run };
}
function event(
  f: Awaited<ReturnType<typeof fixture>>,
  sequence: number,
  type: string,
  properties: unknown,
) {
  return {
    sessionID: f.sessionID,
    runID: f.runID,
    sequence,
    type,
    properties,
    time: 100,
  };
}
function part(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    id: "prt_fixture",
    sessionID: f.sessionID,
    messageID: "msg_fixture",
    type: "step-finish",
    reason: "stop",
    cost: 0.003,
    tokens: {
      input: 1000,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    usage: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      route: "byok",
      time: 100,
    },
  };
}

function snapshot(
  f: Awaited<ReturnType<typeof fixture>>,
  state = "running",
  latestSequence = 0,
) {
  return {
    sessionID: f.sessionID,
    runs: [
      {
        runID: f.runID,
        sessionID: f.sessionID,
        requestID: "",
        messageID: "msg_fixture",
        state,
        acceptedAt: 1,
        updatedAt: 100,
      },
    ],
    oldestSequence: 0,
    latestSequence,
    permissions: [],
    questions: [],
    decisionScope: "connected_runtime",
  };
}
async function current(
  f: Awaited<ReturnType<typeof fixture>>,
  state = "running",
  latest = 0,
) {
  const s = snapshot(f, state, latest);
  s.runs[0].requestID = (await store.get(account, f.run)).requestId;
  return s;
}
async function state(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await admin.query(
      `select r.state,r.spent_cny::text spent,r.ended_at,b.cursor::text cursor,b.usage_uncertain,h.state hold_state,h.actual_cny::text actual from run r join os_binding b on b.run_id=r.id join budget_hold h on h.id=b.hold_id where r.id=$1`,
      [f.run],
    )
  ).rows[0];
}
async function synchronize(
  o: ObservationStore,
  f: Awaited<ReturnType<typeof fixture>>,
  raw: unknown,
) {
  await (o as any).synchronize(account, f.run, raw);
}
it.each([
  ["runtime.failed", { message: "fixture" }, "failed"],
  ["runtime.failed", { message: "fixture", recovered: true }, "interrupted"],
  ["runtime.cancelled", { source: "user" }, "cancelled"],
])(
  "native %s preserves its actual terminal state rather than budget pause",
  async (type, body, expected) => {
    const f = await fixture(),
      o = new ObservationStore(db);
    await o.ingest(account, f.run, event(f, 1, type as string, body));
    expect(await state(f)).toMatchObject({
      state: expected,
      hold_state: "unpriced",
      actual: null,
    });
  },
);
it("frozen sink exposes committed cursor and delegates events without mutation ports", async () => {
  const f = await fixture(),
    o = new ObservationStore(db),
    sink = (o as any).sink(account, f.run);
  expect(Object.isFrozen(sink)).toBe(true);
  expect(await sink.cursor()).toBe(0);
  await sink.ingest(event(f, 1, "message.part.updated", { part: part(f) }));
  expect(await sink.cursor()).toBe(1);
  expect(sink).not.toHaveProperty("prompt");
  expect(sink).not.toHaveProperty("decide");
});
it("stable repeated failure is atomic, unknown, paused and does not leak raw errors", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  await (o as any).failed(account, f.run, "fixture_private_failure_text");
  const before = await state(f);
  await (o as any).failed(account, f.run, "fixture_private_failure_text");
  expect(await state(f)).toEqual(before);
  expect(before).toMatchObject({
    state: "paused_budget",
    spent: "0.000000",
    hold_state: "unpriced",
    usage_uncertain: true,
    cursor: "1",
  });
  const faults = (
    await admin.query(
      "select payload from event where run_id=$1 and action='runtime_observation_failed'",
      [f.run],
    )
  ).rows;
  expect(faults).toHaveLength(1);
  expect(JSON.stringify(faults)).not.toContain("fixture_private_failure_text");
});
it("late failure cannot alter an ended and known-settled run", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  await o.ingest(
    account,
    f.run,
    event(f, 2, "runtime.completed", { messageID: "msg_fixture" }),
  );
  const before = await state(f);
  await (o as any).failed(account, f.run, "OS_UNAVAILABLE");
  expect(await state(f)).toEqual(before);
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where run_id=$1 and action='runtime_observation_failed'",
        [f.run],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("complete matching snapshot reconciles known usage once with independent snapshot source and unchanged cursor", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  const snap = await current(f, "completed", 1);
  await synchronize(o, f, snap);
  const before = await state(f);
  await Promise.all([synchronize(o, f, snap), synchronize(o, f, snap)]);
  expect(await state(f)).toEqual(before);
  expect(before).toMatchObject({
    state: "completed",
    spent: "0.002800",
    cursor: "1",
    hold_state: "settled",
  });
  const records = (
    await admin.query(
      "select kind,payload from event where run_id=$1 and action='runtime_snapshot_reconciled'",
      [f.run],
    )
  ).rows;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    kind: "gate",
    payload: { source: "snapshot" },
  });
  expect(
    (
      await admin.query(
        "select count(*)::int n from os_observation where run_id=$1",
        [f.run],
      )
    ).rows[0].n,
  ).toBe(1);
});
it.each(["failed", "cancelled", "interrupted"])(
  "snapshot %s remains terminal with unknown hold",
  async (terminal) => {
    const f = await fixture(),
      o = new ObservationStore(db);
    await synchronize(o, f, await current(f, terminal, 0));
    expect(await state(f)).toMatchObject({
      state: terminal,
      hold_state: "unpriced",
      actual: null,
      cursor: "0",
    });
  },
);
it("completed snapshot with missing history or missing usage remains unknown and paused", async () => {
  for (const historyGap of [false, true]) {
    const f = await fixture(),
      o = new ObservationStore(db);
    if (historyGap)
      await o.ingest(
        account,
        f.run,
        event(f, 1, "message.part.updated", { part: part(f) }),
      );
    await synchronize(o, f, await current(f, "completed", historyGap ? 3 : 0));
    expect(await state(f)).toMatchObject({
      state: "paused_budget",
      spent: "0.000000",
      hold_state: "unpriced",
      cursor: historyGap ? "1" : "0",
    });
    if (historyGap) expect((await state(f)).usage_uncertain).toBe(true);
  }
});
it("pending and indeterminate cards missing from fresh snapshot expire and interrupt the nonterminal run", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  for (const cardState of ["pending", "indeterminate"])
    await db.withAccount(account, (c) =>
      c.query(
        "insert into approval(account_id,run_id,os_session_id,os_request_id,kind,title,effects,risk,state) values($1,$2,$3,$4,'permission','fixture','[]','write',$5)",
        [account, f.run, f.sessionID, "per_" + cardState, cardState],
      ),
    );
  const snap = await current(f);
  await synchronize(o, f, snap);
  await synchronize(o, f, snap);
  expect(
    (
      await admin.query(
        "select state from approval where run_id=$1 and kind='permission'",
        [f.run],
      )
    ).rows.every((r) => r.state === "expired"),
  ).toBe(true);
  expect(await state(f)).toMatchObject({
    state: "interrupted",
    usage_uncertain: true,
    hold_state: "unpriced",
  });
});
it("real pending cards remain actionable without fake sequence or snapshot completion", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await db.withAccount(account, (c) =>
    c.query(
      "insert into approval(account_id,run_id,os_session_id,os_request_id,kind,title,effects,risk) values($1,$2,$3,'per_live','permission','fixture','[]','write')",
      [account, f.run, f.sessionID],
    ),
  );
  const snap = await current(f);
  (snap.permissions as any[]).push({ id: "per_live", sessionID: f.sessionID });
  await synchronize(o, f, snap);
  expect(await state(f)).toMatchObject({
    state: "running",
    usage_uncertain: false,
    cursor: "0",
    hold_state: "reserved",
  });
  expect(
    (
      await admin.query(
        "select state from approval where run_id=$1 and kind='permission'",
        [f.run],
      )
    ).rows[0].state,
  ).toBe("pending");
});
it("wrong session/run/request and cursor regression reject without projection changes", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  const before = await state(f);
  for (const field of ["session", "run", "request"]) {
    const snap = await current(f, "completed", 1);
    if (field === "session") snap.sessionID = "foreign";
    if (field === "run") snap.runs[0].runID = "foreign";
    if (field === "request") snap.runs[0].requestID = "foreign";
    await expect(synchronize(o, f, snap)).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
    expect(await state(f)).toEqual(before);
  }
  await expect(
    synchronize(o, f, await current(f, "completed", 0)),
  ).rejects.toMatchObject({ code: "CURSOR_AHEAD" });
  expect(await state(f)).toEqual(before);
});
it("conflicting terminal evidence never rewrites ended state or billing", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "runtime.cancelled", { source: "user" }),
  );
  const before = await state(f);
  await expect(
    synchronize(o, f, await current(f, "completed", 1)),
  ).rejects.toMatchObject({ code: "RUNTIME_TERMINAL_CONFLICT" });
  expect(await state(f)).toEqual(before);
  await expect(
    o.ingest(
      account,
      f.run,
      event(f, 2, "runtime.failed", { message: "conflict" }),
    ),
  ).rejects.toMatchObject({ code: "RUNTIME_TERMINAL_CONFLICT" });
  expect(await state(f)).toEqual(before);
});
it("failure and snapshot sinks remain tenant scoped", async () => {
  const f = await fixture(),
    o = new ObservationStore(db),
    foreign = randomUUID();
  await admin.query("insert into account(id) values($1)", [foreign]);
  await expect((o as any).sink(foreign, f.run).cursor()).rejects.toMatchObject({
    code: "RLS_DENIED",
  });
  await expect(
    (o as any).failed(foreign, f.run, "OS_UNAVAILABLE"),
  ).rejects.toMatchObject({ code: "RLS_DENIED" });
  await expect(
    (o as any).synchronize(foreign, f.run, await current(f)),
  ).rejects.toMatchObject({ code: "RLS_DENIED" });
});
it("a disappeared pending decision makes otherwise priced completed usage unknown", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  await db.withAccount(account, (c) =>
    c.query(
      "insert into approval(account_id,run_id,os_session_id,os_request_id,kind,title,effects,risk) values($1,$2,$3,'que_gone','question','fixture','[]','write')",
      [account, f.run, f.sessionID],
    ),
  );
  await synchronize(o, f, await current(f, "completed", 1));
  expect(await state(f)).toMatchObject({
    state: "paused_budget",
    spent: "0.000000",
    hold_state: "unpriced",
    usage_uncertain: true,
    cursor: "1",
  });
  expect(
    (
      await admin.query(
        "select payload from event where run_id=$1 and action='runtime_snapshot_reconciled'",
        [f.run],
      )
    ).rows[0].payload,
  ).toMatchObject({ historyComplete: false, expiredPendingCount: 1 });
});
it("snapshot audit, hold, uncertainty and state roll back together when the caller transaction fails", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  const before = await state(f);
  const broken = {
    withAccount: (id: string, work: (c: pg.PoolClient) => Promise<unknown>) =>
      db.withAccount(id, async (c) => {
        await work(c);
        throw new Error("fixture sink rollback");
      }),
  } as Database;
  await expect(
    synchronize(
      new ObservationStore(broken),
      f,
      await current(f, "completed", 3),
    ),
  ).rejects.toThrow("fixture sink rollback");
  expect(await state(f)).toEqual(before);
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where run_id=$1 and action='runtime_snapshot_reconciled'",
        [f.run],
      )
    ).rows[0].n,
  ).toBe(0);
  await synchronize(o, f, await current(f, "completed", 1));
  expect((await state(f)).state).toBe("completed");
});
it.each(["priced", "missing_tokens", "invalid_tokens"])(
  "late %s step after terminal rejects atomically while recorded replays still deduplicate",
  async (variant) => {
    const f = await fixture(),
      o = new ObservationStore(db),
      first = event(f, 1, "message.part.updated", { part: part(f) });
    await o.ingest(account, f.run, first);
    await o.ingest(
      account,
      f.run,
      event(f, 2, "runtime.completed", { messageID: "msg_fixture" }),
    );
    const before = await state(f);
    const late: Record<string, unknown> = {
      ...part(f),
      id: "prt_late_" + variant,
    };
    if (variant === "missing_tokens") delete late.tokens;
    if (variant === "invalid_tokens") late.tokens = { input: -1 };
    await expect(
      o.ingest(
        account,
        f.run,
        event(f, 3, "message.part.updated", { part: late }),
      ),
    ).rejects.toMatchObject({ code: "LATE_USAGE_AFTER_TERMINAL", status: 409 });
    expect(await state(f)).toEqual(before);
    expect(
      (
        await admin.query(
          "select (select count(*)::int from os_usage where run_id=$1) usages,(select sum(cost_cny)::text from event where run_id=$1) ledger",
          [f.run],
        )
      ).rows[0],
    ).toEqual({ usages: 1, ledger: "0.002800" });
    expect(await o.ingest(account, f.run, first)).toBe(2);
    expect(await state(f)).toEqual(before);
  },
);
it("new accepted or contradictory terminal evidence cannot revive an ended run", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  await o.ingest(
    account,
    f.run,
    event(f, 2, "runtime.completed", { messageID: "msg_fixture" }),
  );
  const before = await state(f);
  await expect(
    o.ingest(
      account,
      f.run,
      event(f, 3, "runtime.accepted", { acceptedAt: 100, effort: "normal" }),
    ),
  ).rejects.toMatchObject({ code: "RUNTIME_TERMINAL_CONFLICT" });
  await expect(
    o.ingest(
      account,
      f.run,
      event(f, 3, "runtime.cancelled", { source: "user" }),
    ),
  ).rejects.toMatchObject({ code: "RUNTIME_TERMINAL_CONFLICT" });
  expect(await state(f)).toEqual(before);
  await o.ingest(
    account,
    f.run,
    event(f, 3, "runtime.completed", { messageID: "msg_fixture" }),
  );
  expect(await state(f)).toMatchObject({
    state: "completed",
    spent: "0.002800",
    hold_state: "settled",
    cursor: "3",
  });
});
