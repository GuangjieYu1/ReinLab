import type { Database } from '../db/database';
import type { RuntimeApiPort } from '../api/runtime';
import { lockBudget, settleObservedRun } from '../budget';
import { appendEvent, requireDossier } from '../ledger';

/** Explicit human stop only. Fence new forwarding before cancelling the native run. */
export async function closeClarifications(db: Database, account: string, dossier: string, pipeline?: RuntimeApiPort) {
  const runs = await db.withAccount(account, async c => {
    await lockBudget(c,account); await requireDossier(c,dossier);
    const rows = (await c.query(`select r.id,b.phase,b.receipt from run r join read_clarify_run cr on cr.run_id=r.id
      left join os_binding b on b.run_id=r.id where r.dossier_id=$1 and (not cr.closed or r.ended_at is null or b.usage_uncertain) order by r.created_at,r.id`,[dossier])).rows;
    await c.query('update read_clarify_run set closed=true where dossier_id=$1',[dossier]);
    await c.query('insert into read_clarification(account_id,dossier_id,closed,selection_revision) values($1,$2,true,1) on conflict do nothing',[account,dossier]);
    await c.query('update read_clarification set closed=true,selection_revision=selection_revision+1 where dossier_id=$1 and not closed',[dossier]);
    return rows;
  });
  const results = [];
  for (const r of runs) {
    let outcome: {status: string; state?: string} | undefined;
    if (r.phase === 'accepted' && r.receipt && pipeline) {
      try { outcome = await pipeline.decisions.cancel(account,r.id); } catch { /* Unknown stays unknown. */ }
      try { await pipeline.reconcileRun?.(account,r.id); } catch { /* No model is replayed. */ }
    }
    results.push(await db.withAccount(account, async c => {
      await lockBudget(c,account);
      const row = (await c.query('select r.*,b.hold_id,b.phase,b.receipt,b.usage_uncertain from run r left join os_binding b on b.run_id=r.id where r.id=$1 for update of r',[r.id])).rows[0];
      const unknownRequests = (await c.query("select 1 from runtime_model_request where run_id=$1 and state<>'completed' union all select 1 from clarify_model_request where run_id=$1 and state<>'completed' limit 1",[r.id])).rowCount;
      if (row.hold_id && row.phase === 'accepted') {
        const proof=(await c.query(`select
          case when exists(select 1 from runtime_model_request where run_id=$1) then (select count(*) from runtime_model_request where run_id=$1) else (select count(*) from clarify_model_request where run_id=$1) end calls,
          (select count(*) from os_usage where run_id=$1) usages,
          exists(select 1 from os_usage where run_id=$1 and cost_cny is null) unknown`,[r.id])).rows[0];
        const complete=!unknownRequests && (row.ended_at !== null || outcome?.status==='resolved') &&
          (!row.usage_uncertain || (Number(proof.calls)>0 && proof.calls===proof.usages && !proof.unknown));
        const settlement=await settleObservedRun(c,account,r.id,complete);
        if (settlement.settled && complete && row.usage_uncertain)
          await appendEvent(c,account,{dossierId:dossier,runId:r.id,roleId:'research-clarify',kind:'gate',action:'clarify_usage_reconciled',payload:{settlementEventSeq:settlement.eventSeq,calls:Number(proof.calls),usages:Number(proof.usages)},dedupeKey:'clarify-reconciled:'+r.id+':'+settlement.eventSeq});
      }
      const unstarted = !row.hold_id && !row.receipt && row.phase !== 'submitting' && !unknownRequests;
      const state = row.ended_at !== null ? row.state : outcome?.status === 'resolved' ? outcome.state : unstarted ? 'cancelled' : 'interrupted';
      if (row.ended_at === null) await c.query('update run set state=$2,ended_at=now() where id=$1',[r.id,state]);
      await c.query("update approval set state='expired',decided_at=now() where run_id=$1 and kind='question' and state='pending'",[r.id]);
      const value = (await c.query("select spent_cny::text spent,exists(select 1 from budget_hold where run_id=$1 and state='unpriced') unknown from run where id=$1",[r.id])).rows[0];
      const unknown = value.unknown || !!unknownRequests;
      await appendEvent(c,account,{dossierId:dossier,runId:r.id,roleId:'research-clarify',kind:'gate',action:'clarify_closed',payload:{state,knownCny:value.spent,unknownCost:unknown},dedupeKey:'clarify-closed:'+r.id});
      return {runId:r.id,state,spentCny:value.spent,unknownCost:unknown};
    }));
  }
  return results;
}
