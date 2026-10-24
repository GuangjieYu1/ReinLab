import pg from "pg";
import { resolve } from "node:path";
import { applyMigrations } from "../../control/src/db/migrate";

/** Administrative local tooling only. This file is never imported by the worker. */
export async function bootstrapRecoveryDatabases(
  adminUrl: string,
  password: string,
  discoveryPassword: string
) {
  if (
    ![password, discoveryPassword].every((v) => /^[a-zA-Z0-9_-]{43}$/.test(v))
  )
    throw Error("HATCHET_SETUP_INVALID");
  const migrationUrl = new URL(adminUrl);
  if (
    !["postgres:", "postgresql:"].includes(migrationUrl.protocol) ||
    migrationUrl.hostname !== "127.0.0.1" ||
    !migrationUrl.port ||
    migrationUrl.pathname !== "/postgres" ||
    !migrationUrl.password ||
    migrationUrl.search ||
    migrationUrl.hash
  )
    throw Error("LOCAL_DATABASE_REQUIRED");
  // Same local-only administrator as existing bootstrap; never copied into worker configuration.
  migrationUrl.username = "supabase_admin";
  const pool = new pg.Pool({ connectionString: migrationUrl.href, max: 1 });
  let phase = "migrations";
  try {
    await applyMigrations(pool, resolve("infra/supabase/migrations"));
    phase = "roles";
    const client = await pool.connect();
    try {
      await client.query(
        "select pg_advisory_lock(hashtext('reinlab.hatchet-setup'))"
      );
      const role = (
        await client.query(
          "select * from pg_roles where rolname='reinlab_hatchet'"
        )
      ).rows[0];
      if (!role)
        await client.query(
          "create role reinlab_hatchet login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls"
        );
      else if (
        !role.rolcanlogin ||
        role.rolinherit ||
        role.rolsuper ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls
      )
        throw Error();
      if (
        (
          await client.query(
            "select 1 from pg_auth_members m join pg_roles r on r.oid in (m.member,m.roleid) where r.rolname='reinlab_hatchet'"
          )
        ).rowCount
      )
        throw Error();
      // Passwords are random validated base64url, used only by the privileged setup process.
      await client.query(
        "alter role reinlab_hatchet password '" + password + "'"
      );
      await client.query(
        "alter role reinlab_reconcile_discovery password '" +
          discoveryPassword +
          "'"
      );
      phase = "database";
      const database = (
        await client.query(
          "select pg_get_userbyid(datdba) owner from pg_database where datname='reinlab_hatchet'"
        )
      ).rows[0];
      if (!database)
        await client.query(
          "create database reinlab_hatchet owner reinlab_hatchet"
        );
      else if (database.owner !== "reinlab_hatchet") throw Error();
      await client.query("revoke all on database reinlab_hatchet from public");
      const discovery = new URL(adminUrl);
      discovery.username = "reinlab_reconcile_discovery";
      discovery.password = discoveryPassword;
      return { discoveryUrl: discovery.href };
    } finally {
      await client
        .query("select pg_advisory_unlock(hashtext('reinlab.hatchet-setup'))")
        .catch(() => {});
      client.release();
    }
  } catch (error) {
    const state = (error as { code?: string }).code;
    console.error(
      JSON.stringify({
        code: "RECOVERY_DATABASE_SETUP_FAILED",
        phase,
        sqlState: state && /^[0-9A-Z]{5}$/.test(state) ? state : undefined,
      })
    );
    throw Error("RECOVERY_DATABASE_SETUP_FAILED");
  } finally {
    await pool.end();
  }
}
