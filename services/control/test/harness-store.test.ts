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
it("T-HAR-2 tighten directly applies, unapproved loosen does not; real user approval appends unique audit", async () => {
  const d = await dossier(),
    base = await store.effective(account, d);
  const tight = await store.propose(
    account,
    d,
    { roles: { "research-read": { tools: { literature: "ask" } } } },
    randomUUID(),
  );
  expect(tight.state).toBe("applied");
  const before = (await store.effective(account, d)).digest;
  expect(before).not.toBe(base.digest);
  const proposed = await store.propose(
    account,
    d,
    { roles: { "research-read": { tools: { literature: "allow" } } } },
    randomUUID(),
  );
  expect(proposed.state).toBe("pending");
  expect(proposed.card.kind).toBe("approval");
  expect((await store.effective(account, d)).digest).toBe(before);
  await expect(
    store.decide(other, proposed.id, "approve"),
  ).rejects.toMatchObject({ status: 404 });
  const receipt = await store.decide(account, proposed.id, "approve");
  expect(receipt.state).toBe("approved");
  expect(await store.decide(account, proposed.id, "approve")).toEqual(receipt);
  await expect(
    store.decide(account, proposed.id, "reject"),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(
    (await store.effective(account, d)).manifest.roles["research-read"].tools
      .literature,
  ).toBe("allow");
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where dossier_id=$1 and action='harness.loosen'",
        [d],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("stale approvals cannot overwrite a newer effective config; rejected proposals do not mutate", async () => {
  const d = await dossier();
  await store.propose(
    account,
    d,
    { roles: { "research-read": { tools: { literature: "ask" } } } },
    randomUUID(),
  );
  const p = await store.propose(
    account,
    d,
    { roles: { "research-read": { tools: { literature: "allow" } } } },
    randomUUID(),
  );
  await store.propose(account, d, { budget: { default_cny: 4 } }, randomUUID());
  await expect(store.decide(account, p.id, "approve")).rejects.toMatchObject({
    code: "HARNESS_STALE",
  });
  const next = await store.propose(
      account,
      d,
      { roles: { "research-read": { tools: { literature: "allow" } } } },
      randomUUID(),
    ),
    before = (await store.effective(account, d)).digest;
  await store.decide(account, next.id, "reject");
  expect((await store.effective(account, d)).digest).toBe(before);
});
it("T-HAR-5 published version is immutable, including prompt contents; app cannot publish or mutate snapshots", async () => {
  await publishBench(admin, bundle, registry);
  await expect(
    publishBench(
      admin,
      {
        ...bundle,
        prompts: { ...bundle.prompts, "research-read": "changed prompt" },
      },
      registry,
    ),
  ).rejects.toMatchObject({ code: "BENCH_VERSION_CONFLICT" });
  await expect(
    db.withAccount(account, (c) =>
      c.query("update bench_version set digest=digest"),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    db.withAccount(account, (c) => c.query("delete from bench_effective")),
  ).rejects.toMatchObject({ code: "42501" });
});
