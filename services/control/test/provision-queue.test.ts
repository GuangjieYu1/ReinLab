import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { applyMigrations } from '../src/db/migrate';

const admin = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:55432/reinlab_test' });
const ids = [randomUUID(), randomUUID(), randomUUID()];
async function asWorker(worker: string) {
  const c = await admin.connect();
  try { await c.query('begin'); await c.query('set local role reinlab_provisioner'); const result = await c.query('select * from public.reinlab_provision_next($1)', [worker]); await c.query('commit'); return result.rows[0]; }
  catch (e) { await c.query('rollback'); throw e; }
  finally { c.release(); }
}

describe.sequential('durable Auth provisioning queue privileges', () => {
  beforeAll(async () => { await applyMigrations(admin, resolve('infra/supabase/migrations')); });
  afterAll(async () => {
    await admin.query('delete from reinlab_meta.provision_job where account_id=any($1::uuid[])', [ids]).catch(() => undefined);
    await admin.query('delete from account where id=any($1::uuid[])', [ids]);
    await admin.end();
  });
  it('installs narrow queue functions even on plain PG without emulating Auth', async () => {
    const r = await admin.query("select to_regprocedure('public.reinlab_provision_next(uuid)')::text name");
    expect(r.rows[0].name).toBe('reinlab_provision_next(uuid)');
  });
  it('does not let the business role read the private queue or claim other accounts', async () => {
    const c = await admin.connect();
    try {
      for (const sql of ['select * from reinlab_meta.provision_job', `select * from public.reinlab_provision_next('${randomUUID()}')`]) {
        await c.query('begin'); await c.query('set local role reinlab_app');
        await expect(c.query(sql)).rejects.toMatchObject({ code: '42501' });
        await c.query('rollback');
      }
    } finally { c.release(); }
  });
  it('claims distinct jobs atomically and rejects finishing under a different lease owner', async () => {
    for (const id of ids.slice(0, 2)) { await admin.query('insert into account(id) values($1)', [id]); await admin.query('insert into reinlab_meta.provision_job(account_id) values($1)', [id]); }
    const workers = [randomUUID(), randomUUID()];
    const claimed = await Promise.all(workers.map(asWorker));
    expect(new Set(claimed.map(x => x.job_account_id))).toEqual(new Set(ids.slice(0, 2)));
    const c = await admin.connect();
    try {
      await c.query('begin'); await c.query('set local role reinlab_provisioner');
      await expect(c.query('select public.reinlab_provision_finish($1,$2,$3)', [claimed[0].job_account_id, randomUUID(), null])).rejects.toMatchObject({ code: '42501' });
      await c.query('rollback');
      for (const [i, job] of claimed.entries()) {
        await c.query('begin'); await c.query('set local role reinlab_provisioner'); await c.query('select public.reinlab_provision_finish($1,$2,$3)', [job.job_account_id, workers[i], null]); await c.query('commit');
      }
    } finally { c.release(); }
    expect((await admin.query('select state from reinlab_meta.provision_job where account_id=any($1::uuid[])', [ids])).rows.map(x => x.state)).toEqual(['done', 'done']);
  });
  it('terminates an exhausted lease after a crashed worker instead of leaving it stuck forever', async () => {
    await admin.query('insert into account(id) values($1)', [ids[2]]);
    await admin.query("insert into reinlab_meta.provision_job(account_id,state,attempts,worker_id,lease_until) values($1,'leased',8,$2,now()-interval '1 second')", [ids[2], randomUUID()]);
    await asWorker(randomUUID());
    const row = (await admin.query('select state,worker_id,lease_until,last_error_code from reinlab_meta.provision_job where account_id=$1', [ids[2]])).rows[0];
    expect(row).toEqual({ state: 'failed', worker_id: null, lease_until: null, last_error_code: 'PROVISION_ATTEMPTS_EXHAUSTED' });
  });
});
