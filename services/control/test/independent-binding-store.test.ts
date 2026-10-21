import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { BindingStore } from "../src/bridge/openscience/binding-store";
const admin = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 4,
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ??
    "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 12,
});
const db = new Database(pool),
  store = new BindingStore(db);
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await db.assertSafeRole();
}, 30000);
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function fixture(accountId = randomUUID()) {
  const dossierId = randomUUID(),
    runId = randomUUID(),
    requestId = randomUUID();
  await admin.query(
    "insert into account(id) values($1) on conflict do nothing",
    [accountId],
  );
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','independent binding',$3)",
    [dossierId, accountId, "/data/dossiers/" + dossierId],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'queued',1,'{}')",
    [runId, accountId, dossierId, requestId],
  );
  const role = {
    dossierId,
    role: {
      id: "research-read",
      prompt: "普通独立绑定测试角色",
      toolGrants: { read: { risk: "read", permission: "allow" } },
      writeTargets: [],
      steps: 2,
    },
    memory: "fixture memory",
    model: "deepseek/deepseek-v4-flash",
  };
  return {
    accountId,
    dossierId,
    runId,
    requestId,
    input: { role, message: "independent fixture message" },
  };
}
async function prepared() {
  const f = await fixture();
  const binding = await store.prepare(f.accountId, f.runId, f.input);
  return { ...f, binding };
}
/** Direct app-role boundary checks are always rolled back, including unexpected success. */
async function probe<T>(
  accountId: string,
  work: (client: pg.PoolClient) => Promise<T>,
) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.account_id',$1,true)", [accountId]);
    return await work(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}
async function code(work: () => Promise<unknown>) {
  try {
    await work();
    return null;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}
it("eight concurrent preparations converge on one durable binding/session, changed content conflicts", async () => {
  const f = await fixture(),
    bindings = await Promise.all(
      Array.from({ length: 8 }, () =>
        new BindingStore(db).prepare(f.accountId, f.runId, f.input),
      ),
    );
  expect(new Set(bindings.map((b) => b.sessionId)).size).toBe(1);
  expect(new Set(bindings.map((b) => b.inputHash)).size).toBe(1);
  expect(
    (
      await admin.query(
        "select count(*)::int n from os_binding where run_id=$1",
        [f.runId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await admin.query("select os_session_id from run where id=$1", [f.runId]))
      .rows[0].os_session_id,
  ).toBe(bindings[0].sessionId);
  await expect(
    store.prepare(f.accountId, f.runId, { ...f.input, message: "changed" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
});
it("two concurrent different preparations admit one content and conflict the other", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    store.prepare(f.accountId, f.runId, f.input),
    store.prepare(f.accountId, f.runId, {
      ...f.input,
      message: "another message",
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const failed = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
it("only one concurrent claim wins; expired lease permits a new token but stale CAS cannot write", async () => {
  const f = await prepared(),
    tokens = await Promise.all(
      Array.from({ length: 8 }, () => store.claim(f.accountId, f.runId)),
    );
  const winners = tokens.filter((token): token is string => token !== null);
  expect(winners).toHaveLength(1);
  const old = winners[0];
  await store.baseline(f.accountId, f.runId, old, 10);
  await admin.query(
    "update os_binding set lease_until=now()-interval '1 second' where run_id=$1",
    [f.runId],
  );
  await expect(
    store.baseline(f.accountId, f.runId, old, 11),
  ).rejects.toMatchObject({ code: "BINDING_LEASE_LOST" });
  const fresh = (await store.claim(f.accountId, f.runId))!;
  expect(fresh).toBeTruthy();
  expect(fresh).not.toBe(old);
  await expect(
    store.sendIntent(f.accountId, f.runId, old),
  ).rejects.toMatchObject({ code: "BINDING_LEASE_LOST" });
  await store.baseline(f.accountId, f.runId, fresh, 11);
  await store.sendIntent(f.accountId, f.runId, fresh);
  expect((await store.get(f.accountId, f.runId)).phase).toBe("submitting");
});
it("submitting remains fenced after restart and expiry; receipt resolves once without a second send claim", async () => {
  const f = await prepared(),
    token = (await store.claim(f.accountId, f.runId))!;
  await store.baseline(f.accountId, f.runId, token, 0);
  await store.sendIntent(f.accountId, f.runId, token);
  await admin.query(
    "update os_binding set lease_until=now()-interval '1 day' where run_id=$1",
    [f.runId],
  );
  const restarted = new BindingStore(db);
  expect(await restarted.claim(f.accountId, f.runId)).toBeNull();
  await expect(
    restarted.sendIntent(f.accountId, f.runId, token),
  ).rejects.toMatchObject({ code: "BINDING_LEASE_LOST" });
  const receipt = { runID: "run_independent_" + randomUUID(), acceptedAt: 123 };
  expect(await restarted.receipt(f.accountId, f.runId, receipt)).toEqual(
    receipt,
  );
  expect(await store.receipt(f.accountId, f.runId, receipt)).toEqual(receipt);
  expect(await store.claim(f.accountId, f.runId)).toBeNull();
  await expect(
    store.receipt(f.accountId, f.runId, { ...receipt, acceptedAt: 124 }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(
    (await admin.query("select os_run_id from run where id=$1", [f.runId]))
      .rows[0].os_run_id,
  ).toBe(receipt.runID);
});
it("foreign tenants cannot get/prepare/claim/baseline/send/receipt and direct table RLS hides rows", async () => {
  const f = await prepared(),
    foreign = await fixture();
  for (const work of [
    () => store.get(foreign.accountId, f.runId),
    () => store.prepare(foreign.accountId, f.runId, f.input),
    () => store.claim(foreign.accountId, f.runId),
    () => store.baseline(foreign.accountId, f.runId, randomUUID(), 1),
    () => store.sendIntent(foreign.accountId, f.runId, randomUUID()),
    () =>
      store.receipt(foreign.accountId, f.runId, {
        runID: "run_foreign",
        acceptedAt: 1,
      }),
  ])
    await expect(work()).rejects.toMatchObject({
      code: "RLS_DENIED",
      status: 404,
    });
  expect(
    (
      await probe(foreign.accountId, (c) =>
        c.query("select * from os_binding where run_id=$1", [f.runId]),
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await probe(foreign.accountId, (c) =>
        c.query("update os_binding set initialized=true where run_id=$1", [
          f.runId,
        ]),
      )
    ).rowCount,
  ).toBe(0);
  expect(
    await code(() =>
      probe(f.accountId, (c) =>
        c.query("delete from os_binding where run_id=$1", [f.runId]),
      ),
    ),
  ).toBe("42501");
  expect(
    await code(() => probe(f.accountId, (c) => c.query("truncate os_binding"))),
  ).toBe("42501");
});
it("all immutable binding identity/content columns reject app-role updates and preserve original row", async () => {
  const f = await prepared(),
    before = (
      await admin.query("select * from os_binding where run_id=$1", [f.runId])
    ).rows[0];
  const changes: Record<string, unknown> = {
    account_id: randomUUID(),
    dossier_id: randomUUID(),
    run_id: randomUUID(),
    logical_role_id: "swarm-lead",
    request_id: randomUUID(),
    session_id: "ses_rl" + randomUUID().replaceAll("-", ""),
    role_options: JSON.stringify({ ...f.binding.role, memory: "altered" }),
    definition_hash: "0".repeat(64),
    message: "altered",
    input_hash: "1".repeat(64),
  };
  for (const [field, value] of Object.entries(changes))
    expect(
      await code(() =>
        probe(f.accountId, (c) =>
          c.query("update os_binding set " + field + "=$2 where run_id=$1", [
            f.runId,
            value,
          ]),
        ),
      ),
    ).toBe("23514");
  expect(
    (await admin.query("select * from os_binding where run_id=$1", [f.runId]))
      .rows[0],
  ).toEqual(before);
});
it("database preserves monotonic cursor, send fence, and accepted receipt against direct app updates", async () => {
  const f = await prepared(),
    token = (await store.claim(f.accountId, f.runId))!;
  await store.baseline(f.accountId, f.runId, token, 12);
  expect(
    await code(() =>
      probe(f.accountId, (c) =>
        c.query("update os_binding set cursor=11 where run_id=$1", [f.runId]),
      ),
    ),
  ).toBe("23514");
  await store.sendIntent(f.accountId, f.runId, token);
  expect(
    await code(() =>
      probe(f.accountId, (c) =>
        c.query("update os_binding set phase='preparing' where run_id=$1", [
          f.runId,
        ]),
      ),
    ),
  ).toBe("23514");
  const receipt = { runID: "run_final", acceptedAt: 2 };
  await store.receipt(f.accountId, f.runId, receipt);
  expect(
    await code(() =>
      probe(f.accountId, (c) =>
        c.query("update os_binding set receipt=$2::jsonb where run_id=$1", [
          f.runId,
          JSON.stringify({ ...receipt, runID: "run_replaced" }),
        ]),
      ),
    ),
  ).toBe("23514");
  expect((await store.get(f.accountId, f.runId)).receipt).toEqual(receipt);
});
it("same request cannot create another run in one account, while another account remains independent", async () => {
  const f = await prepared(),
    foreign = await fixture();
  expect(
    await code(() =>
      probe(f.accountId, (c) =>
        c.query(
          "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'queued',1)",
          [randomUUID(), f.accountId, f.dossierId, f.requestId],
        ),
      ),
    ),
  ).toBe("23505");
  await admin.query("update run set request_id=$2 where id=$1", [
    foreign.runId,
    f.requestId,
  ]);
  const other = await store.prepare(
    foreign.accountId,
    foreign.runId,
    foreign.input,
  );
  expect(other.requestId).toBe(f.requestId);
  expect(other.sessionId).not.toBe(f.binding.sessionId);
});
it("binding table refuses an inserted request/role identity inconsistent with its parent run", async () => {
  const f = await prepared(),
    another = await fixture(f.accountId);
  const rejected = await code(() =>
    probe(f.accountId, (c) =>
      c.query(
        `insert into os_binding(account_id,dossier_id,run_id,logical_role_id,request_id,session_id,role_options,definition_hash,message,input_hash) select account_id,$2::uuid,$3,logical_role_id,$4,$5,jsonb_set(role_options,'{dossierId}',to_jsonb($2::text)),definition_hash,message,input_hash from os_binding where run_id=$1`,
        [
          f.runId,
          another.dossierId,
          another.runId,
          "forged_" + randomUUID(),
          "ses_rl" + randomUUID().replaceAll("-", ""),
        ],
      ),
    ),
  );
  expect(rejected).toBe("23503");
});

it("binding table refuses parent logical-role mismatch independently of request identity", async () => {
  const f = await prepared(),
    another = await fixture(f.accountId);
  const rejected = await code(() =>
    probe(f.accountId, (c) =>
      c.query(
        `insert into os_binding(account_id,dossier_id,run_id,logical_role_id,request_id,session_id,role_options,definition_hash,message,input_hash) select account_id,$2::uuid,$3,'swarm-lead',$4,$5,jsonb_set(role_options,'{dossierId}',to_jsonb($2::text)),definition_hash,message,input_hash from os_binding where run_id=$1`,
        [
          f.runId,
          another.dossierId,
          another.runId,
          another.requestId,
          "ses_rl" + randomUUID().replaceAll("-", ""),
        ],
      ),
    ),
  );
  expect(["23503", "23514"]).toContain(rejected);
});
it("binding table refuses role_options dossier mismatch even with correct parent run/role/request", async () => {
  const f = await prepared(),
    another = await fixture(f.accountId);
  const rejected = await code(() =>
    probe(f.accountId, (c) =>
      c.query(
        `insert into os_binding(account_id,dossier_id,run_id,logical_role_id,request_id,session_id,role_options,definition_hash,message,input_hash) select account_id,$2,$3,logical_role_id,$4,$5,role_options,definition_hash,message,input_hash from os_binding where run_id=$1`,
        [
          f.runId,
          another.dossierId,
          another.runId,
          another.requestId,
          "ses_rl" + randomUUID().replaceAll("-", ""),
        ],
      ),
    ),
  );
  expect(rejected).toBe("23514");
});
