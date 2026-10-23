import { it, expect } from "vitest";
import pg from "pg";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { DockerMachines, dockerPlan } from "../src/provisioner/docker";
import { AccountLifecycle } from "../src/provisioner/lifecycle";
import { encryptBundle } from "../src/provisioner/runtime";
import { reconcileKnownCredentialPreflight } from "../src/provisioner/credential-recovery";

it("recovery failure after audit preserves both terminal old intent and indeterminate new intent", async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test" });
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test" });
  const db = new Database(pool), accountId = randomUUID(), operationId = randomUUID(), recoveryOperationId = randomUUID(), key = randomBytes(32);
  const tokens = { auth: randomBytes(32).toString("base64url"), container: randomBytes(32).toString("base64url") };
  const target = "reinlab-account:security-review-file", machineId = "rl-" + accountId.replaceAll("-", ""), volumeId = "rl_" + accountId.replaceAll("-", "");
  const expectedImmutableId = "c".repeat(64), targetImageDigest = "sha256:" + "d".repeat(64);
  let mutations = 0;
  const legacy = dockerPlan({ accountId, volumeId, image: "reinlab-account:security-review-old", controlUrl: "http://host.docker.internal:3001/", tokens }).config as Record<string, any>;
  delete legacy.files; delete legacy.env.REINLAB_ACCOUNT_CREDENTIAL_FILE; delete legacy.env.REINLAB_CREDENTIAL_SOURCE_UID;
  Object.assign(legacy.env, { HOME: "/data", PATH: "/usr/bin:/bin", OPENSCIENCE_AUTH_TOKEN: tokens.auth, REINLAB_CONTAINER_SECRET: tokens.container });
  // Coordinator fault test only: actual Docker normalization/proof checks are covered separately.
  const driver = { kind: "docker", plan: dockerPlan,
    async inspectCredentialMigration() { return { immutableId: expectedImmutableId, createdAt: "2020-01-01T00:00:00.000Z", targetImageDigest, machine: { id: machineId, config: structuredClone(legacy) } }; },
    async migrateCredentials() { mutations++; throw Error("SYNTHETIC_RESPONSE_LOST"); },
  };
  try {
    await applyMigrations(admin, resolve("infra/supabase/migrations"));
    await admin.query("insert into account(id) values($1)", [accountId]);
    await admin.query("insert into account_machine(account_id,fly_machine_id,fly_volume_id,state,phase,image) values($1,$2,$3,'starting',$4,$5)", [accountId, machineId, volumeId, "upgrade_pending:" + operationId, target]);
    await admin.query("insert into account_machine_secret values($1,$2)", [accountId, encryptBundle(accountId, key, tokens)]);
    await admin.query("insert into account_machine_operation(account_id,operation_id,request_hash,image,mode,state) values($1,$2,$3,$4,'wait','indeterminate')", [accountId, operationId, createHash("sha256").update(JSON.stringify({ image: target, mode: "wait", migrateCredentials: true })).digest("hex"), target]);
    const proof = { db, driver: driver as never, vault: { async key() { return Buffer.from(key); } }, accountId, operationId, recoveryOperationId, expectedImmutableId, targetImageDigest };
    await expect(reconcileKnownCredentialPreflight(proof)).rejects.toMatchObject({ code: "CREDENTIAL_RECONCILIATION_REQUIRED" });
    await expect(reconcileKnownCredentialPreflight(proof)).rejects.toMatchObject({ code: "CREDENTIAL_RECONCILIATION_REQUIRED" });
    expect(mutations).toBe(1);
    const states = (await admin.query("select operation_id,state from account_machine_operation where account_id=$1", [accountId])).rows;
    expect(states.some(r => r.operation_id === operationId && r.state === "not_applied")).toBe(true);
    expect(states.some(r => r.operation_id === recoveryOperationId && r.state === "indeterminate")).toBe(true);
    const row = (await admin.query("select state,phase,lease_id from account_machine where account_id=$1", [accountId])).rows[0];
    expect(row.state === "starting" && row.phase === "upgrade_pending:" + recoveryOperationId && row.lease_id === null).toBe(true);
    const audit = (await admin.query("select * from credential_preflight_reconciliation where account_id=$1", [accountId])).rows;
    expect(audit.length === 1 && !JSON.stringify(audit).includes(tokens.auth) && !JSON.stringify(audit).includes(tokens.container)).toBe(true);
    expect((await db.withAccount(randomUUID(), c => c.query("select 1 from credential_preflight_reconciliation where account_id=$1", [accountId]))).rowCount).toBe(0);
    await expect(db.withAccount(accountId, c => c.query("update credential_preflight_reconciliation set reason=reason where account_id=$1", [accountId]))).rejects.toMatchObject({ code: "42501" });
    const desired = dockerPlan({ accountId, volumeId, image: target, controlUrl: "http://host.docker.internal:3001/", tokens }).config;
    const observedMachine = { id: machineId, name: machineId, region: "local", state: "started", config: desired };
    const replayDriver = new DockerMachines("unix:///tmp/review-no-engine.sock", async () => { throw Error("UNEXPECTED_ENGINE_CALL"); });
    Object.assign(replayDriver, {
      async listLegacyMachines() { return [observedMachine]; },
      async listVolumes() { return [{ id: volumeId, name: volumeId, region: "local" }]; },
      async inspectCredentialMigration() {
        await admin.query("update account_machine set lease_until=now()-interval '1 second' where account_id=$1", [accountId]);
        return { immutableId: expectedImmutableId, targetImageDigest, runtimeImageDigest: targetImageDigest, createdAt: "2020-01-01T00:00:00.000Z", machine: observedMachine };
      },
    });
    const lifecycle = new AccountLifecycle(db, replayDriver, proof.vault, { app: "reinlab-local", storageUrl: "http://127.0.0.1:54321/", controlUrl: "http://host.docker.internal:3001/", storageToken: "e30." + Buffer.from(JSON.stringify({ role: "reinlab_snapshot_writer" })).toString("base64url") + ".fixture" });
    await expect(lifecycle.migrateCredentials(accountId, target, "wait", recoveryOperationId)).rejects.toMatchObject({ code: "PROVISIONING_INDETERMINATE" });
    expect((await admin.query("select state from account_machine_operation where account_id=$1 and operation_id=$2", [accountId, recoveryOperationId])).rows[0].state === "indeterminate").toBe(true);
  } finally { key.fill(0); await pool.end(); await admin.end(); }
});
