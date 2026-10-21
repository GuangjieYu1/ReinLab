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
  await db.assertSafeRole();
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

it("independent concurrent event/part replay charges one cost and one usage", async () => {
  const f = await fixture(),
    o = new ObservationStore(db),
    a = event(f, 1, "message.part.updated", { part: part(f) });
  await Promise.all(
    Array.from({ length: 6 }, () => o.ingest(account, f.run, a)),
  );
  await o.ingest(
    account,
    f.run,
    event(f, 2, "message.part.updated", { part: part(f) }),
  );
  await o.ingest(
    account,
    f.run,
    event(f, 3, "runtime.completed", { messageID: "msg_fixture" }),
  );
  const rows = (
    await admin.query(
      "select (select count(*)::int from os_usage where run_id=$1) usages,(select count(*)::int from event where run_id=$1 and kind='cost') costs,(select spent_cny::text from run where id=$1) spent",
      [f.run],
    )
  ).rows[0];
  expect(rows).toEqual({ usages: 1, costs: 1, spent: "0.002800" });
});
it("independent transaction failure after ledger+usage rolls every projection back", async () => {
  const f = await fixture(),
    a = event(f, 1, "message.part.updated", { part: part(f) });
  const broken = {
    withAccount: (id: string, work: (c: pg.PoolClient) => Promise<unknown>) =>
      db.withAccount(id, (c) =>
        work(
          new Proxy(c, {
            get(target, key) {
              if (key === "query")
                return (...args: any[]) => {
                  if (
                    String(args[0]).startsWith("update os_binding set cursor=")
                  )
                    throw Error("fixture checkpoint failure");
                  return (target.query as any)(...args);
                };
              const v = Reflect.get(target, key);
              return typeof v === "function" ? v.bind(target) : v;
            },
          }),
        ),
      ),
  } as Database;
  await expect(
    new ObservationStore(broken).ingest(account, f.run, a),
  ).rejects.toThrow("fixture checkpoint failure");
  for (const table of ["os_usage", "os_observation", "event"])
    expect(
      (
        await admin.query(
          `select count(*)::int n from ${table} where run_id=$1${table === "event" ? " and kind='cost'" : ""}`,
          [f.run],
        )
      ).rows[0].n,
    ).toBe(0);
  expect((await store.get(account, f.run)).cursor).toBe(0);
  await expect(
    new ObservationStore(db).ingest(account, f.run, a),
  ).resolves.toBe(1);
});
it("independent RLS denies tenant event/gap and freezes cost history", async () => {
  const f = await fixture(),
    o = new ObservationStore(db),
    foreign = randomUUID();
  await admin.query("insert into account(id) values($1)", [foreign]);
  await expect(
    o.ingest(
      foreign,
      f.run,
      event(f, 1, "message.part.updated", { part: part(f) }),
    ),
  ).rejects.toMatchObject({ code: "RLS_DENIED" });
  await expect(o.gap(foreign, f.run, 1, "CURSOR_GAP")).rejects.toMatchObject({
    code: "RLS_DENIED",
  });
  await expect(
    o.ingest(account, f.run, {
      ...event(f, 1, "message.part.updated", { part: part(f) }),
      runID: "other-run",
    }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  expect(
    (
      await db.withAccount(foreign, (c) =>
        c.query("select * from os_usage where run_id=$1", [f.run]),
      )
    ).rowCount,
  ).toBe(0);
  for (const table of ["os_usage", "os_observation"])
    for (const verb of [
      `delete from ${table} where run_id=$1`,
      `update ${table} set source_hash=source_hash where run_id=$1`,
    ])
      await expect(
        db.withAccount(account, (c) => c.query(verb, [f.run])),
      ).rejects.toMatchObject({ code: "42501" });
});
it("independent gap permanently marks uncertainty and pauses rather than settling partial totals", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "message.part.updated", { part: part(f) }),
  );
  await o.gap(account, f.run, 4, "CURSOR_EXPIRED");
  await o.ingest(
    account,
    f.run,
    event(f, 5, "runtime.completed", { messageID: "msg_fixture" }),
  );
  expect(
    (
      await admin.query(
        "select state,spent_cny::text spent from run where id=$1",
        [f.run],
      )
    ).rows[0],
  ).toEqual({ state: "paused_budget", spent: "0.000000" });
  expect(
    (
      await admin.query("select state from budget_hold where run_id=$1", [
        f.run,
      ])
    ).rows[0].state,
  ).toBe("unpriced");
  await expect(
    db.withAccount(account, (c) =>
      c.query("update os_binding set usage_uncertain=false where run_id=$1", [
        f.run,
      ]),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("independent old approvals stay expired; live matching snapshots alone admit pending", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  const asked = (id: string) => ({
    id,
    sessionID: f.sessionID,
    permission: "read",
    patterns: ["*"],
    metadata: {},
    always: [],
  });
  await o.ingest(
    account,
    f.run,
    event(f, 1, "permission.asked", asked("per_old")),
  );
  await o.ingest(
    account,
    f.run,
    event(f, 2, "permission.asked", asked("per_live")),
    {
      sessionID: f.sessionID,
      permissions: [{ id: "per_live", sessionID: f.sessionID }],
      questions: [],
    },
  );
  expect(
    (
      await admin.query(
        "select os_request_id,state from approval where run_id=$1 order by os_request_id",
        [f.run],
      )
    ).rows,
  ).toEqual([
    { os_request_id: "per_live", state: "pending" },
    { os_request_id: "per_old", state: "expired" },
  ]);
});
it("independent observed reply removes stale actionable pending card", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "permission.asked", {
      id: "per_live",
      sessionID: f.sessionID,
      permission: "read",
      patterns: ["*"],
      metadata: {},
      always: [],
    }),
    {
      sessionID: f.sessionID,
      permissions: [{ id: "per_live", sessionID: f.sessionID }],
      questions: [],
    },
  );
  await o.ingest(
    account,
    f.run,
    event(f, 2, "permission.replied", {
      requestID: "per_live",
      sessionID: f.sessionID,
      reply: "once",
    }),
  );
  const state = (
    await admin.query(
      "select state from approval where run_id=$1 and os_request_id='per_live'",
      [f.run],
    )
  ).rows[0].state;
  expect(state).not.toBe("pending");
  expect(state).not.toBe("approved");
});

it("independent observed reply preserves unknown control intent as indeterminate, never approved", async () => {
  const f = await fixture(),
    o = new ObservationStore(db);
  await o.ingest(
    account,
    f.run,
    event(f, 1, "permission.asked", {
      id: "per_intent",
      sessionID: f.sessionID,
      permission: "read",
      patterns: ["*"],
      metadata: {},
      always: [],
    }),
    {
      sessionID: f.sessionID,
      permissions: [{ id: "per_intent", sessionID: f.sessionID }],
      questions: [],
    },
  );
  await db.withAccount(account, (c) =>
    c.query(
      "update approval set decision_hash=$2 where run_id=$1 and os_request_id='per_intent'",
      [f.run, "a".repeat(64)],
    ),
  );
  await o.ingest(
    account,
    f.run,
    event(f, 2, "permission.replied", {
      requestID: "per_intent",
      sessionID: f.sessionID,
      reply: "once",
    }),
  );
  expect(
    (
      await admin.query(
        "select state from approval where run_id=$1 and os_request_id='per_intent'",
        [f.run],
      )
    ).rows[0].state,
  ).toBe("indeterminate");
});

it("independent late priced step cannot append billable cost beyond an already settled terminal", async () => {
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
  const late = { ...part(f), id: "prt_late_fixture" };
  await o
    .ingest(account, f.run, event(f, 3, "message.part.updated", { part: late }))
    .catch(() => {});
  const row = (
    await admin.query(
      "select (select count(*)::int from os_usage where run_id=$1) usages,(select sum(cost_cny)::text from event where run_id=$1) ledger,(select spent_cny::text from run where id=$1) spent",
      [f.run],
    )
  ).rows[0];
  expect(row).toEqual({ usages: 1, ledger: "0.002800", spent: "0.002800" });
});
