import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { SignJWT } from 'jose';
import { spawn } from 'node:child_process';
import { AccountProfile, Dossier, DossierDetail } from '@reinlab/contracts';
import { createApp } from '../src/api/app';
import { applyMigrations } from '../src/db/migrate';
import { assertApplicationRole } from '../src/db/database';
import { scrub } from '../src/ledger';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writePrivateEnv } from '../../../tooling/local/config';

const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL??'postgres://postgres@127.0.0.1:55432/reinlab_test'});
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test',max:4});
const secret=randomBytes(48),issuer='http://127.0.0.1/reinlab/auth/v1',A=randomUUID(),B=randomUUID();
let app: Awaited<ReturnType<typeof createApp>>,ta:string,tb:string;
async function token(sub=A,changes:Record<string,unknown>={},key:Uint8Array=secret){return new SignJWT({role:'authenticated',...changes}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setSubject(sub).setIssuer(issuer).setAudience('authenticated').setIssuedAt().setExpirationTime('1h').sign(key);}
function headers(jwt=ta,key?:string){return {'Authorization':`Bearer ${jwt}`,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})};}
async function create(title:string,jwt=ta,key=randomUUID()){return app.request('/v1/dossiers',{method:'POST',headers:headers(jwt,key),body:JSON.stringify({title})});}
beforeAll(async()=>{await applyMigrations(admin,path.resolve('infra/supabase/migrations'));await admin.query('insert into account(id,display_name) values($1,\'A\'),($2,\'B\')',[A,B]);ta=await token();tb=await token(B);app=await createApp({pool,auth:{issuer,secret}});},30000);
afterAll(async()=>{await pool.end();await admin.end();});
describe('控制面 API',()=>{
  it('缺JWT被拒且错误中文可读',async()=>{const r=await app.request('/v1/me');expect(r.status).toBe(401);const b=await r.json();expect(b.code).toBe('AUTH_REQUIRED');expect(b.message).toMatch(/[\u4e00-\u9fff]/);});
  it('账户响应符合共享契约',async()=>expect(AccountProfile.safeParse(await(await app.request('/v1/me',{headers:headers()})).json()).success).toBe(true));
  it('已验签但未注册账户不可写入',async()=>{const r=await create('未注册',await token(randomUUID()));expect(r.status).toBe(404);expect((await r.json()).code).toBe('ACCOUNT_NOT_READY');});
  it('无效JWT格式和无效账户subject被拒',async()=>{expect((await app.request('/v1/me',{headers:{Authorization:'Basic nope'}})).status).toBe(401);expect((await app.request('/v1/me',{headers:headers(await token('not-a-uuid'))})).status).toBe(401);});
  it('JWT配置缺失或弱密钥拒绝启动',async()=>{await expect(createApp({pool,auth:{issuer:'',secret}})).rejects.toThrow('AUTH_CONFIG_INVALID');await expect(createApp({pool,auth:{issuer,secret:new Uint8Array(4)}})).rejects.toThrow('AUTH_CONFIG_INVALID');});
  it('错签名被拒',async()=>expect((await app.request('/v1/me',{headers:headers(await token(A,{},randomBytes(48)))})).status).toBe(401));
  it('拒绝过期JWT',async()=>{const jwt=await new SignJWT({role:'authenticated'}).setProtectedHeader({alg:'HS256'}).setSubject(A).setIssuer(issuer).setAudience('authenticated').setIssuedAt(1).setExpirationTime(2).sign(secret);expect((await app.request('/v1/me',{headers:headers(jwt)})).status).toBe(401);});
  it.each([{role:'service_role'},{role:'anon'},{role:''}])('拒绝非用户角色 %#',async claims=>expect((await app.request('/v1/me',{headers:headers(await token(A,claims))})).status).toBe(401));
  it('仅sub确定账户',async()=>{const r=await app.request('/v1/me',{headers:headers(await token(A,{account_id:B,user_metadata:{account_id:B}}))});expect(r.status).toBe(200);expect((await r.json()).id).toBe(A);});
  it('错误issuer/audience拒绝',async()=>{for(const [iss,aud]of[[issuer+'/other','authenticated'],[issuer,'other']]){const jwt=await new SignJWT({role:'authenticated'}).setProtectedHeader({alg:'HS256'}).setSubject(A).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('1h').sign(secret);expect((await app.request('/v1/me',{headers:headers(jwt)})).status).toBe(401);}});
  it('禁止管理员连接启动应用',async()=>{await expect(createApp({pool:admin,auth:{issuer,secret}})).rejects.toThrow('UNSAFE_DATABASE_ROLE');});
  it.each(['INHERIT','NOINHERIT'])('拒绝经成员关系取得owner权限 %s',async inheritance=>{
    const suffix=randomUUID().replaceAll('-',''),owner='guard_owner_'+suffix,derived='guard_app_'+suffix,table='guard_table_'+suffix,client=await admin.connect();
    try {
      await client.query('begin');
      await client.query(`create role ${owner} nologin nosuperuser nobypassrls nocreaterole nocreatedb; create role ${derived} nologin nosuperuser nobypassrls nocreaterole nocreatedb ${inheritance}; grant ${owner} to ${derived}; create table ${table}(id integer); alter table ${table} enable row level security; alter table ${table} force row level security; alter table ${table} owner to ${owner}; set local role ${derived};`);
      await expect(assertApplicationRole(client)).rejects.toThrow('UNSAFE_DATABASE_ROLE');
    }finally{await client.query('rollback');client.release();}
  });
  it('写请求必须带幂等键',async()=>expect((await app.request('/v1/dossiers',{method:'POST',headers:headers(),body:'{"title":"研究"}'})).status).toBe(400));
  it('创建、读取、跨租户拒绝',async()=>{const r=await create('租户隔离');expect(r.status).toBe(201);const d=await r.json();expect(d.title).toBe('租户隔离');expect(d.workspacePath).toBeUndefined();expect((await app.request(`/v1/dossiers/${d.id}`,{headers:headers()})).status).toBe(200);const denied=await app.request(`/v1/dossiers/${d.id}`,{headers:headers(tb)});expect([403,404]).toContain(denied.status);expect(JSON.stringify(await denied.json())).not.toContain('租户隔离');});
  it('列表只返回本人档案',async()=>{const d=await(await create('B独有档案',tb)).json();const list=await(await app.request('/v1/dossiers',{headers:headers()})).json();expect(list.items.some((x:{id:string})=>x.id===d.id)).toBe(false);});
  it('客户端不能注入accountId/path',async()=>{const r=await app.request('/v1/dossiers',{method:'POST',headers:headers(ta,randomUUID()),body:JSON.stringify({title:'注入',accountId:B,workspacePath:'/etc'})});expect(r.status).toBe(400);});
  it('同键相同内容只创建一次',async()=>{const key=randomUUID();const x=await create('幂等档案',ta,key),y=await create('幂等档案',ta,key);expect(await y.json()).toEqual(await x.json());expect(y.status).toBe(201);});
  it('同键异内容409',async()=>{const key=randomUUID();await create('第一份',ta,key);const r=await create('第二份',ta,key);expect(r.status).toBe(409);expect((await r.json()).code).toBe('IDEMPOTENCY_CONFLICT');});
  it('四路并发只创建一次',async()=>{const key=randomUUID();const responses=await Promise.all(Array.from({length:4},()=>create('并发档案',ta,key)));expect(responses.every(r=>r.status===201)).toBe(true);const data=await Promise.all(responses.map(r=>r.json()));expect(new Set(data.map(x=>x.id)).size).toBe(1);});
  it('重建进程对象仍返回原收据',async()=>{const key=randomUUID(),first=await(await create('恢复幂等',ta,key)).json();const second=await createApp({pool,auth:{issuer,secret}});const r=await second.request('/v1/dossiers',{method:'POST',headers:headers(ta,key),body:'{"title":"恢复幂等"}'});expect(await r.json()).toEqual(first);});
  it('同键不同账户互不冲突',async()=>{const key=randomUUID();const a=await(await create('A键',ta,key)).json(),b=await(await create('B键',tb,key)).json();expect(a.id).not.toBe(b.id);});
  it('同键JSON字段顺序和默认值归一化',async()=>{const key=randomUUID();const first=await(await create('归一化',ta,key)).json();const second=await app.request('/v1/dossiers',{method:'POST',headers:headers(ta,key),body:'{"bench":"research","title":"归一化"}'});expect(await second.json()).toEqual(first);});
  it('有效档案与详情符合共享契约',async()=>{const d=await(await create('契约档案')).json();expect(Dossier.safeParse(d).success).toBe(true);const detail=await(await app.request('/v1/dossiers/'+d.id,{headers:headers()})).json();// 第 4 项契约（§2）起，详情返回的就是 Dossier 本身。
 expect(Dossier.safeParse(detail).success).toBe(true);});
  it('成果列表包含论文、讲解层、发现卡和课程，论文带出处',async()=>{
    const d=await(await create('成果档案')).json(),runId=randomUUID(),assetId=randomUUID();
    await admin.query(`insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'running',1,'{}')`,[runId,A,d.id,randomUUID()]);
    await admin.query(`insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,license,status,is_open_access,sha256,path,abstract,view_metadata)
      values($1,$2,$3,$4,'arxiv:2302.04761','https://arxiv.org/pdf/2302.04761',null,'full_text',true,$5,'papers/x.pdf','','{"title":"Toolformer","doi":"10.1000/xyz"}')`,
      [assetId,A,d.id,runId,'a'.repeat(64)]);
    for(const [cardId,cardType,card] of [['c-layer','layer',{title:'第 1 层：动机'}],['c-find','finding',{text:'发现：这一步可以省掉'}]])
      await admin.query(`insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key) values($1,$2,$3,'card','card_created',$4,$5)`,
        [A,d.id,runId,JSON.stringify({cardId,cardType,card}),'test-card:'+cardId]);
    await admin.query(`insert into dossier_artifact(account_id,dossier_id,kind,title) values($1,$2,'course','课程 A')`,[A,d.id]);
    const items=(await(await app.request(`/v1/dossiers/${d.id}/artifacts`,{headers:headers()})).json()).items;
    expect(items.map((x:any)=>x.kind).sort()).toEqual(['course','finding','layer','paper']);
    const paper=items.find((x:any)=>x.kind==='paper');
    expect(paper.title).toBe('Toolformer');
    expect(paper.provenance).toEqual({source:'https://arxiv.org/pdf/2302.04761',doi:'10.1000/xyz'});
    expect(paper.open).toMatchObject({to:'dossier',dossierId:d.id});
    expect(items.find((x:any)=>x.kind==='layer').title).toBe('第 1 层：动机');
    const only=(await(await app.request(`/v1/dossiers/${d.id}/artifacts?kind=paper`,{headers:headers()})).json()).items;
    expect(only.map((x:any)=>x.kind)).toEqual(['paper']);
  });
  it.each(['invalid','------------------------------------'])('畸形档案ID返回404 %s',async id=>expect((await app.request('/v1/dossiers/'+id,{headers:headers()})).status).toBe(404));
  it('正文超限拒绝',async()=>expect((await app.request('/v1/dossiers',{method:'POST',headers:headers(ta,randomUUID()),body:JSON.stringify({title:'x'.repeat(1024*1024)})})).status).toBe(413));
  it.each([' ','a'.repeat(201),'é'])('拒绝畸形幂等键 %#',async key=>expect((await create('键校验',ta,key)).status).toBe(400));
  it('数据库故障错误不暴露底层信息',async()=>{
    const transient=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test'});
    const service=await createApp({pool:transient,auth:{issuer,secret}});await transient.end();
    const r=await service.request('/v1/me',{headers:headers()});expect(r.status).toBe(500);const b=await r.json();expect(b.code).toBe('INTERNAL_ERROR');expect(JSON.stringify(b)).not.toMatch(/postgres|stack|Bearer|password/);
  });
  it('收据写入故障使业务写入整体回滚，修复后同键可重试',async()=>{
    const suffix=randomUUID().replaceAll('-',''),name='reinlab_fault_'+suffix,title='tx-fail-'+suffix,key=randomUUID();
    await admin.query(`create function ${name}() returns trigger language plpgsql as $$ begin if NEW.account_id='${A}'::uuid and NEW.response->>'title'='${title}' then raise exception 'injected receipt failure'; end if; return NEW; end $$; create trigger ${name} before insert on http_request for each row execute function ${name}();`);
    try {
      expect((await create(title,ta,key)).status).toBe(500);
      expect((await admin.query('select count(*)::int n from dossier where account_id=$1 and title=$2',[A,title])).rows[0].n).toBe(0);
    } finally {await admin.query(`drop trigger ${name} on http_request; drop function ${name}();`);}
    expect((await create(title,ta,key)).status).toBe(201);
  });
  it('拒绝畸形JSON',async()=>expect((await app.request('/v1/dossiers',{method:'POST',headers:headers(ta,randomUUID()),body:'{'})).status).toBe(400));
  it('拒绝所有危险删除及未验证internal',async()=>{expect((await app.request('/v1/dossiers/'+randomUUID(),{method:'DELETE',headers:headers()})).status).toBe(403);expect((await app.request('/internal/os/tool-call',{method:'POST',headers:{'X-Container-Secret':'untrusted'},body:'{}'})).status).toBe(403);});
  it('幂等元数据受RLS保护且键只存哈希',async()=>{const c=await pool.connect();try{await c.query('begin');await c.query("select set_config('app.account_id',$1,true)",[A]);expect((await c.query('select * from http_request where account_id=$1',[B])).rowCount).toBe(0);const rows=await c.query('select key_hash from http_request');expect(rows.rows.every(r=>/^[a-f0-9]{64}$/.test(r.key_hash))).toBe(true);}finally{await c.query('rollback');c.release();}});
  it('Node22真实HTTP入口验签与优雅退出',async()=>{
    const envSecret=randomBytes(48).toString('base64url'),applicationName='reinlab_native_'+randomUUID().replaceAll('-','');
    const dbUrl=new URL(process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test');dbUrl.searchParams.set('application_name',applicationName);
    const jwt=await token(A,{},new TextEncoder().encode(envSecret));
    const privateRoot=await realpath(await mkdtemp(path.join(tmpdir(),'reinlab-control-config-'))),configFile=path.join(privateRoot,'runtime.env');
    await writePrivateEnv(configFile,{PORT:'0',DATABASE_URL_APP:dbUrl.toString(),SUPABASE_URL:issuer.replace(/\/auth\/v1$/,''),SUPABASE_JWT_SECRET:envSecret,REINLAB_MCP_SIGNING_KEY_FILE:path.join(privateRoot,'mcp','signing.pem')});
    const child=spawn(process.execPath,['--import','tsx','--import','./services/control/test/fixtures/config-environment-audit.ts','services/control/src/main.ts'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',REINLAB_RUNTIME_CONFIG_FILE:configFile},stdio:['ignore','pipe','pipe']});
    let stderr='',phase='startup';
    const sanitizeStderr=(text:string)=>String(scrub(text.split(envSecret).join('[REDACTED]').split(jwt).join('[REDACTED]').split(dbUrl.toString()).join('[REDACTED_DB]')));
    child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-24000);});
    try {
      const port=await new Promise<number>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('CONTROL_START_TIMEOUT')),10000);
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('CONTROL_EARLY_EXIT'));});
        child.stdout.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')){try{const value=JSON.parse(line);if(value.code==='CONTROL_READY'){clearTimeout(timer);resolve(value.port);}}catch{}}});
      });
      phase='initial-request';
      const r=await fetch(`http://127.0.0.1:${port}/v1/me`,{headers:headers(jwt)});
      expect(r.status).toBe(200);expect((await r.json()).id).toBe(A);
      const terminated=await admin.query("select pg_terminate_backend(pid) stopped from pg_stat_activity where application_name=$1 and usename='reinlab_app' and state='idle'",[applicationName]);
      expect(terminated.rowCount).toBeGreaterThan(0);expect(terminated.rows.every(row=>row.stopped)).toBe(true);
      phase='immediate-idle-recovery';
      const recovered=await fetch(`http://127.0.0.1:${port}/v1/me`,{headers:headers(jwt)});expect(recovered.status).toBe(200);expect((await recovered.json()).id).toBe(A);
    } catch(error) {
      console.error(JSON.stringify({code:'CONTROL_NATIVE_TEST_FAILED',phase,stderr:sanitizeStderr(stderr).slice(-12000),exitCode:child.exitCode,signal:child.signalCode}));
      throw error;
    } finally { if(child.exitCode===null&&child.signalCode===null){const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await exit;} await rm(privateRoot,{recursive:true,force:true}); }
  },15000);
  it('已借出连接异步断开不会杀进程，坏连接被丢弃并可恢复',async()=>{
    const child=spawn(process.execPath,['--import','tsx','services/control/test/fixtures/connection-recovery.ts'],{env:{...process.env,TEST_ACCOUNT_ID:A},stdio:['pipe','pipe','pipe']});
    let recovered=false,observed=false;
    try {
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('RECOVERY_TEST_TIMEOUT')),10000);
        child.once('exit',code=>{clearTimeout(timer);if(code===0&&recovered&&observed)resolve();else reject(new Error('RECOVERY_CHILD_FAILED'));});
        child.stderr.on('data',chunk=>{if(String(chunk).includes('DATABASE_CONNECTION_ERROR')){observed=true;child.stdin.write('continue\n');}});
        child.stdout.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')){let value;try{value=JSON.parse(line);}catch{continue;}if(value.code==='BORROWED'){void admin.query('select pg_terminate_backend($1)',[value.pid]).catch(reject);}if(value.code==='RECOVERED'){recovered=value.account===A;}}});
      });
      expect(recovered&&observed).toBe(true);
    }finally{if(child.exitCode===null&&child.signalCode===null){const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await exit;}}
  },15000);
});
