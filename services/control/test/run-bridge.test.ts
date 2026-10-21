import {beforeAll,afterAll,expect,it} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {Database} from '../src/db/database';
import {applyMigrations} from '../src/db/migrate';
import {allocateBudget} from '../src/budget';
import {RunBridge} from '../src/bridge/openscience/run-bridge';
import {RoleRuntime} from '../src/bridge/openscience/role-runtime';
import {prepareRoleProject} from '../src/bridge/openscience/role-project';
import {startRoleProvider,startNativeRoleServer} from './fixtures/role-provider';
const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL??'postgres://postgres@127.0.0.1:55432/reinlab_test',max:2}),pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test',max:3}),db=new Database(pool),account=randomUUID();
beforeAll(async()=>{await applyMigrations(admin,resolve('infra/supabase/migrations'));await admin.query('insert into account(id) values($1)',[account]);});
afterAll(async()=>{await pool.end();await admin.end();});
it.each(['controller_restart','in_flight_replay','kernel_restart'] as const)('durable DB binding + native receipt: %s',async scenario=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'reinlab-db-recovery-'))),provider=await startRoleProvider();let server:Awaited<ReturnType<typeof startNativeRoleServer>>|undefined,release=()=>{};
 try{
 server=await startNativeRoleServer(root,provider.url);const dossier=randomUUID(),id=randomUUID(),message='DB_RECOVERY_'+scenario;
 await admin.query("insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','recovery',$3)",[dossier,account,'/data/dossiers/'+dossier]);
 await admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'queued',1,'{}')",[id,account,dossier,randomUUID()]);
 await db.withAccount(account,async c=>{const parent=await allocateBudget(c,account,{dossierId:dossier,amountCny:'1'});await allocateBudget(c,account,{dossierId:dossier,runId:id,parentId:parent.id,amountCny:'1'});});
 const definition={role:{dossierId:dossier,role:{id:'research-read',prompt:'测试角色。禁止工具。',toolGrants:{},writeTargets:[],steps:1},model:'role-fixture/fixture',memory:''},message};
 const factory=async(_account:string,role:typeof definition.role)=>new RoleRuntime({...server!,project:await prepareRoleProject({...role,root,pluginUrl:pathToFileURL(resolve('plugins/reinlab-os-plugin/index.js')).href})});
 if(scenario!=='controller_restart')provider.delays.set(message,new Promise<void>(done=>{release=done;}));
 const first=new RunBridge(db,factory),receipt=await first.submit(account,id,definition);expect(receipt.status).toBe('accepted');
 await expect.poll(()=>provider.requests.length,{timeout:10000}).toBe(1);
 if(scenario==='controller_restart')await expect.poll(async()=>{const runtime=await first.runtime(account,id);return(await runtime.snapshot((await first.store.get(account,id)).sessionId)).runs[0]?.state;},{timeout:10000}).toBe('completed');
 if(scenario==='kernel_restart'){await server.close();server=undefined;release();server=await startNativeRoleServer(root,provider.url);}
 const restored=new RunBridge(new Database(pool),factory);expect(await restored.submit(account,id,definition)).toEqual(receipt);
 await expect(restored.submit(account,id,{...definition,message:message+' different'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 expect(provider.requests).toHaveLength(1);expect((await restored.store.get(account,id)).holdId).toBeTruthy();release();
 }finally{release();await server?.close();await provider.close();await rm(root,{recursive:true,force:true});}
},60000);
