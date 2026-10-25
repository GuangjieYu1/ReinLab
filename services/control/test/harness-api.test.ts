import { beforeAll, afterAll, it, expect } from "vitest";
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
it("run estimate and confirmed admission bind manifest version/effective hash, config change invalidates quote", async () => {
  const dossier = (
    await (
      await post("/v1/dossiers", { bench: "research", title: "真实清单入口" })
    ).json()
  ).id;
  const quote = await (
    await post("/v1/runs/estimate", { dossierId: dossier, mode: "read" })
  ).json();
  expect(quote.assumptions.benchVersion).toBe("1.1.0");
  expect(quote.assumptions.effectiveConfigDigest).toMatch(/^[a-f0-9]{64}$/);
  const confirmed = await post("/v1/runs", {
    dossierId: dossier,
    mode: "read",
    roleId: "research-read",
    budget: { cny: 1 },
    estimateId: quote.id,
    confirmed: true,
    input: { question: "test" },
  });
  expect(confirmed.status).toBe(201);
  const run = await confirmed.json();
  expect(
    (
      await admin.query(
        "select version,effective_digest from run_harness where run_id=$1",
        [run.id]
      )
    ).rows[0]
  ).toEqual({
    version: "1.1.0",
    effective_digest: quote.assumptions.effectiveConfigDigest,
  });
  const stale = await (
    await post("/v1/runs/estimate", { dossierId: dossier, mode: "read" })
  ).json();
  await harness.propose(
    a,
    dossier,
    { roles: { "research-read": { tools: { literature: "ask" } } } },
    randomUUID()
  );
  expect(
    (
      await post("/v1/runs", {
        dossierId: dossier,
        mode: "read",
        roleId: "research-read",
        budget: { cny: 1 },
        estimateId: stale.id,
        confirmed: true,
        input: { question: "test" },
      })
    ).status
  ).toBe(409);
});
it("unlisted tuning fields return HTTP400 and create no proposal, override, ledger or idempotency receipt", async () => {
  const created = await post("/v1/dossiers", {
    bench: "research",
    title: "tunable reject",
  });
  expect(created.status).toBe(201);
  const dossier = (await created.json()).id;
  const count = () =>
    db.withAccount(
      a,
      async (c) =>
        (
          await c.query(
            `select (select count(*) from harness_proposal where dossier_id=$1)::int proposals,(select count(*) from dossier_override where dossier_id=$1)::int overrides,(select count(*) from event where dossier_id=$1)::int events,(select count(*) from http_request)::int receipts`,
            [dossier]
          )
        ).rows[0]
    );
  const before = await count(),
    digest = (await harness.effective(a, dossier)).digest;
  for (const update of [
    { write_targets: [] },
    { memory: { read: [] } },
    { dossier_note: "unlisted" },
  ]) {
    const response = await post("/v1/dossiers/" + dossier + "/harness/patch", {
      roles: { "research-read": update },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "FIELD_NOT_TUNABLE" });
    expect(await count()).toEqual(before);
    expect((await harness.effective(a, dossier)).digest).toBe(digest);
  }
});
