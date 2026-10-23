import pg from "pg";
import { SignJWT } from "jose";
import { resolve } from "node:path";
import { applyMigrations } from "../db/migrate";
import { loadToolRegistry, loadBenchBundle } from "../harness/manifest";
import { publishBench } from "../harness/store";

/** Administrative local setup only; never imported by the HTTP application. */
export async function bootstrapLocalDatabase(
  status: {
    databaseUrl: string;
    apiUrl: string;
    anonKey: string;
    jwtSecret: string;
  },
  passwords: { app: string; provisioner: string },
) {
  if (
    ![passwords.app, passwords.provisioner].every((value) =>
      /^[A-Za-z0-9_-]{32,100}$/.test(value),
    )
  )
    throw new Error("LOCAL_PASSWORD_INVALID");
  const migrationUrl = new URL(status.databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(migrationUrl.protocol) ||
    migrationUrl.hostname !== "127.0.0.1" ||
    !migrationUrl.port ||
    migrationUrl.pathname !== "/postgres" ||
    !migrationUrl.username ||
    !migrationUrl.password ||
    migrationUrl.search ||
    migrationUrl.hash
  )
    throw new Error("LOCAL_DATABASE_REQUIRED");
  // CLI's public postgres role cannot set NOBYPASSRLS. Only the local setup
  // connection uses the CLI administrator; neither HTTP nor workers receive it.
  migrationUrl.username = "supabase_admin";
  const pool = new pg.Pool({ connectionString: migrationUrl.href, max: 2 });
  try {
    const applied = await applyMigrations(
      pool,
      resolve("infra/supabase/migrations"),
    );
    const registry = await loadToolRegistry();
    for (const version of ["1.0.0", undefined])
      await publishBench(
        pool,
        await loadBenchBundle({ benchId: "research", registry, version }),
        registry,
      );
    // Generated base64url values are validated above; DDL has no parameter form.
    await pool.query(`alter role reinlab_app password '${passwords.app}'`);
    await pool.query(
      `alter role reinlab_provisioner password '${passwords.provisioner}'`,
    );
    const app = new URL(status.databaseUrl);
    app.username = "reinlab_app";
    app.password = passwords.app;
    const worker = new URL(status.databaseUrl);
    worker.username = "reinlab_provisioner";
    worker.password = passwords.provisioner;
    const storageToken = await new SignJWT({ role: "reinlab_snapshot_writer" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("supabase")
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode(status.jwtSecret));
    return {
      applied,
      databaseApp: app.href,
      databaseProvisioner: worker.href,
      storageToken,
    };
  } catch {
    throw new Error("LOCAL_BOOTSTRAP_FAILED");
  } finally {
    await pool.end();
  }
}
