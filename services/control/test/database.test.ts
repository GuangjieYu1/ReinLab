import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyMigrations } from '../src/db/migrate';

const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55432/reinlab_test', max: 4 });
const app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_APP ?? 'postgres://reinlab_app@127.0.0.1:55432/reinlab_test', max: 4 });
const A = randomUUID(), B = randomUUID(), DA = randomUUID(), DB = randomUUID(), RA = randomUUID(), RB = randomUUID();
const tables = ['account','dossier','role_def','run','event','approval','paper_asset','paper_page_read','dsh_session','dsh_turn','usage_record','budget_allocation','budget_hold','budget_estimate','card_decision','http_request'];
const seeded = ['account','dossier','run','event','approval'];
const fields: Record<string,string> = { account:'display_name',dossier:'title',run:'state',event:'payload',approval:'title',paper_asset:'status',paper_page_read:'page',dsh_session:'state',dsh_turn:'state',usage_record:'provider',budget_allocation:'period',budget_hold:'state',budget_estimate:'model',card_decision:'request_hash',http_request:'status' };
async function as<T>(account: string | undefined, fn: (client: pg.PoolClient) => Promise<T>) {
  const c = await app.connect();
  try { await c.query('begin'); if (account) await c.query("select set_config('app.account_id',$1,true)",[account]); return await fn(c); }
  finally { await c.query('rollback'); c.release(); }
}
beforeAll(async () => {
  await applyMigrations(admin,path.resolve('infra/supabase/migrations'));
  await admin.query('insert into account(id) values ($1),($2)',[A,B]);
  await admin.query("insert into dossier(id,account_id,bench,title,workspace_path) values ($1,$2,'research','A','/data/dossiers/A'),($3,$4,'research','B','/data/dossiers/B')",[DA,A,DB,B]);
  await admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values ($1,$2,$3,'research-read','read',$7,'queued',5),($4,$5,$6,'research-read','read',$8,'queued',5)",[RA,A,DA,RB,B,DB,`request:${RA}`,`request:${RB}`]);
  for (const [account, dossier, run] of [[A,DA,RA],[B,DB,RB]]) {
    await admin.query("insert into event(account_id,dossier_id,run_id,kind) values($1,$2,$3,'message')",[account,dossier,run]);
    await admin.query("insert into approval(account_id,run_id,kind,title,effects,risk) values($1,$2,'permission','允许读取','[]','read')",[account,run]);
  }
},30000);
afterAll(async()=>{await app.end();await admin.end();});
describe('真实数据库 RLS',()=>{
  it('已应用迁移不重放',async()=>expect(await applyMigrations(admin,path.resolve('infra/supabase/migrations'))).toEqual([]));
  it('拒绝已应用迁移被改写，且释放迁移锁',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'reinlab-migration-'));
    try { await writeFile(path.join(dir,'202610190001_foundation.sql'),'select 1');await expect(applyMigrations(admin,dir)).rejects.toThrow('MIGRATION_CHANGED'); }
    finally { await rm(dir,{recursive:true,force:true}); }
    expect(await applyMigrations(admin,path.resolve('infra/supabase/migrations'))).toEqual([]);
  });
  it('应用角色无超级权限、非表所有者',async()=>{const r=await app.query("select rolsuper,rolbypassrls,rolcreaterole,rolcreatedb from pg_roles where rolname=current_user");expect(r.rows[0]).toEqual({rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false});expect((await app.query("select count(*)::int n from pg_tables where schemaname='public' and tableowner=current_user")).rows[0].n).toBe(0);});
  it.each(tables)('%s 启用并强制RLS',async table=>{const r=await admin.query('select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass',[table]);expect(r.rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});});
  it.each(seeded)('A在%s中只能看到A',async table=>{await as(A,async c=>{const column=table==='account'?'id':'account_id';const r=await c.query(`select ${column} owner from ${table}`);expect(r.rows.length).toBeGreaterThan(0);expect(r.rows.every(row=>row.owner===A)).toBe(true);expect((await c.query(`select * from ${table} where ${column}=$1`,[B])).rowCount).toBe(0);});});
  it.each(tables.filter(t=>t!=='role_def'))('无账户在%s中默认0行',async table=>{await as(undefined,async c=>expect((await c.query(`select * from ${table}`)).rowCount).toBe(0));});
  it.each(seeded.filter(t=>!['role_def','event'].includes(t)))('A不能更新%s的B行',async table=>{const owner=table==='account'?'id':'account_id',field=fields[table];expect((await as(A,c=>c.query(`update ${table} set ${field}=${field} where ${owner}=$1`,[B]))).rowCount).toBe(0);});
  it.each(tables)('应用不能删除%s',async table=>{await expect(as(A,c=>c.query(`delete from ${table}`))).rejects.toMatchObject({code:'42501'});});
  it.each([
    ["insert into account(id) values($1)",[randomUUID()]],
    ["insert into run(account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,'research-read','read','spoof','queued',5)",[B,DB]],
    ["insert into event(account_id,dossier_id,kind) values($1,$2,'message')",[B,DB]],
    ["insert into approval(account_id,run_id,kind,title,effects,risk) values($1,$2,'permission','x','[]','read')",[B,RB]],
  ])('拒绝伪造account_id写入 %#',async(sql,values)=>{await expect(as(A,c=>c.query(sql,values))).rejects.toMatchObject({code:'42501'});});
  it('不能插入另一个账户的档案',async()=>{await expect(as(A,c=>c.query("insert into dossier(account_id,bench,title,workspace_path) values($1,'research','escape','escape')",[B]))).rejects.toMatchObject({code:'42501'});});
  it('账本不能关联到其他档案的运行',async()=>{await expect(as(A,c=>c.query("insert into event(account_id,dossier_id,run_id,kind) values($1,$2,$3,'message')",[A,DA,RB]))).rejects.toMatchObject({code:'23503'});});
  it.each(['update event set payload=payload','delete from event','truncate event'])('账本只追加：%s',async sql=>{await expect(as(A,c=>c.query(sql))).rejects.toMatchObject({code:'42501'});});
  it('角色种子全局可读、不能写',async()=>{expect((await as(A,c=>c.query('select * from role_def'))).rowCount).toBeGreaterThanOrEqual(10);await expect(as(A,c=>c.query("update role_def set steps=100"))).rejects.toMatchObject({code:'42501'});});
  it('角色模板无danger授权且提示词存在',async()=>{const roles=await admin.query('select * from role_def');for(const role of roles.rows){expect(Object.values(role.tool_grants).every((grant: unknown)=>typeof grant==='object' && grant!==null && 'risk' in grant && grant.risk!=='danger')).toBe(true);await expect((await import('node:fs/promises')).readFile(path.join('services/control',role.prompt_ref),'utf8')).resolves.toContain('危险动作一律拒绝');}});
  it('事务结束后上下文不可复用',async()=>{await as(A,c=>c.query('select * from dossier'));await as(B,async c=>expect((await c.query('select * from dossier where id=$1',[DA])).rowCount).toBe(0));await as(undefined,async c=>expect((await c.query('select * from dossier')).rowCount).toBe(0));});
});
