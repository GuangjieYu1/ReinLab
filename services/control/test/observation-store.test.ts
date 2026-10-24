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
it("cursor, itemized usage and final budget settle atomically, without double cost", async () => {
  const f = await fixture(),
    observer = new ObservationStore(db),
    a = event(f, 1, "message.part.updated", { part: part(f) });
  await observer.ingest(account, f.run, a);
  await observer.ingest(account, f.run, a);
  await observer.ingest(
    account,
    f.run,
    event(f, 2, "message.part.updated", { part: part(f) }),
  );
  await observer.ingest(
    account,
    f.run,
    event(f, 3, "runtime.completed", { messageID: "msg_fixture" }),
  );
  const row = (
    await admin.query(
      "select state,spent_cny::text cost from run where id=$1",
      [f.run],
    )
  ).rows[0];
  expect(row).toEqual({ state: "completed", cost: "0.002800" });
  expect(
    (
      await admin.query(
        "select sum(cost_cny)::text cost from event where run_id=$1",
        [f.run],
      )
    ).rows[0].cost,
  ).toBe("0.002800");
  expect((await store.get(account, f.run)).cursor).toBe(3);
  expect(
    (
      await admin.query(
        "select count(*)::int n from os_usage where run_id=$1",
        [f.run],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("same event identity with changed content conflicts; gap never advances the cursor", async () => {
  const f = await fixture(),
    observer = new ObservationStore(db);
  await observer.ingest(
    account,
    f.run,
    event(f, 1, "future.event", { data: "safe" }),
  );
  await expect(
    observer.ingest(
      account,
      f.run,
      event(f, 1, "future.event", { data: "changed" }),
    ),
  ).rejects.toMatchObject({ code: "DEDUPE_CONFLICT" });
  await expect(
    observer.ingest(
      account,
      f.run,
      event(f, 3, "runtime.completed", { messageID: "msg_fixture" }),
    ),
  ).rejects.toMatchObject({ code: "CURSOR_GAP" });
  expect((await store.get(account, f.run)).cursor).toBe(1);
  expect(
    (
      await admin.query("select kind,action from event where run_id=$1", [
        f.run,
      ])
    ).rows,
  ).toContainEqual({ kind: "error", action: "unmapped_event" });
});
it("missing usage and untrusted approvals never become free execution or actionable permission", async () => {
  const f = await fixture(),
    observer = new ObservationStore(db);
  await observer.ingest(
    account,
    f.run,
    event(f, 1, "permission.asked", {
      id: "per_old",
      sessionID: f.sessionID,
      permission: "read",
      patterns: ["*"],
      metadata: {},
      always: [],
    }),
  );
  await observer.ingest(
    account,
    f.run,
    event(f, 2, "runtime.completed", { messageID: "msg_fixture" }),
  );
  expect(
    (await admin.query("select state from run where id=$1", [f.run])).rows[0]
      .state,
  ).toBe("paused_budget");
  expect(
    (
      await admin.query(
        "select count(*)::int n from approval where run_id=$1 and kind='permission' and state='pending'",
        [f.run],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await admin.query("select state from budget_hold where run_id=$1", [
        f.run,
      ])
    ).rows[0].state,
  ).toBe("unpriced");
});

it('terminal recovery expires unlinked MCP/permission cards without approving them',async()=>{
 const f=await fixture();
 await db.withAccount(account,async c=>{await c.query("insert into approval(account_id,run_id,kind,title,effects,risk) values($1,$2,'permission','fixture MCP approval','{}','write')",[account,f.run]);});
 await new ObservationStore(db).ingest(account,f.run,event(f,1,'runtime.failed',{message:'fixture crash',recovered:true}));
 const rows=await db.withAccount(account,c=>c.query("select state from approval where run_id=$1 and kind in ('permission','question')",[f.run]));
 expect(rows.rows).toEqual([{state:'expired'}]);
 await new ObservationStore(db).ingest(account,f.run,event(f,1,'runtime.failed',{message:'fixture crash',recovered:true}));
 expect((await db.withAccount(account,c=>c.query("select count(*)::int n from event where run_id=$1 and action='runtime_approvals_expired'",[f.run]))).rows[0].n).toBe(1);
});
