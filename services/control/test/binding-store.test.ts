import { beforeAll, afterAll, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Database } from '../src/db/database';
import { applyMigrations } from '../src/db/migrate';
import { BindingStore } from '../src/bridge/openscience/binding-store';
const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL??'postgres://postgres@127.0.0.1:55432/reinlab_test',max:2});
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test',max:3});
const db=new Database(pool),store=new BindingStore(db),account=randomUUID(),foreign=randomUUID(),dossier=randomUUID();
beforeAll(async()=>{await applyMigrations(admin,resolve('infra/supabase/migrations'));await admin.query('insert into account(id) values($1),($2)',[account,foreign]);await admin.query("insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'research','binding','/data/dossiers/'||$1::text)",[dossier,account]);});
afterAll(async()=>{await pool.end();await admin.end();});
async function run(){const id=randomUUID();await admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-read','read',$4,'queued',1,'{}')",[id,account,dossier,randomUUID()]);return id;}
const role={dossierId:dossier,role:{id:'research-read',prompt:'中文研究角色，危险动作一律拒绝。',toolGrants:{},writeTargets:[],steps:1},memory:'',model:'deepseek/deepseek-v4-flash'};
it('binding is durable, immutable, scoped and has one deterministic session per run',async()=>{
 const id=await run();const a=await store.prepare(account,id,{role,message:'最小研究回合'});
 const b=await new BindingStore(db).prepare(account,id,{role,message:'最小研究回合'});expect(b).toEqual(a);expect(a.sessionId).toMatch(/^ses_rl[a-f0-9]{32}$/);expect(a.requestId).toBe((await admin.query('select request_id from run where id=$1',[id])).rows[0].request_id);
 await expect(store.prepare(account,id,{role,message:'不同内容'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 await expect(store.get(foreign,id)).rejects.toMatchObject({status:404});
 await expect(store.prepare(account,id,{role:{...role,dossierId:randomUUID()},message:'最小研究回合'})).rejects.toMatchObject({status:404});
 const r=await admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='os_binding'::regclass");expect(r.rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});
});
it('send intent is a durable fence; restart never claims a second submission',async()=>{
 const id=await run(),binding=await store.prepare(account,id,{role,message:'fence'});const token=await store.claim(account,id);expect(token).toBeTruthy();expect(await store.claim(account,id)).toBeNull();
 await store.baseline(account,id,token!,7);await store.sendIntent(account,id,token!);expect(await new BindingStore(db).claim(account,id)).toBeNull();
 const receipt={runID:'run_original',acceptedAt:123};await store.receipt(account,id,receipt);expect((await store.get(account,id)).receipt).toEqual(receipt);
 await expect(store.receipt(account,id,{...receipt,runID:'run_changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect((await store.get(account,id)).sessionId).toBe(binding.sessionId);
});
it('baseline cannot advance after send intent; stale lease cannot submit',async()=>{
 const id=await run();await store.prepare(account,id,{role,message:'stale'});const token=(await store.claim(account,id))!;
 await expect(store.sendIntent(account,id,token)).rejects.toMatchObject({code:'BINDING_NOT_PREPARED'});
 await store.baseline(account,id,token,0);await admin.query("update os_binding set lease_until=now()-interval '1 second' where run_id=$1",[id]);
 await expect(store.sendIntent(account,id,token)).rejects.toMatchObject({code:'BINDING_LEASE_LOST'});
 const fresh=(await store.claim(account,id))!;await store.baseline(account,id,fresh,1);await store.sendIntent(account,id,fresh);
 await expect(store.baseline(account,id,fresh,99)).rejects.toMatchObject({code:'BINDING_LEASE_LOST'});
});
