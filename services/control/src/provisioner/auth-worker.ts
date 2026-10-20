import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { assertApplicationRole } from '../db/database';
import type { AccountProvisioner } from './index';

/** Auth's database trigger is the only producer. No public webhook accepts an account ID. */
export async function startAuthProvisioner(connectionString: string, provisioner: Pick<AccountProvisioner, 'ensure'>) {
  const pool = new pg.Pool({ connectionString, max: 2 });
  pool.on('error', () => console.error(JSON.stringify({ code: 'AUTH_PROVISION_POOL_ERROR' })));
  try { await assertApplicationRole(pool); }
  catch (error) { await pool.end(); throw error; }
  const controller = new AbortController();
  const worker = randomUUID();
  const running = (async () => {
    while (!controller.signal.aborted) {
      try {
        const claimed = await pool.query<{ job_account_id: string }>('select * from public.reinlab_provision_next($1)', [worker]);
        const job = claimed.rows[0];
        if (job) {
          let code: string | null = null;
          try { await provisioner.ensure(job.job_account_id); }
          catch (error) {
            const candidate = (error as { code?: unknown })?.code;
            code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : 'PROVISIONER_UNAVAILABLE';
          }
          await pool.query('select public.reinlab_provision_finish($1,$2,$3)', [job.job_account_id, worker, code]);
          if (code) console.error(JSON.stringify({ code: 'AUTH_PROVISION_RETRY', reason: code }));
          continue;
        }
      } catch {
        if (!controller.signal.aborted) console.error(JSON.stringify({ code: 'AUTH_PROVISION_WORKER_UNAVAILABLE' }));
      }
      await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  return async () => {
    controller.abort();
    await running;
    await pool.end();
  };
}
