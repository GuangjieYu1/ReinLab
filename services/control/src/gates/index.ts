import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {GateState} from '@reinlab/contracts';
import {ApiFailure,denied} from '../api/errors';
import {appendEvent,requireDossier} from '../ledger';

const edges:Record<string,'user'|'system'>={'locked:ready':'system','ready:running':'user','running:review':'system','review:discuss':'user','discuss:review':'system','review:approved':'user'};
export function assertGateTransition(from:string,to:string,actor:string):void {
  const required=edges[from+':'+to];
  if(!required)throw new ApiFailure('GATE_LOCKED',409,'门禁当前不允许此操作。');
  if(required!==actor)throw new ApiFailure('SCOPE_DENIED',403,'此门禁操作需要对应的用户或流程身份。');
}
const Gate=z.object({id:z.string().uuid(),subject:z.string(),state:GateState,revision:z.number().int().nonnegative(),predecessorId:z.string().uuid().nullable(),reviewArtifactId:z.string().uuid().nullable()});
export type Gate=z.infer<typeof Gate>;
const columns='id,subject,state,revision,predecessor_id as "predecessorId",review_artifact_id as "reviewArtifactId"';
async function lock(client:pg.PoolClient,accountId:string):Promise<void> {
  const result=await client.query("select current_setting('app.account_id',true) id");
  if(result.rows[0].id!==accountId)throw denied();
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['ledger:'+accountId]);
}
export async function initializeGates(client:pg.PoolClient,accountId:string,dossierId:string,rawSubjects:string[]):Promise<Gate[]> {
  const subjects=z.array(z.string().trim().min(1).max(200)).min(1).max(32).refine(v=>new Set(v).size===v.length).parse(rawSubjects);
  await lock(client,accountId);await requireDossier(client,dossierId);
  const existing=await client.query(`select ${columns} from gate where dossier_id=$1 and subject=any($2::text[])`,[dossierId,subjects]);
  if(existing.rowCount){const found=subjects.map(subject=>existing.rows.find(g=>g.subject===subject));if(found.some((gate,i)=>!gate||gate.predecessorId!==(i?found[i-1]?.id:null))||(await client.query('select id from gate where predecessor_id=$1',[found.at(-1)?.id??null])).rowCount)throw new ApiFailure('GATE_CHAIN_CONFLICT',409,'阶段已属于其他顺序或门禁链。');return found.map(g=>Gate.parse(g));}
  const gates:Gate[]=[];
  for(const subject of subjects){
    const id=randomUUID(),predecessorId=gates.at(-1)?.id??null,state=predecessorId?'locked':'ready';
    const result=await client.query(`insert into gate(id,account_id,dossier_id,subject,state,predecessor_id) values($1,$2,$3,$4,$5,$6) returning ${columns}`,[id,accountId,dossierId,subject,state,predecessorId]);
    const gate=Gate.parse(result.rows[0]);gates.push(gate);
    await appendEvent(client,accountId,{dossierId,kind:'gate',action:'initialized',payload:{gateId:id,subject,state,predecessorId},dedupeKey:'gate-init:'+id});
  }
  return gates;
}
const Change=z.object({gateId:z.string().uuid(),expectedState:GateState,expectedRevision:z.number().int().nonnegative(),targetState:GateState,actor:z.enum(['user','system']),reviewArtifactId:z.string().uuid().optional(),operationId:z.string().uuid()}).strict();
export type GateChange=z.input<typeof Change>;
export async function transitionGate(client:pg.PoolClient,accountId:string,raw:unknown):Promise<{gate:Gate;nextGate:Gate|null}> {
  const input=Change.parse(raw);await lock(client,accountId);
  const rows=await client.query(`select ${columns},dossier_id from gate where id=$1 for update`,[input.gateId]);
  if(!rows.rowCount)throw denied();
  const {dossier_id:dossierId,...values}=rows.rows[0],gate=Gate.parse(values);
  if(gate.state!==input.expectedState||gate.revision!==input.expectedRevision)throw new ApiFailure('GATE_STATE_CONFLICT',409,'门禁状态或审阅版本已变化，请刷新后重试。');
  assertGateTransition(gate.state,input.targetState,input.actor);
  if(input.targetState==='ready'){
    if(!gate.predecessorId||!(await client.query("select id from gate where id=$1 and state='approved'",[gate.predecessorId])).rowCount)throw new ApiFailure('GATE_LOCKED',409,'上一阶段尚未批准。');
  }
  let reviewArtifactId=gate.reviewArtifactId;
  if(input.targetState==='review'){
    if(!input.reviewArtifactId||!(await client.query('select id from artifact where id=$1 and dossier_id=$2',[input.reviewArtifactId,dossierId])).rowCount)throw new ApiFailure('REVIEW_EVIDENCE_REQUIRED',409,'需要本档案的可审阅产物。');
    reviewArtifactId=input.reviewArtifactId;
  }
  if(input.targetState==='approved'&&!reviewArtifactId)throw new ApiFailure('REVIEW_EVIDENCE_REQUIRED',409,'门禁缺少可审阅产物。');
  const updated=await client.query(`update gate set state=$2,review_artifact_id=$3,revision=revision+1,updated_at=now() where id=$1 returning ${columns}`,[gate.id,input.targetState,reviewArtifactId]);
  const result=Gate.parse(updated.rows[0]);
  const action:Record<string,string>={ready:'unlocked',running:'started',review:gate.state==='discuss'?'resubmitted':'submitted',discuss:'discussed',approved:'approved'};
  await appendEvent(client,accountId,{dossierId,kind:'gate',action:action[result.state],risk:input.actor==='user'?'write':null,payload:{gateId:gate.id,subject:gate.subject,from:gate.state,to:result.state,revision:result.revision,actor:input.actor,reviewArtifactId},dedupeKey:'gate:'+gate.id+':'+input.operationId});
  let nextGate:Gate|null=null;
  if(result.state==='approved'){
    const next=await client.query("select id,revision from gate where predecessor_id=$1 and state='locked'",[result.id]);
    if(next.rowCount)nextGate=(await transitionGate(client,accountId,{gateId:next.rows[0].id,expectedState:'locked',expectedRevision:next.rows[0].revision,targetState:'ready',actor:'system',operationId:input.operationId})).gate;
  }
  return{gate:result,nextGate};
}
