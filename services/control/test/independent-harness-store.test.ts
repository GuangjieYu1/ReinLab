import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { HarnessStore, publishBench } from "../src/harness/store";
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
  account = randomUUID(),
  other = randomUUID();
let store: HarnessStore,
  bundle: Awaited<ReturnType<typeof loadBenchBundle>>,
  registry: Awaited<ReturnType<typeof loadToolRegistry>>;
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await db.assertSafeRole();
  await admin.query("insert into account(id) values($1),($2)", [
    account,
    other,
  ]);
  registry = await loadToolRegistry();
  bundle = await loadBenchBundle({ benchId: "research", registry });
  await publishBench(admin, bundle, registry);
  store = new HarnessStore(db, bundle, registry);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function dossier() {
  const id = randomUUID();
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','harness',$3)",
    [id, account, "/data/dossiers/" + id],
  );
  return id;
}

it("independent concurrent proposal and decisions produce one approval receipt and audit", async () => {
  const d = await dossier();
  await store.propose(
    account,
    d,
    { roles: { "research-read": { tools: { literature: "ask" } } } },
    randomUUID(),
  );
  const id = randomUUID(),
    patch = { roles: { "research-read": { tools: { literature: "allow" } } } },
    before = (await store.effective(account, d)).digest;
  const proposals = await Promise.all(
    Array.from({ length: 6 }, () => store.propose(account, d, patch, id)),
  );
  expect(new Set(proposals.map((p) => p.digest)).size).toBe(1);
  expect((await store.effective(account, d)).digest).toBe(before);
  const receipts = await Promise.all(
    Array.from({ length: 6 }, () => store.decide(account, id, "approve")),
  );
  expect(receipts.every((r) => r.digest === receipts[0].digest)).toBe(true);
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where dossier_id=$1 and action='harness.loosen'",
        [d],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("independent account tightening composes before dossier proposal, and tuning changes stale old proposal", async () => {
  const d = await dossier();
  await db.withAccount(account, (c) =>
    c.query(
      "insert into bench_tuning(account_id,bench,patch) values($1,$2,$3)",
      [
        account,
        "research",
        { roles: { "research-read": { tools: { literature: "ask" } } } },
      ],
    ),
  );
  expect(
    (await store.effective(account, d)).manifest.roles["research-read"].tools
      .literature,
  ).toBe("ask");
  const p = await store.propose(
    account,
    d,
    { roles: { "research-read": { tools: { literature: "allow" } } } },
    randomUUID(),
  );
  await db.withAccount(account, (c) =>
    c.query("update bench_tuning set patch=$2 where account_id=$1", [
      account,
      { roles: { "research-read": { tools: { literature: "deny" } } } },
    ]),
  );
  await expect(store.decide(account, p.id, "approve")).rejects.toMatchObject({
    code: "HARNESS_STALE",
  });
  await db.withAccount(account, (c) =>
    c.query("update bench_tuning set patch=$2 where account_id=$1", [
      account,
      {},
    ]),
  );
});
it("independent account tuning cannot loosen permissions or smuggle approved boolean", async () => {
  const d = await dossier();
  for (const patch of [
    { roles: { "research-read": { tools: { read: "ask" } } } },
    { approved: true },
  ]) {
    await db.withAccount(account, (c) =>
      c.query(
        "insert into bench_tuning(account_id,bench,patch) values($1,$2,$3) on conflict(account_id,bench) do update set patch=excluded.patch",
        [account, "research", patch],
      ),
    );
    await expect(store.effective(account, d)).rejects.toThrow();
  }
  await db.withAccount(account, (c) =>
    c.query("update bench_tuning set patch=$2 where account_id=$1", [
      account,
      {},
    ]),
  );
});
it("independent proposal is tenant scoped and patch/base immutable", async () => {
  const d = await dossier(),
    p = await store.propose(
      account,
      d,
      { roles: { "research-read": { tools: { read: "ask" } } } },
      randomUUID(),
    );
  expect(
    (
      await db.withAccount(other, (c) =>
        c.query("select * from harness_proposal where id=$1", [p.id]),
      )
    ).rowCount,
  ).toBe(0);
  await expect(store.decide(other, p.id, "approve")).rejects.toMatchObject({
    code: "RLS_DENIED",
  });
  await expect(
    db.withAccount(account, (c) =>
      c.query("update harness_proposal set patch='{}' where id=$1", [p.id]),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.withAccount(account, (c) =>
      c.query("update bench_effective set snapshot=snapshot"),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    db.withAccount(account, (c) =>
      c.query(
        "insert into bench_version(bench,version,digest,bundle,registry) values('other','1.0.0',repeat('a',64),'{}','{}')",
      ),
    ),
  ).rejects.toMatchObject({ code: "42501" });
});
it("independent proposal replay refuses same id with different patch without changing effective", async () => {
  const d = await dossier(),
    id = randomUUID();
  await store.propose(
    account,
    d,
    { roles: { "research-read": { tools: { read: "ask" } } } },
    id,
  );
  const before = (await store.effective(account, d)).digest;
  await expect(
    store.propose(account, d, { budget: { default_cny: 4 } }, id),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect((await store.effective(account, d)).digest).toBe(before);
});

it("independent saved dossier override cannot exceed a lowered current account cap", async () => {
  const d = await dossier();
  await store.propose(
    account,
    d,
    { budget: { default_cny: 200 } },
    randomUUID(),
  );
  await admin.query("update account set monthly_budget_cny=100 where id=$1", [
    account,
  ]);
  try {
    await expect(store.effective(account, d)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  } finally {
    await admin.query("update account set monthly_budget_cny=300 where id=$1", [
      account,
    ]);
  }
});
