import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db/database';
import { createApp } from '../src/api/app';
import { applyMigrations } from '../src/db/migrate';

const account = '10000000-0000-4000-8000-000000000001';
const disconnected = () => Object.assign(new Error('independent disconnect fixture'), { code: '57P01' });
class BoundaryClient extends EventEmitter {
  queries: Array<{ sql: string; values?: unknown[] }> = [];
  release = vi.fn();
  constructor(private readonly fail?: (sql: string, client: BoundaryClient) => void) { super(); }
  async query(sql: string, values?: unknown[]) {
    this.queries.push({ sql, values });
    this.fail?.(sql, this);
    return { rows: [], rowCount: 0 };
  }
}
function boundaryPool(...clients: BoundaryClient[]) {
  const pool = new EventEmitter() as EventEmitter & { connect: ReturnType<typeof vi.fn> };
  let index = 0;
  pool.connect = vi.fn(async () => {
    if (!clients[index]) throw new Error('UNEXPECTED_EXTRA_BORROW');
    return clients[index++];
  });
  return { pool, db: new Database(pool as unknown as pg.Pool) };
}
const settings = "select set_config('app.account_id',$1,true)";

describe('D-1 独立恢复边界', () => {
  it.each(['begin', settings])('%s 断连后先重新 BEGIN 和账户上下文，再执行一次业务', async phase => {
    const first = new BoundaryClient(sql => { if (sql === phase) throw disconnected(); });
    const second = new BoundaryClient();
    const { pool, db } = boundaryPool(first, second);
    const work = vi.fn(async () => 'done');
    expect(await db.withAccount(account, work)).toBe('done');
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledWith(second);
    expect(second.queries).toEqual([{ sql: 'begin' }, { sql: settings, values: [account] }, { sql: 'commit' }]);
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(second.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(first.listenerCount('error')).toBe(0);
    expect(second.listenerCount('error')).toBe(0);
  });

  it.each(['08006', '57P02', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'])('明确断连代码 %s 可在业务前重借', async code => {
    const first = new BoundaryClient(sql => { if (sql === 'begin') throw Object.assign(new Error('transport failure'), { code }); });
    const { pool, db } = boundaryPool(first, new BoundaryClient());
    const work = vi.fn(async () => 'ok');
    expect(await db.withAccount(account, work)).toBe('ok');
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['Connection terminated unexpectedly', 'Connection terminated', 'Client has encountered a connection error and is not queryable'])('驱动无 SQLSTATE 的断连消息 %s 可恢复', async message => {
    const first = new BoundaryClient(sql => { if (sql === 'begin') throw new Error(message); });
    const { pool, db } = boundaryPool(first, new BoundaryClient());
    const work = vi.fn(async () => 'ok');
    expect(await db.withAccount(account, work)).toBe('ok');
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it.each(['begin', settings])('%s 连续断连最多重借一次，业务从未开始', async phase => {
    const failures = [disconnected(), disconnected()];
    const clients = failures.map(failure => new BoundaryClient(sql => { if (sql === phase) throw failure; }));
    const { pool, db } = boundaryPool(...clients, new BoundaryClient());
    const work = vi.fn(async () => 'must not run');
    await expect(db.withAccount(account, work)).rejects.toBe(failures[1]);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(work).not.toHaveBeenCalled();
    for (const client of clients) expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['work', 'commit'])('%s 断连后不自动重放已开始的业务', async phase => {
    const failure = disconnected();
    const first = new BoundaryClient(sql => { if (phase === 'commit' && sql === 'commit') throw failure; });
    const { pool, db } = boundaryPool(first, new BoundaryClient());
    let externalEffects = 0;
    await expect(db.withAccount(account, async () => {
      externalEffects++;
      if (phase === 'work') throw failure;
      return 'effect completed';
    })).rejects.toBe(failure);
    expect(externalEffects).toBe(1);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(first.queries.at(-1)?.sql).toBe('rollback');
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['42501', '40001', '40P01', '53300'])('非断连 SQLSTATE %s 不重借也不执行业务', async code => {
    const failure = Object.assign(new Error('non-disconnect failure'), { code });
    const first = new BoundaryClient(sql => { if (sql === settings) throw failure; });
    const { pool, db } = boundaryPool(first, new BoundaryClient());
    const work = vi.fn(async () => undefined);
    await expect(db.withAccount(account, work)).rejects.toBe(failure);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    expect(first.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('普通 Error 即使包含 connection 字样，也不猜测为可重试断连', async () => {
    const failure = new Error('connection authorization failed');
    const { pool, db } = boundaryPool(new BoundaryClient(() => { throw failure; }), new BoundaryClient());
    await expect(db.withAccount(account, async () => undefined)).rejects.toBe(failure);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it('非法账户在借连接前被拒绝', async () => {
    const { pool, db } = boundaryPool(new BoundaryClient());
    const work = vi.fn(async () => undefined);
    await expect(db.withAccount('not-a-uuid', work)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('已借出连接 error 事件后重借，移除监听器且不重复业务', async () => {
    const first = new BoundaryClient((sql, client) => {
      if (sql === 'begin') { client.emit('error', disconnected()); throw new Error('transport stopped'); }
    });
    const second = new BoundaryClient();
    const { pool, db } = boundaryPool(first, second);
    const work = vi.fn(async () => 42);
    expect(await db.withAccount(account, work)).toBe(42);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
    expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(first.listenerCount('error')).toBe(0);
  });

  it('真实 PostgreSQL：恢复后重建验签主体的 RLS 上下文，跨账户与空上下文均隔离', async () => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/reinlab_test' });
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_APP ?? 'postgres://reinlab_app@127.0.0.1:55432/reinlab_test', max: 1 });
    const a = randomUUID(), b = randomUUID(), secret = randomBytes(48), issuer = 'http://independent-d1/auth/v1';
    let inject = true, connectCount = 0;
    const pids: number[] = [];
    // 故障分类为边界注入；JWT 验签、重新借出的连接、事务和 RLS 查询均是真实实现。
    const wrappedPool = new Proxy(appPool, {
      get(target, property) {
        if (property === 'connect') return async () => {
          connectCount++;
          const client = await target.connect();
          pids.push((await client.query('select pg_backend_pid() pid')).rows[0].pid);
          const failThisClient = inject;
          inject = false;
          return new Proxy(client, {
            get(connection, key) {
              if (key === 'query') return async (sql: string, values?: unknown[]) => {
                if (failThisClient && sql === settings) throw disconnected();
                return connection.query(sql, values);
              };
              const value = Reflect.get(connection, key);
              return typeof value === 'function' ? value.bind(connection) : value;
            }
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    try {
      await applyMigrations(admin, path.resolve('infra/supabase/migrations'));
      await admin.query('insert into account(id,display_name) values($1,$2),($3,$4)', [a, 'independent A', b, 'independent B']);
      const app = await createApp({ pool: wrappedPool, auth: { issuer, secret } });
      // 浏览器会话（第 5 项）：用真实会话行换 Cookie，不再有可伪造的 Bearer 主体。
      async function sessionCookie(sub: string) {
        const token = randomBytes(32).toString('base64url');
        await admin.query('select reinlab_session_open($1,$2)', [sub, createHash('sha256').update(token).digest('hex')]);
        return 'rl_session=' + token;
      }
      const cookieA = await sessionCookie(a), cookieB = await sessionCookie(b);
      const request = (cookie: string) => app.request('/v1/me', { headers: { Cookie: cookie } });
      const recovered = await request(cookieA);
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).id).toBe(a);
      // 账户存在性中间件借用两次（含恢复），/me 路由再借用一次。
      expect(connectCount).toBe(3);
      expect(pids[1]).not.toBe(pids[0]);
      const db = new Database(appPool);
      await db.withAccount(a, async client => {
        const rows = (await client.query('select id from account')).rows;
        expect(rows).toEqual([{ id: a }]);
        expect((await client.query('select id from account where id=$1', [b])).rowCount).toBe(0);
      });
      const other = await request(cookieB);
      expect(other.status).toBe(200);
      expect((await other.json()).id).toBe(b);
      expect((await appPool.query('select id from account')).rowCount).toBe(0);
    } finally {
      await appPool.end();
      await admin.query('delete from browser_session where account_id=any($1::uuid[])', [[a, b]]);
      await admin.query('delete from account where id=any($1::uuid[])', [[a, b]]);
      await admin.end();
    }
  }, 15000);
});
