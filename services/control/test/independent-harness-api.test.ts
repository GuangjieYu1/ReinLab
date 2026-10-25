import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import pg from "pg";
import { SignJWT } from "jose";
import { applyMigrations } from "../src/db/migrate";
import { loadToolRegistry, loadBenchBundle } from "../src/harness/manifest";
import { HarnessStore, publishBench } from "../src/harness/store";
import { Database } from "../src/db/database";
import { PricingService } from "../src/budget/pricing";
import { createApp } from "../src/api/app";
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
  a = randomUUID(),
  secret = randomBytes(48),
  issuer = "http://localhost/harness-api/auth/v1";
let app: Awaited<ReturnType<typeof createApp>>,
  token: string,
  harness: HarnessStore;
let callback: (account: string, run: string) => Promise<void> = async () => {};
const server = createServer((_q, r) =>
  r.end(
    JSON.stringify({
      fixture: {
        models: {
          model: {
            cost: { input: 1, output: 2 },
            limit: { context: 32000, output: 4096 },
          },
        },
      },
    })
  )
);
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id) values($1)", [a]);
  const registry = await loadToolRegistry(),
    bundle = await loadBenchBundle({
      benchId: "research",
      registry,
      version: "1.1.0",
    });
  await publishBench(admin, bundle, registry);
  harness = new HarnessStore(db, bundle, registry);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(a)
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  app = await createApp({
    pool,
    auth: { issuer, secret },
    harness,
    onRunQueued: (account, run) => callback(account, run),
    pricing: new PricingService({
      catalogUrl:
        "http://127.0.0.1:" + (server.address() as { port: number }).port,
      routes: {
        cheap: "fixture/model",
        mid: "fixture/model",
        strong: "fixture/model",
      },
      usdCny: "7.2",
    }),
  });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await admin.end();
});
async function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

async function samePost(path: string, body: unknown, key: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}
async function admission() {
  const d = await (
    await post("/v1/dossiers", { bench: "research", title: "independent API" })
  ).json();
  const q = await (
    await post("/v1/runs/estimate", { dossierId: d.id, mode: "read" })
  ).json();
  return {
    dossier: d.id,
    body: {
      dossierId: d.id,
      mode: "read",
      roleId: "research-read",
      budget: { cny: 1 },
      estimateId: q.id,
      confirmed: true,
      input: { question: "fixture" },
    },
  };
}
it("independent postcommit callback sees durable run and HTTP idempotent replay never executes again", async () => {
  const f = await admission(),
    key = randomUUID();
  callback = vi.fn(async (account, run) => {
    expect(account).toBe(a);
    expect(
      (
        await admin.query(
          "select model_route from run_harness where run_id=$1",
          [run]
        )
      ).rows[0]
    ).toEqual({ model_route: "fixture/model" });
  });
  const one = await samePost("/v1/runs", f.body, key),
    two = await samePost("/v1/runs", f.body, key);
  expect(one.status).toBe(201);
  expect(two.status).toBe(201);
  expect(await two.json()).toEqual(await one.json());
  expect(callback).toHaveBeenCalledTimes(1);
});
it("independent postcommit callback failure preserves successful durable admission receipt", async () => {
  const f = await admission(),
    key = randomUUID();
  callback = vi.fn(async () => {
    throw Error("fixture downstream unavailable");
  });
  const one = await samePost("/v1/runs", f.body, key);
  expect(one.status).toBe(201);
  const saved = await one.json();
  expect(
    (await admin.query("select id from run where id=$1", [saved.id])).rowCount
  ).toBe(1);
  const two = await samePost("/v1/runs", f.body, key);
  expect(two.status).toBe(201);
  expect(await two.json()).toEqual(saved);
  expect(callback).toHaveBeenCalledTimes(1);
  const errors = (
    await admin.query(
      "select payload from event where run_id=$1 and action='run_admission_deferred'",
      [saved.id]
    )
  ).rows;
  expect(errors).toEqual([{ payload: { code: "ADMISSION_DEFERRED" } }]);
});
it("independent quote tier/default policy comes from current manifest config, stale quote creates no run", async () => {
  callback = async () => {};
  const d = await (
      await post("/v1/dossiers", { bench: "research", title: "tier policy" })
    ).json(),
    slot = harness.bundle.manifest.roles["research-read"].model_slot;
  await harness.propose(
    a,
    d.id,
    {
      model_slots: { [slot]: "cheap" },
      budget: { default_cny: 4, by_mode: { read: 3 } },
    },
    randomUUID()
  );
  const q = await (
    await post("/v1/runs/estimate", { dossierId: d.id, mode: "read" })
  ).json();
  expect(q.modelTier).toBe("cheap");
  expect(q.defaultBudgetCny).toBe("3.000000");
  await harness.propose(
    a,
    d.id,
    { budget: { by_mode: { read: 2 } } },
    randomUUID()
  );
  const before = (
    await admin.query("select count(*)::int n from run where dossier_id=$1", [
      d.id,
    ])
  ).rows[0].n;
  const rejected = await post("/v1/runs", {
    dossierId: d.id,
    mode: "read",
    roleId: "research-read",
    budget: { cny: 1 },
    estimateId: q.id,
    confirmed: true,
    input: { question: "fixture" },
  });
  expect(rejected.status).toBe(409);
  expect(
    (
      await admin.query("select count(*)::int n from run where dossier_id=$1", [
        d.id,
      ])
    ).rows[0].n
  ).toBe(before);
});

it("independent server route change at the same manifest tier rejects the old quote", async () => {
  callback = async () => {};
  const f = await admission();
  const restarted = await createApp({
    pool,
    auth: { issuer, secret },
    harness,
    pricing: new PricingService({
      catalogUrl:
        "http://127.0.0.1:" + (server.address() as { port: number }).port,
      routes: {
        cheap: "fixture/model2",
        mid: "fixture/model2",
        strong: "fixture/model2",
      },
      usdCny: "7.2",
    }),
  });
  const response = await restarted.request("/v1/runs", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(f.body),
  });
  expect(response.status).toBe(409);
  expect(
    (
      await admin.query(
        "select count(*)::int n from run where estimate_id=$1",
        [f.body.estimateId]
      )
    ).rows[0].n
  ).toBe(0);
});
