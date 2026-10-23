/** Explicit trusted maintenance; only the configured local driver, never a public API. */
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { readRuntimeConfiguration } from "../src/configuration";
import { Database } from "../src/db/database";
import {
  environmentDriver,
  provisionerFromEnvironment,
  SupabaseKeyVault,
} from "../src/provisioner";
import { DockerMachines } from "../src/provisioner/docker";
import { reconcileKnownCredentialPreflight } from "../src/provisioner/credential-recovery";
import { lifecycleFromEnvironment } from "../src/provisioner/lifecycle";
import { localPaths } from "../../../tooling/local/paths";
import { readPrivateEnv, writePrivateEnv } from "../../../tooling/local/config";
const paths = localPaths(),
  results: Array<{ account: string; state: string }> = [];
let pool: pg.Pool | undefined;
let phase = "configuration";
try {
  const config = readRuntimeConfiguration(paths.runtime);
  if (config.PROVISIONER_DRIVER !== "docker" || !config.ACCOUNT_IMAGE)
    throw Error("LOCAL_DRIVER_REQUIRED");
  process.env.REINLAB_RUNTIME_CONFIG_FILE = paths.runtime;
  const driver = environmentDriver();
  if (!(driver instanceof DockerMachines)) throw Error("LOCAL_DRIVER_REQUIRED");
  phase = "list";
  const machines = await driver.listLegacyMachines();
  pool = new pg.Pool({ connectionString: config.DATABASE_URL_APP, max: 3 });
  const db = new Database(pool);
  await db.assertSafeRole();
  const service = lifecycleFromEnvironment(db),
    provisioner = provisionerFromEnvironment(db);
  const file = join(paths.state, "file-credential-migrations.env");
  let operations: Record<string, string> = {};
  try {
    operations = await readPrivateEnv(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ids = new Set(
    machines.map((m) => m.config.metadata!.reinlab_account_id),
  );
  for (const key of Object.keys(operations).filter((k) =>
    /^ACCOUNT_[A-F0-9]{32}$/.test(k),
  )) {
    const h = key.slice(8).toLowerCase();
    ids.add(
      [
        h.slice(0, 8),
        h.slice(8, 12),
        h.slice(12, 16),
        h.slice(16, 20),
        h.slice(20),
      ].join("-"),
    );
  }
  for (const id of ids) {
    const machine = machines.find(
        (m) => m.config.metadata!.reinlab_account_id === id,
      ),
      key = "ACCOUNT_" + id.replaceAll("-", "").toUpperCase();
    if (machine?.config.files === undefined || operations[key]) {
      if (!operations[key]) {
        operations[key] = randomUUID();
        operations[key + "_IMAGE"] = config.ACCOUNT_IMAGE;
        await writePrivateEnv(file, operations);
      }
      if (operations[key + "_IMAGE"] !== config.ACCOUNT_IMAGE)
        throw Error("LOCAL_MIGRATION_TARGET_CHANGED");
      const op = await db.withAccount(
        id,
        async (c) =>
          (
            await c.query(
              "select state from account_machine_operation where account_id=$1 and operation_id=$2",
              [id, operations[key]],
            )
          ).rows[0],
      );
      if (op?.state === "not_applied" && operations[key + "_RECOVERY"]) {
        const recovery = operations[key + "_RECOVERY"];
        const audit = await db.withAccount(
          id,
          async (c) =>
            (
              await c.query(
                "select r.recovery_operation_id,r.target_image_digest,o.state,o.request_hash,o.image,o.mode from credential_preflight_reconciliation r join account_machine_operation o on o.account_id=r.account_id and o.operation_id=r.recovery_operation_id where r.account_id=$1 and r.operation_id=$2",
                [id, operations[key]],
              )
            ).rows[0],
        );
        if (
          !audit ||
          audit.recovery_operation_id !== recovery ||
          !machine ||
          !["indeterminate", "applied"].includes(audit.state) ||
          audit.image !== config.ACCOUNT_IMAGE ||
          audit.mode !== "wait" ||
          audit.request_hash !==
            createHash("sha256")
              .update(
                JSON.stringify({
                  image: config.ACCOUNT_IMAGE,
                  mode: "wait",
                  migrateCredentials: true,
                }),
              )
              .digest("hex")
        )
          throw Error("LOCAL_RECOVERY_AUDIT_MISMATCH");
        const pin = await readPrivateEnv(
          join(
            paths.state,
            "account-image-" + config.ACCOUNT_IMAGE.split(":")[1] + ".env",
          ),
        );
        const observed = await driver.inspectCredentialMigration(
          machine.id,
          config.ACCOUNT_IMAGE,
          false,
        );
        if (
          pin.IMAGE_REFERENCE !== config.ACCOUNT_IMAGE ||
          observed.targetImageDigest !== pin.IMAGE_ID ||
          observed.runtimeImageDigest !== pin.IMAGE_ID ||
          audit.target_image_digest !== pin.IMAGE_ID
        )
          throw Error("LOCAL_IMAGE_PIN_CHANGED");
        // Existing lifecycle replay only reconciles the complete desired deployment; never retries mutation.
        await service.migrateCredentials(
          id,
          config.ACCOUNT_IMAGE,
          "wait",
          recovery,
        );
        const after = await driver.inspectCredentialMigration(
          machine.id,
          config.ACCOUNT_IMAGE,
          false,
        );
        if (
          after.immutableId !== observed.immutableId ||
          after.runtimeImageDigest !== pin.IMAGE_ID ||
          after.targetImageDigest !== pin.IMAGE_ID
        )
          throw Error("LOCAL_RECOVERY_RESOURCE_CHANGED");
        operations[key + "_PRIOR_OPERATION"] = operations[key];
        operations[key] = recovery;
        await writePrivateEnv(file, operations);
      }
      if (
        op?.state === "indeterminate" &&
        process.argv.includes("--confirm-known-preflight-rejection")
      ) {
        phase = "proof";
        const pin = await readPrivateEnv(
          join(
            paths.state,
            "account-image-" + config.ACCOUNT_IMAGE.split(":")[1] + ".env",
          ),
        );
        if (
          pin.IMAGE_REFERENCE !== config.ACCOUNT_IMAGE ||
          !/^sha256:[a-f0-9]{64}$/.test(pin.IMAGE_ID)
        )
          throw Error("LOCAL_IMAGE_PIN_INVALID");
        if (!operations[key + "_RECOVERY"]) {
          if (!machine) throw Error("LOCAL_RECOVERY_RESOURCE_MISSING");
          const inspected = await driver.inspectCredentialMigration(
            machine.id,
            config.ACCOUNT_IMAGE,
          );
          operations[key + "_RECOVERY"] = randomUUID();
          operations[key + "_IMMUTABLE_ID"] = inspected.immutableId;
          await writePrivateEnv(file, operations);
        }
        await reconcileKnownCredentialPreflight({
          db,
          driver,
          vault: new SupabaseKeyVault(),
          accountId: id,
          operationId: operations[key],
          recoveryOperationId: operations[key + "_RECOVERY"],
          expectedImmutableId: operations[key + "_IMMUTABLE_ID"],
          targetImageDigest: pin.IMAGE_ID,
        });
        operations[key + "_PRIOR_OPERATION"] = operations[key];
        operations[key] = operations[key + "_RECOVERY"];
        await writePrivateEnv(file, operations);
      }
      phase = "migration";
      await service.migrateCredentials(
        id,
        config.ACCOUNT_IMAGE,
        "wait",
        operations[key],
      );
      results.push({ account: id, state: "file_credentials_applied" });
    } else results.push({ account: id, state: "already_file_credentials" });
  }
  // All legacy machines must be converted before the ordinary driver accepts the resource set.
  phase = "health";
  for (const result of results) {
    await provisioner.ensure(result.account);
    result.state = "ready";
  }
  const directory = process.env.REINLAB_EVIDENCE_OUT;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "local-credential-migration.json"),
      JSON.stringify(
        {
          realInfrastructure: true,
          modelRequests: 0,
          passed: results.length,
          failed: 0,
          accounts: results,
          image: config.ACCOUNT_IMAGE,
        },
        null,
        2,
      ) + "\n",
    );
  }
  console.log(
    JSON.stringify({
      code: "LOCAL_CREDENTIAL_MIGRATION_READY",
      passed: results.length,
      failed: 0,
      modelRequests: 0,
    }),
  );
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    JSON.stringify({
      code:
        code && /^[A-Z_]+$/.test(code)
          ? code
          : "LOCAL_CREDENTIAL_MIGRATION_FAILED",
      completedAccounts: results.length,
      phase,
    }),
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
