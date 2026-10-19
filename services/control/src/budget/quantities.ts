import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {ApiFailure,denied} from '../api/errors';
import {appendEvent} from '../ledger';

export type Dimension='quota'|'gpu';
export const dimensions:Dimension[]=['quota','gpu'];
export const quantityColumns='quota_limit::text,gpu_limit::text,quota_spent::text,gpu_spent::text';
const columns={quota:{limit:'quota_limit',spent:'quota_spent',maximum:'maximum_quota',actual:'actual_quota'},gpu:{limit:'gpu_limit',spent:'gpu_spent',maximum:'maximum_gpu_seconds',actual:'actual_gpu_seconds'}} as const;
export function quantity(value:unknown):number {const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new ApiFailure('USAGE_RANGE_INVALID',503,'额度或算力数据需要先核对。');return n;}
export function limit(node:Record<string,any>,dimension:Dimension):number|null {const value=node[columns[dimension].limit];return value===null?null:quantity(value);}
export async function unallocatedQuantity(client:pg.PoolClient,node:Record<string,any>,dimension:Dimension):Promise<number|null> {
  const cap=limit(node,dimension);if(cap===null)return null;const col=columns[dimension];
  const rows=await client.query(`select
    (select coalesce(sum(greatest(${col.limit}-${col.spent},0)),0)::text from budget_allocation where parent_id=$1) children,
    (select coalesce(sum(greatest(${col.maximum}-${col.actual},0)),0)::text from budget_hold where allocation_id=$1 and state in ('reserved','unpriced')) direct`,[node.id]);
  return cap-quantity(node[col.spent])-quantity(rows.rows[0].children)-quantity(rows.rows[0].direct);
}
export async function fitsQuantities(client:pg.PoolClient,path:Record<string,any>[],requested:{quota:number;gpu:number}):Promise<boolean> {
  for(let index=0;index<path.length;index++)for(const dimension of dimensions){
    const node=path[index],cap=limit(node,dimension);if(cap===null)continue;const col=columns[dimension],spent=quantity(node[col.spent]);
    if(spent>0&&spent>=cap)return false;
    const child=index?path[index-1].id:null;
    const rows=await client.query(`with recursive branch as (select id from budget_allocation where id=$2::uuid union all select a.id from budget_allocation a join branch p on a.parent_id=p.id) select
      (select coalesce(sum(greatest(${col.limit}-${col.spent},0)),0)::text from budget_allocation where parent_id=$1 and($2::uuid is null or id<>$2)) children,
      (select coalesce(sum(greatest(${col.maximum}-${col.actual},0)),0)::text from budget_hold where state in ('reserved','unpriced') and(allocation_id=$1 or allocation_id in(select id from branch))) pending`,[node.id,child]);
    if(spent+quantity(rows.rows[0].children)+quantity(rows.rows[0].pending)+requested[dimension]>cap)return false;
  }
  return true;
}
export async function growQuantity(client:pg.PoolClient,id:string,dimension:Dimension,delta:number,touched:Set<string>) {
  if(!delta)return;quantity(delta);const col=columns[dimension],rows=await client.query(`select *,period::text from budget_allocation where id=$1`,[id]);if(!rows.rowCount)throw denied();const node=rows.rows[0],cap=limit(node,dimension);
  if(cap===null)return;const spent=quantity(node[col.spent]);quantity(cap+delta);
  if(node.parent_id){const parent=(await client.query('select * from budget_allocation where id=$1',[node.parent_id])).rows[0];if(!parent)throw denied();const available=await unallocatedQuantity(client,parent,dimension);if(available!==null){const added=Math.max(cap+delta-spent,0)-Math.max(cap-spent,0),needed=added-available;if(needed>0)await growQuantity(client,parent.id,dimension,needed,touched);}}
  await client.query(`update budget_allocation set ${col.limit}=${col.limit}+$2 where id=$1`,[node.id,delta]);
  if(node.run_id){await client.query(`update run set ${col.limit}=${col.limit}+$2 where id=$1`,[node.run_id,delta]);touched.add(node.run_id);}
  if(node.delegation_id){
    const field=dimension==='quota'?'quotaRuns':'gpuMinutes',value=dimension==='quota'?cap+delta:(cap+delta)/60;
    await client.query(`update delegation set request=jsonb_set(request,'{budget}',coalesce(request->'budget',jsonb_build_object('cny',budget_cny))||jsonb_build_object($2::text,$3::numeric),true) where id=$1`,[node.delegation_id,field,value]);
  }
  await appendEvent(client,node.account_id,{dossierId:node.dossier_id,runId:node.run_id,kind:'gate',action:'budget_quantity_increased',payload:{allocationId:node.id,dimension,added:delta,limit:cap+delta,period:node.period},dedupeKey:'allocation-quantity:'+randomUUID()});
}
