import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mcpFixture } from './mcp-fixture';
import { BindingStore } from '../src/bridge/openscience/binding-store';
import { ObservationStore } from '../src/bridge/openscience/observation-store';

it('terminal expiration is scoped, preserves prior decisions and rolls back with its audit event', async () => {
  const f = await mcpFixture(), other = await mcpFixture(), sibling = randomUUID(), probe = 'review_terminal_' + randomUUID().replaceAll('-', '');
  const expected = new Map<string, string>();
  try {
    await f.admin.query("update run set state='queued' where id=$1", [f.run]);
    const store = new BindingStore(f.db);
    const binding = await store.prepare(f.account, f.run, { role: { dossierId: f.dossier, role: { id: 'research-read', prompt: '只读', toolGrants: {}, writeTargets: [], steps: 1 }, memory: '', model: 'fixture/fixture' }, message: 'fixture' });
    const lease = (await store.claim(f.account, f.run))!;
    await store.baseline(f.account, f.run, lease, 0); await store.sendIntent(f.account, f.run, lease); await store.receipt(f.account, f.run, { runID: 'run_review', acceptedAt: 1 });
    await f.admin.query('update os_binding set hold_id=$2 where run_id=$1', [f.run, f.hold]);
    await f.admin.query("update run set state='running' where id=$1", [f.run]);
    await f.admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'running',1)", [sibling, f.account, f.dossier, randomUUID()]);
    for (const [account, run, kind, state, after] of [
      [f.account, f.run, 'permission', 'pending', 'expired'], [f.account, f.run, 'question', 'pending', 'expired'],
      [f.account, f.run, 'permission', 'approved', 'approved'], [f.account, f.run, 'question', 'indeterminate', 'indeterminate'],
      [f.account, f.run, 'budget', 'pending', 'pending'], [f.account, sibling, 'permission', 'pending', 'pending'],
      [other.account, other.run, 'question', 'pending', 'pending'],
    ]) {
      const id = randomUUID(); expected.set(id, after);
      await f.admin.query("insert into approval(id,account_id,run_id,kind,title,effects,risk,state) values($1,$2,$3,$4,'fixture','{}','write',$5)", [id, account, run, kind, state]);
    }
    const event = { sessionID: binding.sessionId, runID: 'run_review', sequence: 1, type: 'runtime.failed', properties: { message: 'fixture', recovered: true }, time: 100 };
    const observer = new ObservationStore(f.db);
    await f.admin.query(`create function public.${probe}() returns trigger language plpgsql as $$begin if new.run_id='${f.run}'::uuid and new.action='runtime_approvals_expired' then raise exception 'SYNTHETIC_AUDIT_FAILURE'; end if; return new; end$$; create trigger ${probe} before insert on event for each row execute function public.${probe}()`);
    await expect(observer.ingest(f.account, f.run, event)).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');
    expect((await f.admin.query('select state from approval where run_id=$1 and kind in (\'permission\',\'question\') order by state', [f.run])).rows.map(r => r.state)).toEqual(['approved', 'indeterminate', 'pending', 'pending']);
    expect((await f.admin.query('select state,ended_at from run where id=$1', [f.run])).rows[0]).toEqual({ state: 'running', ended_at: null });
    await f.admin.query(`drop trigger ${probe} on event; drop function public.${probe}()`);
    await expect(observer.ingest(other.account, f.run, event)).rejects.toMatchObject({ code: 'RLS_DENIED' });
    await observer.ingest(f.account, f.run, event); await observer.ingest(f.account, f.run, event);
    const rows = (await f.admin.query('select id,state from approval where id=any($1::uuid[])', [[...expected.keys()]])).rows;
    expect(rows.every(r => expected.get(r.id) === r.state)).toBe(true);
    const audit = (await f.admin.query("select payload from event where run_id=$1 and action='runtime_approvals_expired'", [f.run])).rows;
    expect(audit).toEqual([{ payload: { count: 2 } }]);
  } finally {
    await f.admin.query(`drop trigger if exists ${probe} on event; drop function if exists public.${probe}()`);
    await other.close(); await f.close();
  }
}, 30_000);
