import type pg from "pg";
import { ApiFailure } from "../api/errors";

const observedPools = new WeakSet<pg.Pool>();
function observePool(pool: pg.Pool) {
  if (observedPools.has(pool)) return;
  observedPools.add(pool);
  pool.on("error", () =>
    console.error(JSON.stringify({ code: "DATABASE_POOL_ERROR" })),
  );
}

export async function assertApplicationRole(
  connection: pg.Pool | pg.PoolClient,
): Promise<void> {
  const result =
    await connection.query(`select r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
      exists(select 1 from pg_auth_members m where m.member=r.oid) member_of_roles,
      exists(select 1 from pg_tables where schemaname='public' and tableowner=current_user) owns_tables,
      has_schema_privilege(current_user,'public','CREATE') can_create
      from pg_roles r where r.rolname=current_user`);
  const role = result.rows[0];
  if (!role || Object.values(role).some((value) => value !== false))
    throw new Error(
      "UNSAFE_DATABASE_ROLE: 应用连接必须使用受RLS约束的非特权、非表所有者角色",
    );
}
export class Database {
  constructor(private readonly pool: pg.Pool) {
    observePool(pool);
  }
  async assertSafeRole(): Promise<void> {
    await assertApplicationRole(this.pool);
  }
  withAccount<T>(
    accountId: string,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(accountId, work, false);
  }
  /**
   * 不带账户上下文的系统事务：只给调度这类跨账户枚举用。
   * RLS 下普通表一律看不到行（app.account_id 未设置），只有 definer 函数可用。
   */
  withSystem<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(null, work, false);
  }
  withAccountSnapshot<T>(
    accountId: string,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(accountId, work, true);
  }
  private async transaction<T>(
    accountId: string | null,
    work: (client: pg.PoolClient) => Promise<T>,
    snapshot: boolean,
  ): Promise<T> {
    if (
      accountId !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        accountId,
      )
    )
      throw new ApiFailure("AUTH_INVALID", 401, "账户身份无效。");
    // 仅在业务回调开始之前重借一次；work/COMMIT失败绝不自动重放。
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await this.pool.connect();
      let broken = false,
        disconnected = false,
        workStarted = false;
      const onDisconnect = () => {
        broken = true;
        disconnected = true;
        console.error(JSON.stringify({ code: "DATABASE_CONNECTION_ERROR" }));
      };
      client.on("error", onDisconnect);
      try {
        await client.query(
          snapshot
            ? "begin isolation level repeatable read read only"
            : "begin",
        );
        if (accountId !== null)
          await client.query("select set_config('app.account_id',$1,true)", [
            accountId,
          ]);
        workStarted = true;
        const value = await work(client);
        await client.query("commit");
        return value;
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          broken = true;
        }
        const failure = error as { code?: string; message?: string } | null;
        const lost =
          disconnected ||
          Boolean(
            failure &&
              ((typeof failure.code === "string" &&
                (/^(08[A-Z0-9]{3}|57P0[12])$/.test(failure.code) ||
                  ["ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(
                    failure.code,
                  ))) ||
                [
                  "Connection terminated unexpectedly",
                  "Connection terminated",
                  "Client has encountered a connection error and is not queryable",
                ].includes(failure.message ?? "")),
          );
        if (lost) broken = true;
        if (!workStarted && attempt === 0 && lost) {
          broken = true;
          console.error(
            JSON.stringify({ code: "DATABASE_CONNECTION_REPLACED" }),
          );
          continue;
        }
        throw error;
      } finally {
        client.release(broken);
        client.removeListener("error", onDisconnect);
      }
    }
    throw new Error("DATABASE_PREFLIGHT_FAILED");
  }
}
