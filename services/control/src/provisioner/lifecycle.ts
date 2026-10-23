import {runtimeConfiguration} from "../configuration";
import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import {Database} from '../db/database';
import {ApiFailure} from '../api/errors';
import {appendEvent} from '../ledger';
import {AccountProvisioner,SupabaseKeyVault,environmentDriver,type KeyVault} from './index';
import {driverFor,type Machines,type AccountDriver} from './driver';
import {decryptBundle,type Tokens} from './runtime';
const uuid=z.string().uuid();
async function duplicateSnapshot(response:Response){
 if(response.status===409){await response.body?.cancel();return true;}
 if(response.status!==400||!response.headers.get('content-type')?.startsWith('application/json')||!response.body){await response.body?.cancel();return false;}
 const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4096){await reader.cancel();return false;}chunks.push(part.value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')).code==='KeyAlreadyExists';
 }catch{return false;}finally{reader.releaseLock();}
}
const fail=(code:string,status:400|401|403|404|409|413|500|503=503)=>new ApiFailure(code,status,'账户生命周期操作未完成，请查看运维状态。');
type Config={app:string;storageUrl:string;storageToken:string;controlUrl:string};
type MachineRow={fly_machine_id:string|null;fly_volume_id:string|null;runtime_id:string|null;state:string};
/** Trusted service API only. accountId must come from a verified Auth event / authenticated operations job.
 * This module does not authenticate public webhooks and MUST NOT be mounted as a public accountId endpoint. */
export class AccountLifecycle {
 private storage:URL;private driver:AccountDriver;
 constructor(private db:Database,machines:Machines,private vault:KeyVault,private config:Config,private transport:typeof fetch=fetch){
  this.driver=driverFor(machines);
  if(!/^[a-z0-9][a-z0-9-]{1,62}$/.test(config.app)||!config.storageToken||config.storageToken.startsWith('sb_secret_')||/\s/.test(config.storageToken))throw fail('LIFECYCLE_CONFIG_MISSING');
  try{this.storage=new URL(config.storageUrl);if(!((this.storage.protocol==='https:'&&this.storage.hostname.endsWith('.supabase.co'))||(this.driver.kind==='docker'&&this.storage.protocol==='http:'&&this.storage.hostname==='127.0.0.1'&&/^\d+$/.test(this.storage.port)))||this.storage.username||this.storage.password||this.storage.pathname!=='/'||this.storage.search||this.storage.hash)throw Error();
   // Enforce the dedicated Storage identity; Storage verifies the JWT signature.
   const parts=config.storageToken.split('.');if(parts.length!==3||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p))||JSON.parse(Buffer.from(parts[1],'base64url').toString()).role!=='reinlab_snapshot_writer')throw Error();
   const control=new URL(config.controlUrl);if(!((this.driver.kind==='fly'&&control.protocol==='http:'&&control.hostname.endsWith('.internal'))||(this.driver.kind==='docker'&&config.controlUrl==='http://host.docker.internal:3001/'))||control.username||control.password||control.pathname!=='/'||control.search||control.hash)throw Error();
  }catch{throw fail('LIFECYCLE_CONFIG_MISSING');}
 }
 async registered(event:{source:'supabase-auth';accountId:string},provisioner:Pick<AccountProvisioner,'ensure'>){if(event.source!=='supabase-auth')throw fail('AUTH_INVALID',401);uuid.parse(event.accountId);return provisioner.ensure(event.accountId);}
 private async interrupt(c:pg.PoolClient,id:string,reason:string,operation:string){
  // Same lock order as appendEvent, then lock rows to serialize lifecycle transactions.
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['ledger:'+id]);
  const runs=await c.query("select id,dossier_id from run where account_id=$1 and state='running' order by id for update",[id]);
  for(const run of runs.rows){await c.query("update run set state='interrupted',ended_at=now() where id=$1 and state='running'",[run.id]);await appendEvent(c,id,{dossierId:run.dossier_id,runId:run.id,kind:'gate',action:'run_interrupted',payload:{reason},dedupeKey:'lifecycle:'+operation+':'+run.id});}
 }
 private async machine(c:pg.PoolClient,id:string){const r=await c.query<MachineRow>('select fly_machine_id,fly_volume_id,runtime_id,state from account_machine where account_id=$1',[id]);if(!r.rowCount||!r.rows[0].fly_machine_id||!r.rows[0].fly_volume_id)throw fail('ACCOUNT_MACHINE_UNAVAILABLE');return r.rows[0];}
 private async tokens(c:pg.PoolClient,id:string):Promise<Tokens>{const key=await this.vault.key(c);try{const r=await c.query('select envelope from account_machine_secret where account_id=$1',[id]);if(!r.rowCount)throw fail('VAULT_UNAVAILABLE');return decryptBundle(id,key,r.rows[0].envelope);}finally{key.fill(0);}}
 async reconcileRuntime(id:string,runtimeId:string){uuid.parse(id);if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(runtimeId))throw fail('INVALID_INPUT',400);return this.db.withAccount(id,async c=>{await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['ledger:'+id]);await c.query('select account_id from account_machine where account_id=$1 for update',[id]);const row=await this.machine(c,id);if(row.runtime_id!==runtimeId){await this.interrupt(c,id,'runtime_restart','runtime:'+runtimeId);await c.query('update account_machine set runtime_id=$2,last_health_at=now(),updated_at=now() where account_id=$1',[id,runtimeId]);}return {code:'RUNTIME_RECONCILED'};});}
 private async claim(id:string,lease:string){await this.db.withAccount(id,async c=>{await this.machine(c,id);if(!(await c.query("update account_machine set lease_id=$2,lease_until=now()+interval '200 seconds' where account_id=$1 and (lease_id is null or lease_until<now()) returning account_id",[id,lease])).rowCount)throw fail('PROVISIONING_BUSY',409);});}
 private async release(id:string,lease:string){await this.db.withAccount(id,c=>c.query('update account_machine set lease_id=null,lease_until=null where account_id=$1 and lease_id=$2',[id,lease]));}
 async upgrade(id:string,image:string,mode:'wait'|'interrupt',operationId:string){uuid.parse(id);uuid.parse(operationId);this.driver.validateImage(image);if(!['wait','interrupt'].includes(mode))throw fail('INVALID_INPUT',400);const lease=randomUUID();await this.claim(id,lease);
  try{
   const requestHash=createHash('sha256').update(JSON.stringify({image,mode})).digest('hex');
   const operation=(await this.db.withAccount(id,c=>c.query('select request_hash,state from account_machine_operation where account_id=$1 and operation_id=$2',[id,operationId]))).rows[0];
   if(operation&&operation.request_hash!==requestHash)throw fail('DEDUPE_CONFLICT',409);
   if(operation?.state==='applied')return {code:'UPDATE_REQUESTED'};
   const {row,tokens}=await this.db.withAccount(id,async c=>({row:await this.machine(c,id),tokens:await this.tokens(c,id)}));
   const [machines,volumes]=await Promise.all([this.driver.listMachines(),this.driver.listVolumes()]);
   const expectedEnv=this.driver.plan({accountId:id,volumeId:row.fly_volume_id!,image,controlUrl:this.config.controlUrl,tokens}).config.env;
   const matches=machines.filter(m=>m.id===row.fly_machine_id||m.config.metadata?.reinlab_account_id===id),m=matches[0],v=volumes.find(v=>v.id===row.fly_volume_id);
   if(matches.length!==1||!m||m.config.auto_destroy!==false||(m.config.restart as {policy?:string}|undefined)?.policy!=='always'||Object.entries(expectedEnv).some(([k,v])=>(m.config.env as Record<string,string>|undefined)?.[k]!==v)||m.id!==row.fly_machine_id||m.region!==this.driver.region||m.config.metadata?.reinlab_account_id!==id||m.config.mounts?.length!==1||m.config.mounts[0].volume!==row.fly_volume_id||m.config.mounts[0].path!=='/data'||(m.config.services!==undefined&&(!Array.isArray(m.config.services)||m.config.services.length!==0))||!v||v.region!==this.driver.region||v.name!=='rl_'+id.replaceAll('-','')||(v.attached_machine_id&&v.attached_machine_id!==m.id))throw fail('PROVISIONING_CONFLICT',409);
   if(operation){if(m.config.image!==image)throw fail('PROVISIONING_INDETERMINATE',409);await this.db.withAccount(id,c=>c.query("update account_machine_operation set state='applied' where account_id=$1 and operation_id=$2",[id,operationId]));return {code:'UPDATE_REQUESTED'};}
   await this.db.withAccount(id,async c=>{
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['ledger:'+id]);
    const fenced=await c.query('select account_id from account_machine where account_id=$1 and lease_id=$2 and lease_until>now() for update',[id,lease]);if(!fenced.rowCount)throw fail('PROVISIONING_LEASE_LOST',409);
    if((await this.machine(c,id)).state!=='ready')throw fail('ACCOUNT_MACHINE_UNAVAILABLE',409);
    if((await c.query("select operation_id from account_machine_operation where account_id=$1 and state in ('pending','indeterminate') limit 1",[id])).rowCount)throw fail('PROVISIONING_INDETERMINATE',409);
    if(mode==='wait'&&(await c.query("select id from run where account_id=$1 and state='running' limit 1",[id])).rowCount)throw fail('ACTIVE_RUNS',409);
    await c.query("insert into account_machine_operation(account_id,operation_id,request_hash,image,mode,state) values($1,$2,$3,$4,$5,'pending')",[id,operationId,requestHash,image,mode]);
    await this.interrupt(c,id,'image_upgrade','upgrade:'+operationId);
    await c.query("update account_machine set state='starting',phase=$3,image=$4,updated_at=now() where account_id=$1 and lease_id=$2",[id,lease,'upgrade_pending:'+operationId,image]);
   });
   try{await this.driver.update(m.id,{...m.config,image});}catch{await this.db.withAccount(id,c=>c.query("update account_machine_operation set state='indeterminate' where account_id=$1 and operation_id=$2 and state='pending'",[id,operationId]));throw fail('PROVISIONING_INDETERMINATE',409);}
   await this.db.withAccount(id,c=>c.query("update account_machine_operation set state='applied' where account_id=$1 and operation_id=$2",[id,operationId]));return {code:'UPDATE_REQUESTED'};
  }catch(error){if(error instanceof ApiFailure)throw error;throw fail('LIFECYCLE_UNAVAILABLE');}finally{await this.release(id,lease);}
 }
 async snapshot(id:string,date=new Date().toISOString().slice(0,10)){
  uuid.parse(id);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw fail('INVALID_INPUT',400);
  const lease=randomUUID();await this.claim(id,lease);
  try{
   const source=await this.db.withAccount(id,async c=>{
    const fenced=await c.query('select account_id from account_machine where account_id=$1 and lease_id=$2 and lease_until>now() for update',[id,lease]);if(!fenced.rowCount)throw fail('PROVISIONING_LEASE_LOST',409);
    const m=await this.machine(c,id);if(m.state!=='ready')throw fail('ACCOUNT_MACHINE_UNAVAILABLE');
    if((await c.query("select id from run where account_id=$1 and state='running' limit 1",[id])).rowCount)throw fail('ACTIVE_RUNS',409);
    return {machine:m.fly_machine_id!,tokens:await this.tokens(c,id)};
   });
   const signal=AbortSignal.timeout(120000);
   const response=await this.transport((await this.driver.endpoint(source.machine,this.config.app))+'/reinlab/backup',{headers:{authorization:'Bearer '+source.tokens.auth},redirect:'error',signal});
   if(!response.ok||!response.body||!response.headers.get('content-type')?.startsWith('application/x-tar')){await response.body?.cancel();throw fail('SNAPSHOT_UNAVAILABLE');}
   const target=new URL('/storage/v1/object/dossier-snapshots/'+id+'/'+date+'.tar',this.storage);
   const result=await this.transport(target,{method:'POST',headers:{authorization:'Bearer '+this.config.storageToken,'content-type':'application/x-tar','x-upsert':'false'},body:response.body,duplex:'half',redirect:'error',signal} as RequestInit & {duplex:'half'});
   if(!result.ok){if(await duplicateSnapshot(result))return {code:'SNAPSHOT_EXISTS'};throw fail('SNAPSHOT_UNAVAILABLE');}await result.body?.cancel();return {code:'SNAPSHOT_STORED'};
  }catch(error){if(error instanceof ApiFailure)throw error;throw fail('SNAPSHOT_UNAVAILABLE');}finally{await this.release(id,lease);}
 }
}
export function lifecycleFromEnvironment(db:Database){const config=runtimeConfiguration();const {SUPABASE_URL,STORAGE_SERVICE_TOKEN,REINLAB_CONTROL_URL}=config;if(!SUPABASE_URL||!STORAGE_SERVICE_TOKEN||!REINLAB_CONTROL_URL)throw fail('LIFECYCLE_CONFIG_MISSING');return new AccountLifecycle(db,environmentDriver(),new SupabaseKeyVault(),{app:config.FLY_APP_ACCOUNTS??'reinlab-local',storageUrl:SUPABASE_URL,storageToken:STORAGE_SERVICE_TOKEN,controlUrl:REINLAB_CONTROL_URL});}
