/** Administrative local startup only. Never imported by API or worker. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { readRuntimeConfiguration } from "../src/configuration";
import { Database } from "../src/db/database";
import { lifecycleFromEnvironment } from "../src/provisioner/lifecycle";
import { provisionerFromEnvironment } from "../src/provisioner";
import { readPrivateEnv, writePrivateEnv } from "../../../tooling/local/config";
export async function upgradeLocalRealAccounts(
  runtimeFile: string,
  setupFile: string,
) {
  const config = readRuntimeConfiguration(runtimeFile),
    setup = readRuntimeConfiguration(setupFile),
    url = new URL(setup.DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/postgres" ||
    url.search ||
    url.hash ||
    !url.password ||
    config.PROVISIONER_DRIVER !== "docker"
  )
    throw Error("LOCAL_MODEL_UPGRADE_SCOPE_INVALID");
  url.username = "supabase_admin";
  const admin = new pg.Pool({ connectionString: url.href, max: 1 }),
    pool = new pg.Pool({ connectionString: config.DATABASE_URL_APP, max: 2 }),
    db = new Database(pool);
  const previous = process.env.REINLAB_RUNTIME_CONFIG_FILE;
  process.env.REINLAB_RUNTIME_CONFIG_FILE = runtimeFile;
  const directory = join(dirname(runtimeFile), "real-model-upgrades");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let upgraded = 0,
    deferred = 0;
  try {
    await db.assertSafeRole();
    const accounts = (
      await admin.query(
        "select account_id from account_machine where image is distinct from $1 order by account_id",
        [config.ACCOUNT_IMAGE],
      )
    ).rows;
    const lifecycle = lifecycleFromEnvironment(db),
      provisioner = provisionerFromEnvironment(db);
    for (const row of accounts) {
      const id = row.account_id;
      const active = await db.withAccount(
        id,
        async (c) =>
          (
            await c.query(
              "select 1 from run where account_id=$1 and ended_at is null and state in ('queued','running','waiting','paused_budget') limit 1",
              [id],
            )
          ).rowCount,
      );
      if (active) {
        deferred++;
        continue;
      }
      const file = join(directory, id + ".env");
      let saved: Record<string, string> = {};
      try {
        saved = await readPrivateEnv(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (
        saved.OPERATION_ID &&
        saved.STATE !== "applied" &&
        saved.IMAGE !== config.ACCOUNT_IMAGE
      )
        throw Error("LOCAL_MODEL_UPGRADE_INDETERMINATE");
      if (saved.IMAGE !== config.ACCOUNT_IMAGE) {
        saved = { IMAGE: config.ACCOUNT_IMAGE, OPERATION_ID: randomUUID() };
        await writePrivateEnv(file, saved);
      }
      await lifecycle.upgrade(
        id,
        config.ACCOUNT_IMAGE!,
        "wait",
        saved.OPERATION_ID,
      );
      if ((await provisioner.ensure(id)).state !== "ready")
        throw Error("LOCAL_MODEL_UPGRADE_INDETERMINATE");
      saved.STATE = "applied";
      await writePrivateEnv(file, saved);
      upgraded++;
    }
    return { upgraded, deferred };
  } finally {
    if (previous === undefined) delete process.env.REINLAB_RUNTIME_CONFIG_FILE;
    else process.env.REINLAB_RUNTIME_CONFIG_FILE = previous;
    await pool.end();
    await admin.end();
  }
}
