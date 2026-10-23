import {mkdtempSync,realpathSync} from "node:fs";
import {testEvidenceDirectory} from './fixtures/test-evidence';
import {afterAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {DockerMachines,dockerPlan,type EngineTransport} from '../src/provisioner/docker';
import {AccountProvisioner} from '../src/provisioner';
import {AccountLifecycle} from '../src/provisioner/lifecycle';
import {Database} from '../src/db/database';
const observations:Array<Record<string,unknown>>=[];
const base={accountId:'44444444-4444-4444-8444-444444444444',volumeId:'rl_44444444444444448444444444444444',image:'reinlab-account:local',controlUrl:'http://host.docker.internal:3001/',tokens:{auth:'a'.repeat(43),container:'b'.repeat(43)}};
function engine(){
 const calls:Array<{path:string;method:string}>=[],containers:any[]=[],volumes:any[]=[];let lose:'volume'|'machine'|undefined;
 const transport:EngineTransport=async(path,method,body)=>{
  calls.push({path,method});
  if(path.startsWith('/images/'))return {Config:{Env:[]}};
  if(path==='/volumes/create'){const b=structuredClone(body) as any;volumes.push({...b,Options:{}});if(lose==='volume'){lose=undefined;throw Error('fixture response lost '+base.tokens.auth);}return b;}
  if(path==='/volumes')return {Volumes:volumes};
  if(path==='/containers/json?all=true')return containers.map(c=>({Id:c.Id,Names:[c.Name],Labels:c.Config.Labels,Mounts:c.Mounts}));
  if(path.startsWith('/containers/create?')){const b=structuredClone(body) as any;const c={Id:'d'.repeat(64),Name:'/'+path.split('=')[1],Config:{...b,Entrypoint:['node','/opt/reinlab/account-entrypoint.mjs']},Image:'sha256:'+'f'.repeat(64),HostConfig:b.HostConfig,Mounts:[{Type:'volume',Name:b.HostConfig.Binds[0].split(':')[0],Destination:'/data',RW:true},{Type:'bind',Source:b.HostConfig.Binds[1].split(':')[0],Destination:'/run/reinlab-source/account.json',RW:false}],State:{Running:false},NetworkSettings:{Ports:{'4097/tcp':[{HostIp:'127.0.0.1',HostPort:'49222'}]},Networks:{bridge:{NetworkID:'fixture-bridge'}}}};containers.push(c);if(lose==='machine'){lose=undefined;throw Error('fixture response lost '+base.tokens.container);}return {Id:c.Id};}
  const key=path.split('/')[2],c=containers.find(c=>c.Id===key||c.Name==='/'+key);
  if(path.endsWith('/json'))return c;
  if(path.endsWith('/start')){c.State.Running=true;return {};}
  if(path.includes('/stop')){c.State.Running=false;return {};}
  if(method==='DELETE'){containers.splice(containers.indexOf(c),1);return {};}
  throw Error('unexpected fake engine route');
 };
 return {api:new DockerMachines('unix:///tmp/reinlab-independent.sock',transport,realpathSync(mkdtempSync(join(tmpdir(),'reinlab-credential-independent-')))),calls,containers,volumes,loseResponse:(stage:'volume'|'machine')=>{lose=stage;}};
}
afterAll(async()=>{const dir=await testEvidenceDirectory('docker-independent');await writeFile(join(dir,'docker-independent-observations.json'),JSON.stringify({schemaVersion:1,nodeVersion:process.version,engine:'test-only fake Docker Engine or temporary Unix HTTP socket',realDockerValidated:false,observations},null,2)+'\n');});
it.each([
 ['control host remapped',(c:any)=>{c.HostConfig.ExtraHosts=['host.docker.internal:203.0.113.9'];}],
 ['foreign attached network',(c:any)=>{c.NetworkSettings.Networks.foreign={NetworkID:'foreign-network'};}],
 ['unconfined apparmor',(c:any)=>{c.HostConfig.SecurityOpt.push('apparmor=unconfined');}],
 ['extra device request',(c:any)=>{c.HostConfig.DeviceRequests=[{Driver:'nvidia',Count:-1,Capabilities:[['gpu']]}];}],
] as const)('rejects an existing controlled container with %s before start/update',async(name,tamper)=>{
 const e=engine();const m=await e.api.createMachine(dockerPlan(base));tamper(e.containers[0]);const before=e.calls.length;
 const error=await e.api.listMachines().then(()=>null,error=>error);observations.push({case:name,rejected:error?.code==='PROVISIONING_CONFLICT'});expect(error).toMatchObject({code:'PROVISIONING_CONFLICT'});
 await expect(e.api.start(m.id)).rejects.toMatchObject({code:'PROVISIONING_CONFLICT'});await expect(e.api.update(m.id,{...m.config,image:'reinlab-account:replacement'})).rejects.toMatchObject({code:'PROVISIONING_CONFLICT'});expect(e.calls.slice(before).every(c=>c.method==='GET')).toBe(true);
});
it('rejects a legitimate named volume attached to a foreign container',async()=>{
 const e=engine();await e.api.createVolume(base.volumeId);await e.api.createMachine(dockerPlan(base));const foreign=structuredClone(e.containers[0]);foreign.Id='e'.repeat(64);foreign.Name='/foreign';foreign.Config.Labels={};e.containers.push(foreign);
 await expect(e.api.listVolumes()).rejects.toMatchObject({code:'PROVISIONING_CONFLICT'});expect(e.calls.some(c=>c.method==='DELETE')).toBe(false);observations.push({case:'foreign-volume-attachment',rejected:true,destructiveRequests:0});
});
it('stopped-container restart and image replacement preserve the same named volume',async()=>{
 const e=engine();await e.api.createVolume(base.volumeId);const m=await e.api.createMachine(dockerPlan(base));e.containers[0].State.Running=false;await e.api.start(m.id);expect(e.containers[0].State.Running).toBe(true);
 await e.api.update(m.id,{...m.config,image:'reinlab-account:replacement'});expect(e.volumes).toHaveLength(1);expect(e.containers).toHaveLength(1);expect(e.containers[0].Mounts[0].Name).toBe(base.volumeId);expect(e.calls.filter(c=>c.path==='/volumes/create')).toHaveLength(1);expect(e.calls.filter(c=>c.method==='DELETE').every(c=>c.path.startsWith('/containers/'))).toBe(true);observations.push({case:'named-volume-restart-upgrade',volumeCreates:1,preserved:true});
});
it.each(['invalid-json','oversized-body'])('cleans sensitive Engine response on a temporary Unix socket: %s',async mode=>{
 const dir=await mkdtemp(join(tmpdir(),'reinlab-docker-independent-')),socket=join(dir,'engine.sock');const secret='fixture-engine-secret-never-surface';
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(mode==='invalid-json'?secret:JSON.stringify({data:secret+'x'.repeat(4*1024*1024)}));});
 await new Promise<void>(done=>server.listen(socket,done));try{const api=new DockerMachines('unix://'+socket);const error=await api.listVolumes().then(()=>null,error=>error);expect(error).toMatchObject({code:'PROVISIONER_UNAVAILABLE'});expect(String(error)).not.toContain(secret);expect(JSON.stringify(error)).not.toContain(secret);observations.push({case:mode,errorCode:error.code,secretSurfaced:false});}finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(dir,{recursive:true,force:true});}
});
it.each([['volume',false],['volume',true],['machine',false],['machine',true]] as const)('PG reconciles unknown %s create result with hidden=%s without blindly recreating',async(stage,hidden)=>{
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL??'postgres://postgres@127.0.0.1:55432/reinlab_test'}),pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test'});
 try{const id=randomUUID();await admin.query('insert into account(id) values($1)',[id]);const e=engine(),key=randomBytes(32),vault={async key(){return Buffer.from(key);}},config={app:'reinlab-local',image:base.image,controlUrl:base.controlUrl};const first=new AccountProvisioner(new Database(pool),e.api,vault,config,async()=>true);e.loseResponse(stage);
  const failed=await first.ensure(id).then(()=>null,error=>error);expect(failed).toMatchObject({code:'PROVISIONER_UNAVAILABLE'});expect(String(failed)).not.toContain(base.tokens.auth);expect(String(failed)).not.toContain(base.tokens.container);
  expect((await admin.query('select phase from account_machine where account_id=$1',[id])).rows[0].phase).toBe(stage==='volume'?'volume_creating':'machine_creating');
  if(hidden)(stage==='volume'?e.volumes:e.containers).length=0;
  // A fresh provisioner instance must recover solely from durable DB intent and Engine resources.
  const restarted=new AccountProvisioner(new Database(pool),e.api,vault,config,async()=>true);
  if(hidden){await expect(restarted.ensure(id)).rejects.toMatchObject({code:'PROVISIONING_INDETERMINATE'});await expect(restarted.ensure(id)).rejects.toMatchObject({code:'PROVISIONING_INDETERMINATE'});}else expect((await restarted.ensure(id)).state).toBe('ready');
  const creates=e.calls.filter(c=>stage==='volume'?c.path==='/volumes/create':c.path.startsWith('/containers/create?'));expect(creates).toHaveLength(1);observations.push({case:'unknown-create-replay',stage,hidden,createRequests:1,recovered:!hidden});
 }finally{await pool.end();await admin.end();}
},15000);

it('PG upgrade with a lost replacement response reconciles the same operation and keeps its named volume',async()=>{
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL??'postgres://postgres@127.0.0.1:55432/reinlab_test'}),pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test'});
 try{const id=randomUUID(),operation=randomUUID(),key=randomBytes(32),vault={async key(){return Buffer.from(key);}},e=engine(),db=new Database(pool);await admin.query('insert into account(id) values($1)',[id]);await new AccountProvisioner(db,e.api,vault,{app:'reinlab-local',image:base.image,controlUrl:base.controlUrl},async()=>true).ensure(id);
  const config={app:'reinlab-local',storageUrl:'http://127.0.0.1:54321/',storageToken:'e30.'+Buffer.from(JSON.stringify({role:'reinlab_snapshot_writer'})).toString('base64url')+'.fixture',controlUrl:base.controlUrl};const lifecycle=new AccountLifecycle(db,e.api,vault,config);e.loseResponse('machine');
  await expect(lifecycle.upgrade(id,'reinlab-account:upgraded','wait',operation)).rejects.toMatchObject({code:'PROVISIONING_INDETERMINATE'});expect((await admin.query('select state from account_machine_operation where account_id=$1 and operation_id=$2',[id,operation])).rows[0].state).toBe('indeterminate');
  const recovered=new AccountLifecycle(db,e.api,vault,config);expect(await recovered.upgrade(id,'reinlab-account:upgraded','wait',operation)).toEqual({code:'UPDATE_REQUESTED'});expect((await admin.query('select state from account_machine_operation where account_id=$1 and operation_id=$2',[id,operation])).rows[0].state).toBe('applied');expect(e.calls.filter(c=>c.path.startsWith('/containers/create?'))).toHaveLength(2);expect(e.volumes).toHaveLength(1);expect(e.containers[0].Mounts[0].Name).toBe('rl_'+id.replaceAll('-',''));observations.push({case:'unknown-upgrade-replay',containerCreates:2,volumeCreates:1,operationApplied:true});
 }finally{await pool.end();await admin.end();}
},15000);
