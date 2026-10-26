import { beforeAll, afterAll, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as budget from "../src/budget";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { appendEvent } from "../src/ledger";

const admin = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres@127.0.0.1:55432/reinlab_test",
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ??
    "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 6,
});
const db = new Database(pool);
const observed = (
  client: pg.PoolClient,
  account: string,
  run: string,
  complete: boolean,
): Promise<{
  eventSeq: number;
  settled: boolean;
  costCny: string | null;
  reconciled: boolean;
}> => Reflect.get(budget, "settleObservedRun")(client, account, run, complete);
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await db.assertSafeRole();
}, 30000);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function fixture(role = "research-read") {
  const account = randomUUID(),
    dossier = randomUUID(),
    run = randomUUID(),
    request = randomUUID(),
    session = "ses_rl" + randomUUID().replaceAll("-", "");
  await admin.query(
    "insert into account(id,monthly_budget_cny) values($1,1000)",
    [account],
  );
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','observed settlement',$3)",
    [dossier, account, "/data/dossiers/" + dossier],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,$5,'read',$4,'running',10)",
    [run, account, dossier, request, role],
  );
  const root = await db.withAccount(account, (c) =>
    budget.allocateBudget(c, account, { dossierId: dossier, amountCny: "10" }),
  );
  const node = await db.withAccount(account, (c) =>
    budget.allocateBudget(c, account, {
      dossierId: dossier,
      parentId: root.id,
      runId: run,
      amountCny: "10",
    }),
  );
  const hold = await db.withAccount(account, (c) =>
    budget.authorizeTool(c, account, {
      runId: run,
      requestId: request,
      maximumCny: "5",
    }),
  );
  expect(hold.allowed).toBe(true);
  await db.withAccount(account, (c) =>
    c.query(
      `insert into os_binding(account_id,dossier_id,run_id,logical_role_id,request_id,session_id,role_options,definition_hash,message,input_hash,phase,receipt,hold_id)
    values($1,$2,$3,$8,$4,$5,jsonb_build_object('dossierId',$2::uuid::text,'role',jsonb_build_object('id',$8::text||'--'||repeat('a',32))),$6,'fixture',$6,'accepted','{}',$7)`,
      [account, dossier, run, request, session, "a".repeat(64), hold.holdId, role],
    ),
  );
  return {
    account,
    dossier,
    run,
    session,
    hold: hold.holdId!,
    root: root.id as string,
    node: node.id as string,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function usage(
  f: Fixture,
  cost: string | null,
  eventOverride?: {
    seq?: number;
    run?: string;
    dossier?: string;
    cost?: string | null;
    kind?: "gate" | "cost";
  },
) {
  return db.withAccount(f.account, async (c) => {
    const part = "part_" + randomUUID();
    const event = eventOverride?.seq
      ? { seq: eventOverride.seq }
      : await appendEvent(c, f.account, {
          dossierId: eventOverride?.dossier ?? f.dossier,
          runId: eventOverride?.run ?? f.run,
          kind: eventOverride?.kind ?? "cost",
          action: "os_step_cost",
          costCny:
            (eventOverride && "cost" in eventOverride
              ? eventOverride.cost
              : cost) === null
              ? null
              : Number(eventOverride?.cost ?? cost),
          credentialKind: "api_key",
          payload: { part },
          dedupeKey: part,
        });
    await c.query(
      "insert into os_usage(account_id,dossier_id,run_id,session_id,part_id,message_id,source_hash,cost_cny,metadata,event_seq) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        f.account,
        f.dossier,
        f.run,
        f.session,
        part,
        "msg_fixture",
        "b".repeat(64),
        cost,
        { costCny: "999", ignoredUntrustedAmount: true },
        event.seq,
      ],
    );
    return event.seq as number;
  });
}
const settle = (f: Fixture, complete = true) =>
  db.withAccount(f.account, (c) => observed(c, f.account, f.run, complete));
async function snapshot(f: Fixture) {
  const r = (
    await admin.query("select spent_cny,state from run where id=$1", [f.run])
  ).rows[0];
  const h = (
    await admin.query(
      "select state,actual_cny,receipt from budget_hold where id=$1",
      [f.hold],
    )
  ).rows[0];
  const events = (
    await admin.query(
      "select kind,cost_cny,action from event where run_id=$1 order by seq",
      [f.run],
    )
  ).rows;
  const allocations = (
    await admin.query(
      "select spent_cny from budget_allocation where id=any($1::uuid[])",
      [[f.root, f.node]],
    )
  ).rows;
  return { r, h, events, allocations };
}

it("exports the trusted observed-run entrypoint", () => {
  expect(typeof Reflect.get(budget, "settleObservedRun")).toBe("function");
});
it.each([{ mode: "observed" }, { ledgerMode: "gate" }])(
  "legacy settleTool strictly rejects internal mode: %j",
  async (extra) => {
    const query = vi.fn();
    await expect(
      budget.settleTool({ query } as unknown as pg.PoolClient, randomUUID(), {
        holdId: randomUUID(),
        costCny: "1",
        credentialKind: "api_key",
        ...extra,
      }),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  },
);
it("sums immutable steps exactly, updates every allocation once, and adds only a null-cost gate", async () => {
  const f = await fixture();
  await usage(f, "0.100001");
  await usage(f, "0.200002");
  const paid = await settle(f);
  expect(paid).toMatchObject({
    settled: true,
    costCny: "0.300003",
    reconciled: false,
  });
  const s = await snapshot(f);
  expect(s.r.spent_cny).toBe("0.300003");
  expect(s.allocations.map((x) => x.spent_cny)).toEqual([
    "0.300003",
    "0.300003",
  ]);
  expect(s.h).toMatchObject({ state: "settled", actual_cny: "0.300003" });
  expect(s.events.filter((x) => x.kind === "cost")).toHaveLength(2);
  const summary = (
    await admin.query("select kind,cost_cny from event where seq=$1", [
      paid.eventSeq,
    ])
  ).rows[0];
  expect(summary).toEqual({ kind: "gate", cost_cny: null });
  const repeated = await Promise.all([settle(f), settle(f)]);
  expect(repeated).toEqual([paid, paid]);
  expect(await snapshot(f)).toEqual(s);
});
it.each(["incomplete", "missing", "null", "zero", "mixed"] as const)(
  "%s never becomes free or partial known settlement",
  async (scenario) => {
    const f = await fixture();
    if (scenario !== "missing")
      await usage(
        f,
        scenario === "zero" ? "0" : scenario === "null" ? null : "0.25",
      );
    if (scenario === "mixed") await usage(f, null);
    const paid = await settle(f, scenario !== "incomplete");
    expect(paid).toMatchObject({ settled: false, costCny: null });
    const s = await snapshot(f);
    expect(s.r).toEqual({ spent_cny: "0.000000", state: "paused_budget" });
    expect(s.h.state).toBe("unpriced");
    expect(s.h.actual_cny).toBeNull();
    expect(await settle(f, scenario !== "incomplete")).toEqual(paid);
  },
);
it("complete observation reconciles a previously incomplete known stream exactly once", async () => {
  const f = await fixture();
  await usage(f, "0.4");
  await settle(f, false);
  const paid = await settle(f, true);
  expect(paid).toMatchObject({
    settled: true,
    costCny: "0.400000",
    reconciled: true,
  });
  expect(await settle(f)).toEqual(paid);
  const s = await snapshot(f);
  expect(s.r.spent_cny).toBe("0.400000");
  expect(s.events.filter((e) => e.kind === "cost")).toHaveLength(1);
});
it("settled totals cannot silently change after new steps arrive", async () => {
  const f = await fixture();
  await usage(f, "0.4");
  await settle(f);
  await usage(f, "0.2");
  const before = await snapshot(f);
  await expect(settle(f)).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
  expect(await snapshot(f)).toEqual(before);
});
it.each(["cost", "kind", "duplicate", "run"] as const)(
  "rejects ledger %s mismatch atomically",
  async (variant) => {
    const f = await fixture();
    if (variant === "duplicate") {
      const seq = await usage(f, "0.1");
      await usage(f, "0.1", { seq });
    } else if (variant === "run") {
      const other = randomUUID();
      await admin.query(
        "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'running',1)",
        [other, f.account, f.dossier, randomUUID()],
      );
      await usage(f, "0.1", { run: other });
    } else
      await usage(
        f,
        "0.1",
        variant === "cost" ? { cost: "0.2" } : { kind: "gate" },
      );
    const before = await snapshot(f);
    await expect(settle(f)).rejects.toMatchObject({
      code: "OBSERVED_USAGE_INVALID",
    });
    expect(await snapshot(f)).toEqual(before);
  },
);
it("uses aggregate range above single event cap without duplicating cost ledger", async () => {
  const f = await fixture();
  await usage(f, "600000");
  await usage(f, "600000");
  expect(await settle(f)).toMatchObject({
    costCny: "1200000.000000",
    settled: true,
  });
  const s = await snapshot(f);
  expect(s.r).toEqual({ spent_cny: "1200000.000000", state: "paused_budget" });
  expect(s.allocations.every((a) => a.spent_cny === "1200000.000000")).toBe(
    true,
  );
  expect(s.events.filter((e) => e.kind === "cost")).toHaveLength(2);
  await expect(
    db.withAccount(f.account, (c) =>
      budget.settleTool(c, f.account, {
        holdId: f.hold,
        costCny: "1200000",
        credentialKind: "api_key",
      }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
it("transaction rollback restores hold, spent, summary and pause state; retry succeeds", async () => {
  const f = await fixture();
  await usage(f, "6");
  const before = await snapshot(f);
  await expect(
    db.withAccount(f.account, async (c) => {
      await observed(c, f.account, f.run, true);
      throw new Error("fixture rollback");
    }),
  ).rejects.toThrow("fixture rollback");
  expect(await snapshot(f)).toEqual(before);
  expect(await settle(f)).toMatchObject({ costCny: "6.000000" });
});
it.each(["queued", "unaccepted", "no-hold"] as const)(
  "rejects %s binding readiness without side effects",
  async (variant) => {
    const f = await fixture();
    if (variant === "queued")
      await admin.query("update run set state='queued' where id=$1", [f.run]);
    else {
      // Recreate only fixture binding to avoid violating the immutable accepted fence.
      await admin.query("delete from os_binding where run_id=$1", [f.run]);
      await db.withAccount(f.account, (c) =>
        c.query(
          `insert into os_binding(account_id,dossier_id,run_id,logical_role_id,request_id,session_id,role_options,definition_hash,message,input_hash,phase,receipt,hold_id) select account_id,dossier_id,id,role_id,request_id::text,$2,jsonb_build_object('dossierId',dossier_id::text,'role',jsonb_build_object('id','research-read--'||repeat('a',32))),$3,'fixture',$3,$4,$5,$6 from run where id=$1`,
          [
            f.run,
            f.session,
            "a".repeat(64),
            variant === "unaccepted" ? "prepared" : "accepted",
            variant === "unaccepted" ? null : {},
            variant === "no-hold" ? null : f.hold,
          ],
        ),
      );
    }
    const before = await snapshot(f);
    await expect(settle(f)).rejects.toMatchObject({
      code: "OBSERVED_RUN_NOT_READY",
    });
    expect(await snapshot(f)).toEqual(before);
  },
);
it("RLS rejects foreign account settlement and hides immutable usage", async () => {
  const f = await fixture(),
    foreign = await fixture();
  await usage(f, "0.1");
  expect(
    (
      await db.withAccount(foreign.account, (c) =>
        c.query("select * from os_usage where run_id=$1", [f.run]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    db.withAccount(foreign.account, (c) =>
      observed(c, foreign.account, f.run, true),
    ),
  ).rejects.toMatchObject({ code: "RLS_DENIED" });
  await expect(
    db.withAccount(f.account, (c) => observed(c, foreign.account, f.run, true)),
  ).rejects.toMatchObject({ code: "RLS_DENIED" });
  for (const command of [
    "update os_usage set cost_cny=0 where run_id=$1",
    "delete from os_usage where run_id=$1",
  ])
    await expect(
      db.withAccount(f.account, (c) => c.query(command, [f.run])),
    ).rejects.toMatchObject({ code: "42501" });
});
it("database forbids binding another run/account hold", async () => {
  const f = await fixture(),
    foreign = await fixture();
  await admin.query("delete from os_binding where run_id=$1", [f.run]);
  await expect(
    db.withAccount(f.account, (c) =>
      c.query(
        `insert into os_binding(account_id,dossier_id,run_id,logical_role_id,request_id,session_id,role_options,definition_hash,message,input_hash,hold_id) select account_id,dossier_id,id,role_id,request_id::text,$2,jsonb_build_object('dossierId',dossier_id::text,'role',jsonb_build_object('id','research-read--'||repeat('a',32))),$3,'fixture',$3,$4 from run where id=$1`,
        [f.run, f.session, "a".repeat(64), foreign.hold],
      ),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it.each([undefined, null, "true", 1])(
  "requires literal boolean complete: %j",
  async (complete) => {
    const query = vi.fn();
    await expect(
      observed(
        { query } as unknown as pg.PoolClient,
        randomUUID(),
        randomUUID(),
        complete as boolean,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(query).not.toHaveBeenCalled();
  },
);
it("rejects an unreferenced cost event instead of calling a partial usage set complete", async () => {
  const f = await fixture();
  await usage(f, "0.1");
  await db.withAccount(f.account, (c) =>
    appendEvent(c, f.account, {
      dossierId: f.dossier,
      runId: f.run,
      kind: "cost",
      action: "os_step_cost",
      costCny: 0.2,
      credentialKind: "api_key",
      payload: {},
      dedupeKey: randomUUID(),
    }),
  );
  const before = await snapshot(f);
  await expect(settle(f)).rejects.toMatchObject({
    code: "OBSERVED_USAGE_INVALID",
  });
  expect(await snapshot(f)).toEqual(before);
});
it("missing binding is denied without spending an existing run hold", async () => {
  const f = await fixture();
  await admin.query("delete from os_binding where run_id=$1", [f.run]);
  const before = await snapshot(f);
  await expect(settle(f)).rejects.toMatchObject({ code: "RLS_DENIED" });
  expect(await snapshot(f)).toEqual(before);
});
it("rejects aggregate spent overflow with stable error before mutation", async () => {
  const f = await fixture();
  await usage(f, "0.000001");
  await admin.query(
    "update budget_allocation set spent_cny=999999999999.999999 where id=$1",
    [f.root],
  );
  const before = await snapshot(f);
  await expect(settle(f)).rejects.toMatchObject({
    code: "USAGE_RANGE_INVALID",
    status: 503,
  });
  expect(await snapshot(f)).toEqual(before);
});
it("ledger cost null must match usage null rather than coalescing to zero", async () => {
  const f = await fixture();
  await usage(f, null, { cost: "0" });
  const before = await snapshot(f);
  await expect(settle(f)).rejects.toMatchObject({
    code: "OBSERVED_USAGE_INVALID",
  });
  expect(await snapshot(f)).toEqual(before);
});
it("child observation updates parent run and all three funding allocations once", async () => {
  const f = await fixture(),
    child = randomUUID(),
    request = randomUUID(),
    session = "ses_rl" + randomUUID().replaceAll("-", "");
  await admin.query(
    "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,$4,'research-read','read',$5,'running',2)",
    [child, f.account, f.dossier, f.run, request],
  );
  const node = await db.withAccount(f.account, (c) =>
    budget.allocateBudget(c, f.account, {
      dossierId: f.dossier,
      parentId: f.node,
      runId: child,
      amountCny: "2",
    }),
  );
  const hold = await db.withAccount(f.account, (c) =>
    budget.authorizeTool(c, f.account, {
      runId: child,
      requestId: request,
      maximumCny: "1",
    }),
  );
  expect(hold.allowed).toBe(true);
  await db.withAccount(f.account, (c) =>
    c.query(
      `insert into os_binding(account_id,dossier_id,run_id,logical_role_id,request_id,session_id,role_options,definition_hash,message,input_hash,phase,receipt,hold_id)
    values($1,$2,$3,'research-read',$4,$5,jsonb_build_object('dossierId',$2::uuid::text,'role',jsonb_build_object('id','research-read--'||repeat('a',32))),$6,'fixture',$6,'accepted','{}',$7)`,
      [
        f.account,
        f.dossier,
        child,
        request,
        session,
        "a".repeat(64),
        hold.holdId,
      ],
    ),
  );
  const childFixture = {
    ...f,
    run: child,
    session,
    node: node.id as string,
    hold: hold.holdId!,
  };
  await usage(childFixture, "1.5");
  const paid = await settle(childFixture);
  expect(await settle(childFixture)).toEqual(paid);
  const runs = (
    await admin.query(
      "select spent_cny,state from run where id=any($1::uuid[])",
      [[f.run, child]],
    )
  ).rows;
  expect(runs).toHaveLength(2);
  expect(
    runs.every(
      (r) => r.spent_cny === "1.500000" && r.state === "paused_budget",
    ),
  ).toBe(true);
  const nodes = (
    await admin.query(
      "select spent_cny from budget_allocation where id=any($1::uuid[])",
      [[f.root, f.node, node.id]],
    )
  ).rows;
  expect(nodes).toHaveLength(3);
  expect(nodes.every((n) => n.spent_cny === "1.500000")).toBe(true);
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where run_id=any($1::uuid[]) and kind='cost'",
        [[f.run, child]],
      )
    ).rows[0].n,
  ).toBe(1);
});

it("known partial cost survives unknown closure and later full reconciliation books only the delta",async()=>{
 const f=await fixture("research-clarify");await usage(f,"0.007253");
 const pending=await settle(f,false);expect(pending.settled).toBe(false);expect((await snapshot(f)).r.spent_cny).toBe("0.007253");
 await settle(f,false);expect((await snapshot(f)).r.spent_cny).toBe("0.007253");
 await usage(f,"0.001000");const complete=await settle(f,true);expect(complete.settled).toBe(true);
 const final=await snapshot(f);expect(final.r.spent_cny).toBe("0.008253");expect(final.allocations.every(a=>a.spent_cny==="0.008253")).toBe(true);
});

it("an unknown HTTP hold without a settlement receipt can close while its known cost remains booked",async()=>{
 const f=await fixture("research-clarify");await usage(f,"0.007071");
 await admin.query("update budget_hold set state='unpriced' where id=$1",[f.hold]);
 const value=await settle(f,false);expect(value).toMatchObject({settled:false,costCny:null});
 expect(await settle(f,false)).toEqual(value);const s=await snapshot(f);expect(s.r.spent_cny).toBe("0.007071");expect(s.h.state).toBe('unpriced');expect(s.h.actual_cny).toBeNull();
});
