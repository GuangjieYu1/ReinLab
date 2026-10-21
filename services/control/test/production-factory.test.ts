import { afterAll, beforeAll, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import {
  machinePlan,
  encryptBundle,
  OS_VERSION,
} from "../src/provisioner/runtime";
import { dockerPlan } from "../src/provisioner/docker";
import type {
  AccountDriver,
  AccountMachine,
  AccountVolume,
  PlanInput,
} from "../src/provisioner/driver";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import { planRoleProject } from "../src/bridge/openscience/role-project";
import { createProductionRuntimeFactory } from "../src/bridge/openscience/production-factory";
const admin = new pg.Pool({
    connectionString: "postgres://postgres@127.0.0.1:55432/reinlab_test",
    max: 2,
  }),
  pool = new pg.Pool({
    connectionString: "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    max: 3,
  }),
  db = new Database(pool);
beforeAll(() => applyMigrations(admin, resolve("infra/supabase/migrations")));
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function fixture(kind: "fly" | "docker" = "fly") {
  const account = randomUUID(),
    master = Buffer.alloc(32, 7),
    tokens = { auth: "a".repeat(43), container: "b".repeat(43) },
    machineId =
      kind === "fly" ? "1234567890abcd" : "rl-" + account.replaceAll("-", ""),
    volumeId =
      kind === "fly" ? "vol_fixture" : "rl_" + account.replaceAll("-", "");
  const image =
      kind === "fly"
        ? "registry.fly.io/reinlab-accounts:fixture"
        : "reinlab-account:fixture",
    controlUrl =
      kind === "fly"
        ? "http://control.internal/"
        : "http://host.docker.internal:3001/",
    app = "reinlab-accounts";
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into account_machine(account_id,fly_machine_id,fly_volume_id,state,os_version,image) values($1,$2,$3,'ready',$4,$5)",
    [account, machineId, volumeId, OS_VERSION, image],
  );
  await admin.query(
    "insert into account_machine_secret(account_id,envelope) values($1,$2::jsonb)",
    [account, JSON.stringify(encryptBundle(account, master, tokens))],
  );
  const plan = (input: PlanInput) =>
      kind === "fly" ? machinePlan(input) : dockerPlan(input),
    expected = plan({
      accountId: account,
      volumeId,
      image,
      controlUrl,
      tokens,
    });
  let machines: AccountMachine[] = [
      { ...expected, id: machineId, state: "started" },
    ],
    volumes: AccountVolume[] = [
      {
        id: volumeId,
        name: "rl_" + account.replaceAll("-", ""),
        region: expected.region,
        attached_machine_id: machineId,
      },
    ],
    endpoint =
      kind === "fly"
        ? "http://" + machineId + ".vm." + app + ".internal:4096"
        : "http://127.0.0.1:49123",
    mutations = 0,
    calls = 0;
  if (kind === "docker") {
    delete (machines[0].config as any).guest;
    (machines[0].config.env as any).PATH = "/usr/local/bin:/usr/bin";
  }
  const keys: Buffer[] = [];
  const vault = {
    async key() {
      const key = Buffer.from(master);
      keys.push(key);
      return key;
    },
  };
  const driver: AccountDriver = {
    kind,
    region: expected.region,
    plan,
    validateImage() {},
    validateDeployment() {},
    async listMachines() {
      return machines;
    },
    async listVolumes() {
      return volumes;
    },
    async endpoint() {
      return endpoint;
    },
    async createMachine() {
      mutations++;
      throw Error("forbidden");
    },
    async createVolume() {
      mutations++;
      throw Error("forbidden");
    },
    async start() {
      mutations++;
    },
    async update() {
      mutations++;
    },
  };
  const role = {
    dossierId: randomUUID(),
    role: {
      id: "factory-fixture",
      prompt: "fixture",
      toolGrants: {},
      writeTargets: [],
      steps: 2,
    },
    model: "fixture/model",
    memory: "",
  };
  let receiptAccount = account;
  const transport = (async (url, init) => {
    calls++;
    expect(String(url)).toBe(endpoint + "/reinlab/roles/prepare");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + tokens.auth,
    );
    const body = JSON.parse(String(init?.body));
    expect(body.root).toBeUndefined();
    expect(body.pluginUrl).toBeUndefined();
    const rolePlan = planRoleProject({
      ...body,
      root: "/data",
      pluginUrl: "file:///opt/reinlab/plugin/index.js",
    });
    return Response.json({
      schemaVersion: 1,
      accountId: receiptAccount,
      ...rolePlan.project,
      pluginUrl: rolePlan.pluginUrl,
      hashes: rolePlan.hashes,
    });
  }) as typeof fetch;
  const factory = () =>
    createProductionRuntimeFactory(db, {
      driver,
      vault,
      app,
      controlUrl,
      transport,
    });
  return {
    account,
    role,
    defaultFactory(value: string | null, queries: unknown[][]) {
      const readonlyDb = Object.create(db) as Database;
      readonlyDb.withAccount = (id, work) =>
        db.withAccount(id, (client) => {
          const proxy = new Proxy(client, {
            get(target, property) {
              if (property === "query")
                return (sql: string, args: unknown[]) => {
                  if (sql.includes("reinlab_machine_key")) {
                    queries.push(args);
                    return Promise.resolve({ rows: [{ value }], rowCount: 1 });
                  }
                  return target.query(sql, args);
                };
              return Reflect.get(target, property);
            },
          });
          return work(proxy);
        });
      return createProductionRuntimeFactory(readonlyDb, {
        driver,
        app,
        controlUrl,
        transport,
      });
    },
    keys,
    driver,
    factory,
    tokens,
    get calls() {
      return calls;
    },
    get mutations() {
      return mutations;
    },
    machines,
    volumes,
    setEndpoint: (value: string) => {
      endpoint = value;
    },
    forgeReceipt: () => {
      receiptAccount = randomUUID();
    },
  };
}
it.each(["fly", "docker"] as const)(
  "creates only a validated remote %s RoleRuntime and wipes envelope keys",
  async (kind) => {
    const f = await fixture(kind),
      runtime = await f.factory()(f.account, f.role);
    expect(runtime).toBeInstanceOf(RoleRuntime);
    expect(f.calls).toBe(1);
    expect(f.mutations).toBe(0);
    expect(f.keys).toHaveLength(1);
    expect(f.keys[0].every((byte) => byte === 0)).toBe(true);
  },
);
it("requires ready pinned-version database state before resolving an endpoint", async () => {
  for (const patch of ["state='failed'", "os_version='2.0.149'"]) {
    const f = await fixture();
    await admin.query(
      "update account_machine set " + patch + " where account_id=$1",
      [f.account],
    );
    await expect(f.factory()(f.account, f.role)).rejects.toMatchObject({
      code: "OS_UNAVAILABLE",
    });
    expect(f.calls).toBe(0);
    expect(f.mutations).toBe(0);
  }
});
it("refuses duplicate or foreign resources and every relevant plan drift before role prepare", async () => {
  const changes = [
    (f: any) => f.machines.push({ ...f.machines[0] }),
    (f: any) => (f.machines[0].name = "foreign"),
    (f: any) =>
      (f.machines[0].config.metadata.reinlab_account_id = randomUUID()),
    (f: any) => (f.machines[0].config.mounts[0].volume = "vol_foreign"),
    (f: any) =>
      f.machines[0].config.mounts.push({ volume: "vol_extra", path: "/extra" }),
    (f: any) => (f.volumes[0].name = "foreign"),
    (f: any) => f.volumes.push({ ...f.volumes[0] }),
    (f: any) => (f.machines[0].config.env.OPENSCIENCE_AUTH_TOKEN = "foreign"),
    (f: any) => (f.machines[0].config.env.NODE_OPTIONS = "--fixture"),
    (f: any) =>
      (f.machines[0].config.image = "registry.fly.io/foreign:fixture"),
    (f: any) => (f.machines[0].state = "stopped"),
  ];
  for (const change of changes) {
    const f = await fixture();
    change(f);
    await expect(f.factory()(f.account, f.role)).rejects.toMatchObject({
      code: "PROVISIONING_CONFLICT",
    });
    expect(f.calls).toBe(0);
    expect(f.mutations).toBe(0);
    expect(f.keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  }
});
it("rejects endpoint escapes independently of the driver metadata", async () => {
  for (const [kind, url] of [
    ["docker", "http://example.test:49123"],
    ["docker", "http://127.0.0.1:49123/path"],
    ["docker", "http://user:fixture@127.0.0.1:49123"],
    ["fly", "http://foreign.vm.reinlab-accounts.internal:4096"],
    ["fly", "https://1234567890abcd.vm.reinlab-accounts.internal:4096"],
    ["fly", "http://1234567890abcd.vm.reinlab-accounts.internal:4096/?x=1"],
  ] as const) {
    const f = await fixture(kind);
    f.setEndpoint(url);
    await expect(f.factory()(f.account, f.role)).rejects.toMatchObject({
      code: "PROVISIONING_CONFLICT",
    });
    expect(f.calls).toBe(0);
    expect(f.mutations).toBe(0);
  }
});
it("fails closed on tampered envelopes, foreign receipts and raw provider errors without leaking fixture tokens", async () => {
  const f = await fixture();
  await admin.query(
    "update account_machine_secret set envelope=jsonb_set(envelope,'{tag}',to_jsonb($2::text)) where account_id=$1",
    [f.account, "AAAAAAAAAAAAAAAAAAAAAA=="],
  );
  await expect(f.factory()(f.account, f.role)).rejects.toMatchObject({
    code: "OS_UNAVAILABLE",
  });
  expect(f.keys[0].every((byte) => byte === 0)).toBe(true);
  expect(f.calls).toBe(0);
  const forged = await fixture();
  forged.forgeReceipt();
  await expect(
    forged.factory()(forged.account, forged.role),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  expect(forged.calls).toBe(1);
  const broken = await fixture();
  broken.driver.listMachines = async () => {
    throw Error("fixture-private-" + broken.tokens.auth);
  };
  const error = await broken
    .factory()(broken.account, broken.role)
    .catch((e) => e);
  expect(error.code).toBe("OS_UNAVAILABLE");
  expect(String(error)).not.toContain("fixture-private");
  expect(JSON.stringify(error)).not.toContain(broken.tokens.auth);
  expect(broken.keys[0].every((byte) => byte === 0)).toBe(true);
});

it("default vault reads only an existing key and fails closed without creating a missing key", async () => {
  for (const value of [
    Buffer.alloc(32, 7).toString("base64"),
    null,
    "invalid",
  ]) {
    const f = await fixture(),
      queries: unknown[][] = [];
    const result = f.defaultFactory(value, queries)(f.account, f.role);
    if (value === Buffer.alloc(32, 7).toString("base64"))
      expect(await result).toBeInstanceOf(RoleRuntime);
    else
      await expect(result).rejects.toMatchObject({
        code: "VAULT_UNAVAILABLE",
        status: 503,
      });
    expect(queries).toEqual([[null]]);
    expect(f.calls).toBe(
      value === Buffer.alloc(32, 7).toString("base64") ? 1 : 0,
    );
    expect(f.mutations).toBe(0);
  }
});
