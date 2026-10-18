import type pg from 'pg';
import { ApiFailure } from '../api/errors';

const observedPools=new WeakSet<pg.Pool>();
function observePool(pool:pg.Pool) {
  if(observedPools.has(pool))return;
  observedPools.add(pool);
  pool.on('error',()=>console.error(JSON.stringify({code:'DATABASE_POOL_ERROR'})));
}

export async function assertApplicationRole(connection: pg.Pool | pg.PoolClient): Promise<void> {
    const result = await connection.query(`select r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
      exists(select 1 from pg_auth_members m where m.member=r.oid) member_of_roles,
      exists(select 1 from pg_tables where schemaname='public' and tableowner=current_user) owns_tables,
      has_schema_privilege(current_user,'public','CREATE') can_create
      from pg_roles r where r.rolname=current_user`);
    const role = result.rows[0];
    if (!role || Object.values(role).some(value=>value!==false)) throw new Error('UNSAFE_DATABASE_ROLE: 应用连接必须使用受RLS约束的非特权、非表所有者角色');
}
export class Database {
  constructor(private readonly pool: pg.Pool) { observePool(pool); }
  async assertSafeRole(): Promise<void> { await assertApplicationRole(this.pool); }
  async withAccount<T>(accountId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) throw new ApiFailure('AUTH_INVALID',401,'账户身份无效。');
    const client=await this.pool.connect();
    let broken=false;
    const disconnected=()=>{broken=true;console.error(JSON.stringify({code:'DATABASE_CONNECTION_ERROR'}));};
    client.on('error',disconnected);
    try {
      await client.query('begin');
      await client.query("select set_config('app.account_id',$1,true)",[accountId]);
      const value=await work(client);
      await client.query('commit');
      return value;
    } catch (error) {
      try { await client.query('rollback'); } catch { broken=true; }
      throw error;
    } finally { client.release(broken);client.removeListener('error',disconnected); }
  }
}
