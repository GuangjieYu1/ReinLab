import { beforeAll, afterAll, it, expect, vi } from "vitest";
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { loadToolRegistry, loadBenchBundle } from "../src/harness/manifest";
import {
  initialEffective,
  planBenchPatch,
  type EffectiveBench,
} from "../src/harness/resolver";
import { publishBench } from "../src/harness/store";
import { canonical } from "../src/api/context";
import { createHarnessRunDefinitionLoader } from "../src/bridge/openscience/run-definition";
const admin = new pg.Pool({
    connectionString: "postgres://postgres@127.0.0.1:55432/reinlab_test",
    max: 2,
  }),
  pool = new pg.Pool({
    connectionString: "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    max: 3,
  }),
  db = new Database(pool);
let registry: Awaited<ReturnType<typeof loadToolRegistry>>,
  base: EffectiveBench;
const routes = {
  cheap: "fixture/cheap",
  mid: "fixture/mid",
  strong: "fixture/strong",
};
const loader = createHarnessRunDefinitionLoader(db, { modelRoutes: routes });
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  registry = await loadToolRegistry();
  const bundle = await loadBenchBundle({ benchId: "research", registry });
  await publishBench(admin, bundle, registry);
  base = initialEffective(bundle);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function fixture(
  input: unknown = { question: "SERVER_RUN_QUESTION" },
  roleId = "research-read",
  snapshot = base,
  modelRoute: string | null = "fixture/reader",
) {
  const account = randomUUID(),
    dossier = randomUUID(),
    otherDossier = randomUUID(),
    run = randomUUID();
  await admin.query("insert into account(id) values($1)", [account]);
  for (const id of [dossier, otherDossier])
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','definition',$3)",
      [id, account, "/data/dossiers/" + id],
    );
  await admin.query(
    "insert into bench_effective(account_id,digest,bench,version,bundle_digest,snapshot) values($1,$2,$3,$4,$5,$6::jsonb)",
    [
      account,
      snapshot.digest,
      snapshot.manifest.id,
      snapshot.manifest.version,
      snapshot.bundleDigest,
      JSON.stringify(snapshot),
    ],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,$4,'read',$5,'queued',1,$6::jsonb)",
    [run, account, dossier, roleId, randomUUID(), JSON.stringify(input)],
  );
  await admin.query(
    "insert into run_harness(account_id,dossier_id,run_id,bench,version,effective_digest,model_route) values($1,$2,$3,$4,$5,$6,$7)",
    [
      account,
      dossier,
      run,
      snapshot.manifest.id,
      snapshot.manifest.version,
      snapshot.digest,
      modelRoute,
    ],
  );
  const thread = randomUUID();
  await admin.query(
    "insert into thread(id,account_id,dossier_id,role_id,summary) values($1,$2,$3,'research-read','MUST_NOT_READ_THREAD_SUMMARY')",
    [thread, account, dossier],
  );
  async function memory(
    layer: string,
    value: unknown,
    settings: {
      dossierId?: string | null;
      threadId?: string | null;
      revoked?: boolean;
      supersedes?: string;
      key?: string;
      evidence?: unknown;
    } = {},
  ) {
    const id = randomUUID(),
      dossierId = Object.hasOwn(settings, "dossierId")
        ? settings.dossierId
        : layer === "L2"
          ? dossier
          : null;
    await admin.query(
      "insert into memory_item(id,account_id,layer,dossier_id,thread_id,key,value,evidence,revoked_at,supersedes) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)",
      [
        id,
        account,
        layer,
        dossierId,
        settings.threadId ?? null,
        settings.key ?? id,
        JSON.stringify(value),
        JSON.stringify(settings.evidence ?? []),
        settings.revoked ? new Date() : null,
        settings.supersedes ?? null,
      ],
    );
    return id;
  }
  return { account, dossier, otherDossier, run, thread, memory };
}
it("loads immutable Harness definition with trusted routes and ignores input authority overrides", async () => {
  const f = await fixture({
    question: "  REAL_QUESTION  ",
    model: "evil/model",
    prompt: "OVERRIDE_PROMPT",
    grants: { bash: "allow" },
    root: "/outside",
    limits: { maxSteps: 2 },
  });
  const result = await loader(f.account, f.run);
  expect(Object.keys(result).sort()).toEqual(["message", "role"]);
  expect(result.message).toBe("REAL_QUESTION");
  expect(result.role.model).toBe("fixture/reader");
  expect(result.role.role.prompt).toBe(base.prompts["research-read"]);
  expect(result.role.role.steps).toBe(2);
  expect(result.role.role.toolGrants.bash).toBeUndefined();
  expect(result.role.dossierId).toBe(f.dossier);
  const tightened = planBenchPatch(
    base,
    { roles: { "research-read": { dossier_note: "NEW_DOSSIER_CONFIG" } } },
    registry,
    100,
  ).candidate;
  await admin.query(
    "insert into bench_effective(account_id,digest,bench,version,bundle_digest,snapshot) values($1,$2,$3,$4,$5,$6::jsonb)",
    [
      f.account,
      tightened.digest,
      "research",
      "1.0.0",
      tightened.bundleDigest,
      JSON.stringify(tightened),
    ],
  );
  await admin.query(
    "insert into dossier_override(account_id,dossier_id,bench,effective_digest,account_tuning_hash) values($1,$2,$3,$4,$5)",
    [f.account, f.dossier, "research", tightened.digest, "fixture"],
  );
  expect((await loader(f.account, f.run)).role.role.prompt).not.toContain(
    "NEW_DOSSIER_CONFIG",
  );
});
it("includes only allowed current L2 and account global L3/L4, never other thread/dossier/L1", async () => {
  const f = await fixture();
  for (const layer of ["L2", "L3", "L4"])
    await f.memory(
      layer,
      { sentinel: "ALLOWED_" + layer },
      { evidence: [{ source: "EVIDENCE_" + layer }] },
    );
  await f.memory("L1", "DENIED_L1", {
    dossierId: f.dossier,
    threadId: f.thread,
  });
  await f.memory("L2", "DENIED_OTHER_DOSSIER", { dossierId: f.otherDossier });
  await f.memory("L2", "DENIED_THREAD", {
    dossierId: f.dossier,
    threadId: f.thread,
  });
  await f.memory("L3", "DENIED_SCOPED_GLOBAL", { dossierId: f.dossier });
  await f.memory("L4", "DENIED_SCOPED_THREAD", {
    dossierId: f.dossier,
    threadId: f.thread,
  });
  await f.memory("L2", "DENIED_REVOKED", { revoked: true });
  const old = await f.memory("L2", "DENIED_SUPERSEDED");
  await f.memory("L2", "ALLOWED_NEW", { supersedes: old });
  const memory = (await loader(f.account, f.run)).role.memory;
  for (const item of [
    "ALLOWED_L2",
    "ALLOWED_L3",
    "ALLOWED_L4",
    "ALLOWED_NEW",
    "EVIDENCE_L2",
  ])
    expect(memory).toContain(item);
  for (const item of ["DENIED_", "MUST_NOT_READ_THREAD_SUMMARY"])
    expect(memory).not.toContain(item);
});
it("explicit UUID memoryRefs only narrow scope and empty list injects no memory", async () => {
  const f = await fixture(),
    allowed = await f.memory("L2", "SELECTED_ALLOWED"),
    other = await f.memory("L2", "UNSELECTED_ALLOWED"),
    forbidden = await f.memory("L2", "SELECTED_FORBIDDEN", {
      dossierId: f.otherDossier,
    });
  await admin.query("update run set input=$2::jsonb where id=$1", [
    f.run,
    JSON.stringify({ question: "refs", memoryRefs: [allowed, forbidden] }),
  ]);
  const result = await loader(f.account, f.run);
  expect(result.role.memory).toContain("SELECTED_ALLOWED");
  expect(result.role.memory).not.toContain("UNSELECTED_ALLOWED");
  expect(result.role.memory).not.toContain("SELECTED_FORBIDDEN");
  expect(result.role.memory).not.toContain(other);
  await admin.query("update run set input=$2::jsonb where id=$1", [
    f.run,
    JSON.stringify({ memoryRefs: [] }),
  ]);
  expect((await loader(f.account, f.run)).role.memory).toBe("");
});
it("filters role read layers and leaves assigned-citations memory empty pending P1-15", async () => {
  const candidate = planBenchPatch(
      base,
      { roles: { "research-read": { memory: { read: ["L2"] } } } },
      registry,
      100,
    ).candidate,
    f = await fixture({}, "research-read", candidate);
  await f.memory("L2", "LAYER_ALLOWED");
  await f.memory("L3", "LAYER_FORBIDDEN");
  const result = await loader(f.account, f.run);
  expect(result.role.memory).toContain("LAYER_ALLOWED");
  expect(result.role.memory).not.toContain("LAYER_FORBIDDEN");
  const assigned = await fixture({}, "swarm-verifier"),
    id = await assigned.memory("L2", "UNVALIDATED_CITATION");
  await admin.query("update run set input=$2::jsonb where id=$1", [
    assigned.run,
    JSON.stringify({ memoryRefs: [id] }),
  ]);
  expect((await loader(assigned.account, assigned.run)).role.memory).toBe("");
});
it("denies foreign account and missing snapshot instead of falling back to role_def", async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(loader(other.account, f.run)).rejects.toMatchObject({
    status: 404,
  });
  const unbound = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'queued',1)",
    [unbound, f.account, f.dossier, randomUUID()],
  );
  await expect(loader(f.account, unbound)).rejects.toMatchObject({
    code: "HARNESS_SNAPSHOT_MISSING",
    status: 409,
  });
});
it("uses bounded canonical input fallback and rejects invalid step/ref fields", async () => {
  const f = await fixture({ z: 1, a: { b: "value" }, question: " " });
  expect((await loader(f.account, f.run)).message).toBe(
    canonical({ z: 1, a: { b: "value" }, question: " " }),
  );
  for (const input of [
    { limits: { maxSteps: 49 } },
    { limits: { maxSteps: 0 } },
    { limits: { maxSteps: 1.5 } },
    { memoryRefs: ["/data/secret"] },
    { memoryRefs: "not-array" },
    { question: "x".repeat(1000001) },
  ]) {
    await admin.query("update run set input=$2::jsonb where id=$1", [
      f.run,
      JSON.stringify(input),
    ]);
    await expect(loader(f.account, f.run)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      status: 400,
    });
  }
});
it("fails closed on corrupt immutable snapshots and oversized memory JSON", async () => {
  const corrupt = structuredClone(base);
  corrupt.prompts["research-read"] = "CORRUPT_WITHOUT_DIGEST";
  const f = await fixture({}, "research-read", corrupt);
  await expect(loader(f.account, f.run)).rejects.toMatchObject({
    code: "HARNESS_CORRUPT",
    status: 503,
  });
  const big = await fixture();
  await big.memory("L2", { text: "x".repeat(131073) });
  await expect(loader(big.account, big.run)).rejects.toMatchObject({
    code: "MEMORY_TOO_LARGE",
    status: 413,
  });
});
it("has no model fallback for a missing confirmed route", async () => {
  const f = await fixture({}, "research-read", base, null);
  await expect(
    createHarnessRunDefinitionLoader(db, { modelRoutes: routes })(
      f.account,
      f.run,
    ),
  ).rejects.toMatchObject({ code: "MODEL_ROUTE_UNBOUND", status: 409 });
});
it("rejects malformed stored routes even if a read adapter returns a corrupt row", async () => {
  const f = await fixture();
  for (const route of [
    "",
    "invalid",
    "https://invalid.test/model",
    "fixture/model?override=1",
  ]) {
    const observed = Object.create(db) as Database;
    observed.withAccount = (account, work) =>
      db.withAccount(account, (client) =>
        work(
          new Proxy(client, {
            get(target, key) {
              if (key === "query")
                return async (sql: string, args: unknown[]) => {
                  const result = await target.query(sql, args);
                  if (sql.includes("from run r"))
                    return {
                      ...result,
                      rows: result.rows.map((row) => ({
                        ...row,
                        model_route: route,
                      })),
                    };
                  return result;
                };
              return Reflect.get(target, key);
            },
          }),
        ),
      );
    await expect(
      createHarnessRunDefinitionLoader(observed, { modelRoutes: routes })(
        f.account,
        f.run,
      ),
    ).rejects.toMatchObject({ code: "MODEL_ROUTE_UNBOUND", status: 409 });
  }
});
it("pins the quote route across server route changes and ignores input model overrides", async () => {
  const first = await fixture(
      { question: "confirmed", model: "evil/model" },
      "research-read",
      base,
      "fixture/confirmed-first",
    ),
    second = await fixture(
      {},
      "research-read",
      base,
      "fixture/confirmed-second",
    );
  const old = createHarnessRunDefinitionLoader(db, {
    modelRoutes: { strong: "fixture/config-at-create" },
  });
  routes.strong = "fixture/config-after-confirm";
  const changed = createHarnessRunDefinitionLoader(db, { modelRoutes: routes });
  for (const load of [
    old,
    changed,
    createHarnessRunDefinitionLoader(db, { modelRoutes: {} }),
  ]) {
    expect((await load(first.account, first.run)).role.model).toBe(
      "fixture/confirmed-first",
    );
    expect((await load(second.account, second.run)).role.model).toBe(
      "fixture/confirmed-second",
    );
  }
});

it("uses only read queries and never consults role_def or current configuration", async () => {
  const f = await fixture(),
    queries: string[] = [];
  const observed = Object.create(db) as Database;
  observed.withAccount = (account, work) =>
    db.withAccount(account, (client) =>
      work(
        new Proxy(client, {
          get(target, key) {
            if (key === "query")
              return (sql: string, args: unknown[]) => {
                queries.push(sql);
                return target.query(sql, args);
              };
            return Reflect.get(target, key);
          },
        }),
      ),
    );
  await createHarnessRunDefinitionLoader(observed, { modelRoutes: routes })(
    f.account,
    f.run,
  );
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    expect(query.trim()).toMatch(/^select /i);
    expect(query).not.toMatch(
      /role_def|dossier_override|bench_tuning|thread /i,
    );
  }
});
it("uses the stored quote route despite environment changes and excludes foreign memory references", async () => {
  vi.stubEnv("MODEL_ROUTE_STRONG", "fixture/server-env");
  try {
    const f = await fixture(),
      foreign = await fixture(),
      id = await foreign.memory("L3", "FOREIGN_GLOBAL_MEMORY");
    await admin.query("update run set input=$2::jsonb where id=$1", [
      f.run,
      JSON.stringify({
        question: "safe",
        memoryRefs: [id],
        model: "evil/model",
      }),
    ]);
    const environmental = createHarnessRunDefinitionLoader(db);
    vi.stubEnv("MODEL_ROUTE_STRONG", "fixture/changed-after-construction");
    const result = await environmental(f.account, f.run);
    expect(result.role.model).toBe("fixture/reader");
    expect(result.role.memory).toBe("");
  } finally {
    vi.unstubAllEnvs();
  }
});
