import { it, expect } from "vitest";
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { Database } from "../src/db/database";
import { AccountLifecycle } from "../src/provisioner/lifecycle";
import { encryptBundle, machinePlan } from "../src/provisioner/runtime";
import type { Machines, AccountMachine } from "../src/provisioner/driver";

it("credential migration same-image retries remain indeterminate until file delivery is observed", async () => {
  const admin = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      "postgres://postgres@127.0.0.1:55432/reinlab_test",
  });
  const pool = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL_APP ??
      "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  });
  const accountId = randomUUID(),
    operation = randomUUID(),
    key = randomBytes(32);
  const tokens = {
    auth: randomBytes(32).toString("base64url"),
    container: randomBytes(32).toString("base64url"),
  };
  const image = "registry.fly.io/reinlab-accounts:same",
    machineId = "1234567890abcd",
    volumeId = "vol_fixture";
  const config = {
    app: "reinlab-accounts",
    storageUrl: "https://project.supabase.co",
    controlUrl: "http://reinlab-control.internal:3001",
    storageToken:
      "e30." +
      Buffer.from(JSON.stringify({ role: "reinlab_snapshot_writer" })).toString(
        "base64url",
      ) +
      ".fixture",
  };
  const desired = machinePlan({
    accountId,
    volumeId,
    image,
    controlUrl: config.controlUrl,
    tokens,
  }).config;
  const legacy = structuredClone(desired) as Record<string, any>;
  delete legacy.files;
  delete legacy.env.REINLAB_ACCOUNT_CREDENTIAL_FILE;
  Object.assign(legacy.env, {
    OPENSCIENCE_AUTH_TOKEN: tokens.auth,
    REINLAB_CONTAINER_SECRET: tokens.container,
  });
  const machine: AccountMachine = {
    id: machineId,
    name: "fixture",
    state: "started",
    region: "nrt",
    config: legacy,
  };
  let updates = 0;
  const machines: Machines = {
    async listMachines() {
      return [machine];
    },
    async listVolumes() {
      return [
        {
          id: volumeId,
          name: "rl_" + accountId.replaceAll("-", ""),
          region: "nrt",
          attached_machine_id: machineId,
        },
      ];
    },
    async createMachine() {
      throw Error("UNEXPECTED_CREATE");
    },
    async createVolume() {
      throw Error("UNEXPECTED_CREATE");
    },
    async start() {},
    async update() {
      updates++;
      throw Error("SYNTHETIC_PRE_MUTATION_FAILURE");
    },
  };
  try {
    await admin.query("insert into account(id) values($1)", [accountId]);
    await admin.query(
      "insert into account_machine(account_id,fly_machine_id,fly_volume_id,state,phase,image) values($1,$2,$3,'ready','ready',$4)",
      [accountId, machineId, volumeId, image],
    );
    await admin.query("insert into account_machine_secret values($1,$2)", [
      accountId,
      encryptBundle(accountId, key, tokens),
    ]);
    const service = new AccountLifecycle(
      new Database(pool),
      machines,
      {
        async key() {
          return Buffer.from(key);
        },
      },
      config,
    );
    await expect(
      service.migrateCredentials(accountId, image, "interrupt", operation),
    ).rejects.toMatchObject({ code: "PROVISIONING_INDETERMINATE" });
    await expect(
      service.migrateCredentials(accountId, image, "interrupt", operation),
    ).rejects.toMatchObject({ code: "PROVISIONING_INDETERMINATE" });
    expect(updates).toBe(1);
    expect(
      (
        await admin.query(
          "select state from account_machine_operation where account_id=$1 and operation_id=$2",
          [accountId, operation],
        )
      ).rows[0].state === "indeterminate",
    ).toBe(true);
    machine.config = structuredClone(desired);
    expect(
      (
        await service.migrateCredentials(
          accountId,
          image,
          "interrupt",
          operation,
        )
      ).code,
    ).toBe("UPDATE_REQUESTED");
    expect(updates).toBe(1);
  } finally {
    key.fill(0);
    try {
      await admin.query(
        "delete from account_machine_operation where account_id=$1",
        [accountId],
      );
      await admin.query(
        "delete from account_machine_secret where account_id=$1",
        [accountId],
      );
      await admin.query("delete from account_machine where account_id=$1", [
        accountId,
      ]);
      await admin.query("delete from account where id=$1", [accountId]);
    } finally {
      await pool.end();
      await admin.end();
    }
  }
});
