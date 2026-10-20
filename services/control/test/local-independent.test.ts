import {afterAll,afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,link,chmod,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {parseSupabaseStatus,writePrivateEnv,readPrivateEnv} from '../../../tooling/local/config';
import {quietCommand} from '../../../tooling/local/process';
import {startAuthProvisioner} from '../src/provisioner/auth-worker';
const roots:string[]=[],observations:Array<Record<string,unknown>>=[];
const admin=new pg.Pool({connectionString:'postgres://postgres@127.0.0.1:55432/reinlab_test',max:2});
const status={API_URL:'http://127.0.0.1:54321',DB_URL:'postgres://fixture:fixture-password@127.0.0.1:54322/postgres',ANON_KEY:'fixture-anon-padding-123456',JWT_SECRET:'fixture-jwt-padding-no-real-secret-123456'};
async function temporary(){const dir=await realpath(await mkdtemp(join(tmpdir(),'reinlab-local-independent-')));roots.push(dir);return dir;}
afterEach(async()=>{for(const dir of roots.splice(0))await rm(dir,{recursive:true,force:true});});
afterAll(async()=>{await admin.end();const out=process.env.REINLAB_EVIDENCE_OUT?resolve(process.env.REINLAB_EVIDENCE_OUT):await mkdtemp(join(tmpdir(),'reinlab-local-independent-evidence-'));await mkdir(out,{recursive:true});await writeFile(join(out,'local-independent-observations.json'),JSON.stringify({schemaVersion:1,nodeVersion:process.version,realAuthSignup:false,realDockerUsed:false,pgFixtureTransactionsRollback:true,observations},null,2)+'\n');});
it.each(['?host=203.0.113.7','?port=6543','?sslmode=require','#fragment'])('rejects DB URL suffix before bootstrap can reinterpret connection settings: %s',suffix=>{
 let rejected=false;try{parseSupabaseStatus(JSON.stringify({...status,DB_URL:status.DB_URL+suffix}));}catch{rejected=true;}observations.push({case:'db-url-suffix',suffix,rejected});expect(rejected).toBe(true);
});
it('treats timeout as failure even when the child handles SIGTERM and exits zero',async()=>{
 const result=await quietCommand(process.execPath,['-e',"process.on('SIGTERM',()=>process.exit(0));process.stdout.write('fixture-only');setInterval(()=>{},1000)"],{timeoutMs:200}).then(()=>({resolved:true}),error=>({code:error.message}));observations.push({case:'timeout-zero-exit',...result});expect(result).toEqual({code:'LOCAL_COMMAND_TIMEOUT'});
});
it('keeps child error output out of command rejection',async()=>{
 const fixture='fixture-private-output-must-not-surface';const error=await quietCommand(process.execPath,['-e',`process.stderr.write(${JSON.stringify(fixture)});process.exit(1)`],{timeoutMs:2000}).then(()=>null,error=>error);expect(error?.message).toBe('LOCAL_COMMAND_FAILED');expect(String(error)).not.toContain(fixture);observations.push({case:'child-error-sanitized',passed:true});
});
it('rejects hardlinks and FIFO files without changing the underlying private fixture',async()=>{
 const root=await temporary(),file=join(root,'private.env'),alias=join(root,'alias.env');await writePrivateEnv(file,{FIXTURE:'original'});await link(file,alias);
 await expect(readPrivateEnv(alias)).rejects.toThrow('LOCAL_SECRET_PATH_UNSAFE');await expect(writePrivateEnv(alias,{FIXTURE:'changed'})).rejects.toThrow('LOCAL_SECRET_PATH_UNSAFE');expect(await readFile(file,'utf8')).toContain('original');
 const fifo=join(root,'pipe.env');execFileSync('mkfifo',[fifo]);await chmod(fifo,0o600);await expect(readPrivateEnv(fifo)).rejects.toThrow('LOCAL_SECRET_PATH_UNSAFE');await expect(writePrivateEnv(fifo,{FIXTURE:'pipe'})).rejects.toThrow('LOCAL_SECRET_PATH_UNSAFE');observations.push({case:'hardlink-fifo-private-file',rejected:true});
});
it('rejects a symlink ancestor before writing private environment output',async()=>{
 const root=await temporary(),outside=join(root,'outside'),linkPath=join(root,'redirect');await mkdir(join(outside,'nested'),{recursive:true});await symlink(outside,linkPath);const file=join(linkPath,'nested','runtime.env');
 const error=await writePrivateEnv(file,{FIXTURE:'fixture-only'}).then(()=>null,error=>error);observations.push({case:'ancestor-symlink-private-file',rejected:Boolean(error)});expect(error?.message).toBe('LOCAL_SECRET_PATH_UNSAFE');
});
it('roundtrips accepted private-env strings without silently changing quotes or backslashes',async()=>{
 const root=await temporary(),file=join(root,'roundtrip.env'),values={FIXTURE_QUOTE:'value"quoted',FIXTURE_SLASH:'literal\\nvalue',FIXTURE_DOLLAR:'literal$NOT_EXPANDED'};await writePrivateEnv(file,values);const read=await readPrivateEnv(file);expect(read).toEqual(values);observations.push({case:'private-env-roundtrip',passed:true});
});
async function transaction(work:(c:pg.PoolClient,id:string)=>Promise<void>){const c=await admin.connect(),id=randomUUID();try{await c.query('begin');await c.query('insert into account(id) values($1)',[id]);await c.query("insert into reinlab_meta.provision_job(account_id,created_at) values($1,'-infinity')",[id]);await work(c,id);}finally{await c.query('rollback');c.release();}}
async function roleQuery(c:pg.PoolClient,role:'reinlab_app'|'reinlab_provisioner',sql:string,args:unknown[]=[]){await c.query('savepoint independent_role');await c.query('set local role '+role);try{const result=await c.query(sql,args);await c.query('reset role');await c.query('release savepoint independent_role');return result;}catch(error){await c.query('rollback to savepoint independent_role');await c.query('release savepoint independent_role');throw error;}}
it('real PG business role cannot manufacture claims, finish jobs or execute the Auth trigger',async()=>transaction(async(c,id)=>{
 for(const [sql,args] of [['select * from public.reinlab_provision_next($1)',[randomUUID()]],['select public.reinlab_provision_finish($1,$2,null)',[id,randomUUID()]],['select public.reinlab_handle_new_auth_user()',[]]] as const)await expect(roleQuery(c,'reinlab_app',sql,[...args])).rejects.toMatchObject({code:'42501'});
 observations.push({case:'business-role-queue-denials',denied:3});
}));
it('real PG worker cannot read/write the queue directly or access business account data',async()=>transaction(async(c,id)=>{
 for(const sql of ['select * from reinlab_meta.provision_job',`update reinlab_meta.provision_job set state='done' where account_id='${id}'`,'select * from public.account'])await expect(roleQuery(c,'reinlab_provisioner',sql)).rejects.toMatchObject({code:'42501'});observations.push({case:'worker-direct-access-denied',denied:3});
}));
it('real PG stale or foreign lease owner cannot finish a reclaimed job',async()=>transaction(async(c,id)=>{
 const old=randomUUID(),next=randomUUID();await c.query("update reinlab_meta.provision_job set state='leased',attempts=2,worker_id=$2,lease_until=now()-interval '1 second' where account_id=$1",[id,old]);const claim=await roleQuery(c,'reinlab_provisioner','select * from public.reinlab_provision_next($1)',[next]);expect(claim.rows[0]).toEqual({job_account_id:id,attempt:3});
 for(const [aid,worker] of [[id,old],[randomUUID(),next]])await expect(roleQuery(c,'reinlab_provisioner','select public.reinlab_provision_finish($1,$2,null)',[aid,worker])).rejects.toMatchObject({code:'42501'});
 await roleQuery(c,'reinlab_provisioner','select public.reinlab_provision_finish($1,$2,null)',[id,next]);await expect(roleQuery(c,'reinlab_provisioner','select public.reinlab_provision_finish($1,$2,null)',[id,next])).rejects.toMatchObject({code:'42501'});expect((await c.query('select state from reinlab_meta.provision_job where account_id=$1',[id])).rows[0].state).toBe('done');observations.push({case:'stale-reclaimed-lease',oldWorkerDenied:true,foreignAccountDenied:true,duplicateAckDenied:true});
}));
it('real PG keeps the eighth live lease and terminalizes it only after expiry',async()=>transaction(async(c,id)=>{
 const worker=randomUUID();await c.query("update reinlab_meta.provision_job set state='leased',attempts=8,worker_id=$2,lease_until=now()+interval '1 minute' where account_id=$1",[id,worker]);await roleQuery(c,'reinlab_provisioner','select * from public.reinlab_provision_next($1)',[randomUUID()]);expect((await c.query('select state from reinlab_meta.provision_job where account_id=$1',[id])).rows[0].state).toBe('leased');await c.query("update reinlab_meta.provision_job set lease_until=now()-interval '1 second' where account_id=$1",[id]);await roleQuery(c,'reinlab_provisioner','select * from public.reinlab_provision_next($1)',[randomUUID()]);expect((await c.query('select state,worker_id,lease_until,last_error_code from reinlab_meta.provision_job where account_id=$1',[id])).rows[0]).toEqual({state:'failed',worker_id:null,lease_until:null,last_error_code:'PROVISION_ATTEMPTS_EXHAUSTED'});observations.push({case:'eighth-live-then-expired-lease',livePreserved:true,expiredTerminal:true});
}));
it('real PG error-code injection is rejected without acknowledging the lease',async()=>transaction(async(c,id)=>{
 const worker=randomUUID();await c.query("update reinlab_meta.provision_job set state='leased',attempts=1,worker_id=$2,lease_until=now()+interval '1 minute' where account_id=$1",[id,worker]);await expect(roleQuery(c,'reinlab_provisioner','select public.reinlab_provision_finish($1,$2,$3)',[id,worker,'fixture raw\nsecret'])).rejects.toMatchObject({code:'22023'});expect((await c.query('select state from reinlab_meta.provision_job where account_id=$1',[id])).rows[0].state).toBe('leased');observations.push({case:'queue-error-code-injection',rejected:true,leasePreserved:true});
}));
it('rejecting a privileged worker connection releases its PG connection',async()=>{
 const name='reinlab_independent_'+randomUUID().replaceAll('-','');await expect(startAuthProvisioner('postgres://postgres@127.0.0.1:55432/reinlab_test?application_name='+name,{async ensure(){throw Error('must not run');}})).rejects.toThrow('UNSAFE_DATABASE_ROLE');const active=Number((await admin.query('select count(*) from pg_stat_activity where application_name=$1',[name])).rows[0].count);observations.push({case:'unsafe-worker-startup-pool',remainingConnections:active});expect(active).toBe(0);
});

it('real PG failed provisioning observes retry cooldown before a subsequent claim',async()=>transaction(async(c,id)=>{
 const worker=randomUUID();await roleQuery(c,'reinlab_provisioner','select * from public.reinlab_provision_next($1)',[worker]);await roleQuery(c,'reinlab_provisioner','select public.reinlab_provision_finish($1,$2,$3)',[id,worker,'OS_UNAVAILABLE']);const row=(await c.query('select state,attempts,worker_id,lease_until,next_attempt_at>now() cooling from reinlab_meta.provision_job where account_id=$1',[id])).rows[0];expect(row).toEqual({state:'pending',attempts:1,worker_id:null,lease_until:null,cooling:true});const immediate=await roleQuery(c,'reinlab_provisioner','select * from public.reinlab_provision_next($1)',[randomUUID()]);expect(immediate.rows.some(r=>r.job_account_id===id)).toBe(false);await c.query("update reinlab_meta.provision_job set next_attempt_at=now()-interval '1 second' where account_id=$1",[id]);const next=await roleQuery(c,'reinlab_provisioner','select * from public.reinlab_provision_next($1)',[randomUUID()]);expect(next.rows[0]).toEqual({job_account_id:id,attempt:2});observations.push({case:'queue-retry-cooldown',immediateReclaim:false,laterAttempt:2});
}));
