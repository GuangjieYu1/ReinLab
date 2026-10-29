import pg from "pg";
import { SignJWT } from "jose";
import { resolve } from "node:path";
import { applyMigrations } from "./migrate";
import { reconcileOnStartup } from "../kernel/lifecycle";

/**
 * Local database bootstrap (administrative only; never imported by the HTTP app).
 *
 * Applies migrations with the local Supabase administrator, then sets the two
 * application passwords and returns the scoped URLs the stack runs with.
 */
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
  // connection uses the CLI administrator; the HTTP app never receives it.
  migrationUrl.username = "supabase_admin";
  const pool = new pg.Pool({ connectionString: migrationUrl.href, max: 2 });
  try {
    const applied = await applyMigrations(
      pool,
      resolve("infra/supabase/migrations"),
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

/**
 * 起控制面之前的残留核对。放在这里是因为 `pg` 是控制面的依赖，
 * 启动器（tooling/local）在 pnpm 严格 node_modules 下解析不到它。
 */
export async function reconcileAfterBootstrap(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const reconciled = await reconcileOnStartup(pool);
    // 一次性补名：历史上「新的精读」在能确定论文时补成论文名（第 6 节）。
    await pool.query(
      `update dossier d set title=p.title, name_source='paper', version=d.version+1
         from (select distinct on (r.dossier_id) r.dossier_id,
                      e.payload->'paper'->>'title' title
                 from run r join event e
                   on e.account_id=r.account_id and e.dossier_id=r.dossier_id
                where e.action='paper_asset_opened'
                  and coalesce(e.payload->'paper'->>'title','')<>''
                order by r.dossier_id, r.created_at desc) p
        where d.id=p.dossier_id and d.name_source<>'user'
          and (d.title like '新的精读%' or d.title like '未命名研究%')`,
    );
    return reconciled;
  } finally {
    await pool.end().catch(() => {});
  }
}
