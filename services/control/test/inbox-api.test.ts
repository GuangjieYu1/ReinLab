import {appendEvent} from '../src/ledger';
import {it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {mcpFixture} from './mcp-fixture';
import {createApp} from '../src/api/app';

it('Claude适配的被替换条目只在同账户、当前提议实际引用且key/层匹配时返回',async()=>{
 const f=await fixture();try{
  const old=randomUUID(),unlisted=randomUUID();
  await f.admin.query("insert into memory_item(id,account_id,layer,key,value)values($1,$3,'L4','lesson','\"原条目\"'),($2,$3,'L4','private','\"不能任意读\"')",[old,unlisted,f.account]);
  const id=await f.proposal([{key:'lesson',value:'new',evidence:[f.eventRef],supersedes:old} as any]);
  const path='/v1/promotions/'+id+'/superseded/';
  const r=await f.request(path+old);expect(r.status).toBe(200);expect(await r.json()).toEqual({id:old,key:'lesson',value:'原条目'});
  expect((await f.request(path+unlisted)).status).toBe(404);
  expect((await f.request('/v1/promotions/'+randomUUID()+'/superseded/'+old)).status).toBe(404);
  const cross=await f.proposal([{key:'different-key',value:'new',evidence:[f.eventRef],supersedes:old} as any]);expect((await f.request('/v1/promotions/'+cross+'/superseded/'+old)).status).toBe(404);
 }finally{await f.close();}
});
async function fixture(){
 const f=await mcpFixture(),secret=randomBytes(48),issuer='https://inbox.fixture/auth/v1';
 const app=await createApp({pool:f.pool,auth:{issuer,secret}});
 const token=await new SignJWT({role:'authenticated'}).setProtectedHeader({alg:'HS256'}).setIssuer(issuer).setAudience('authenticated').setSubject(f.account).setIssuedAt().setExpirationTime('1h').sign(secret);
 const request=(path:string,body?:unknown,key=randomUUID())=>app.request(path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const event=await f.db.withAccount(f.account,c=>appendEvent(c,f.account,{dossierId:f.dossier,runId:f.run,roleId:'research-read',kind:'message',action:'user_verified',payload:{text:'已人工核对的来源对话'},dedupeKey:randomUUID()}));const eventRef='event:'+event.seq;
 const proposal=async(items=[{key:'lesson',value:'fact',evidence:[eventRef]}],expired=false)=>{const id=randomUUID();await f.admin.query("insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at)values($1,$2,$3,'L4.knowledge',$4,'依据',now()+$5::interval)",[id,f.account,f.run,JSON.stringify(items),expired?'-1 hour':'1 day']);return id;};
 return {...f,app,request,proposal,eventRef};
}
it('上线前L4无写入；四种操作、来源分组与用户决定账本',async()=>{
 const f=await fixture();try{
 for(const decision of ['approve','edit','reject','keep_local']){
 const id=await f.proposal();const list=await f.request('/v1/promotions?state=pending');expect(list.status).toBe(200);expect((await list.json()).items.find((v:any)=>v.id===id)).toMatchObject({source:{bench:'research',dossierId:f.dossier,runId:f.run,roleId:'research-read'}});
 const before=Number((await f.admin.query('select count(*) from memory_item where account_id=$1',[f.account])).rows[0].count);
 const body=decision==='edit'?{decision,items:[{key:'lesson',value:'edited',evidence:[f.eventRef]}]}:{decision};
 const response=await f.request('/v1/promotions/'+id+'/decide',body);expect(response.status).toBe(200);const receipt=await response.json();
 const count=Number((await f.admin.query('select count(*) from memory_item where account_id=$1',[f.account])).rows[0].count);expect(count-before).toBe(decision==='reject'?0:1);
 if(decision!=='reject'){const m=(await f.admin.query('select layer,dossier_id,value from memory_item where id=$1',[receipt.memoryIds[0]])).rows[0];expect(m.layer).toBe(decision==='keep_local'?'L2':'L4');expect(m.dossier_id).toBe(decision==='keep_local'?f.dossier:null);if(decision==='edit')expect(m.value).toBe('edited');}
 expect((await f.admin.query("select count(*) from event where account_id=$1 and action='promotion.decided' and payload->>'promotionId'=$2",[f.account,id])).rows[0].count).toBe('1');
 }
 }finally{await f.close();}
});
it('并发决定单生效、跨幂等键原收据、相反决定冲突与过期/越权/无依据拒绝',async()=>{
 const f=await fixture();try{const id=await f.proposal(),path='/v1/promotions/'+id+'/decide',key=randomUUID();const responses=await Promise.all([f.request(path,{decision:'approve'},key),f.request(path,{decision:'approve'},key)]);expect(responses.map(r=>r.status)).toEqual([200,200]);const receipt=await responses[0].json();expect(await responses[1].json()).toEqual(receipt);expect(await (await f.request(path,{decision:'approve'})).json()).toEqual(receipt);expect((await f.request(path,{decision:'reject'})).status).toBe(409);expect((await f.request(path,{decision:'reject'},key)).status).toBe(409);
 expect((await f.request('/v1/promotions/'+randomUUID()+'/decide',{decision:'approve'})).status).toBe(404);
 const exp=await f.proposal(undefined,true);expect((await f.request('/v1/promotions/'+exp+'/decide',{decision:'approve'})).status).toBe(409);
 const missing=await f.proposal([{key:'bad',value:'x',evidence:[]}]);expect((await f.request('/v1/promotions/'+missing+'/decide',{decision:'approve'})).status).toBe(400);
 expect((await f.admin.query('select count(*) from memory_item where account_id=$1',[f.account])).rows[0].count).toBe('1');
 }finally{await f.close();}
});
it('supersedes不得跨档案/层/账户；失败事务没有半写记忆',async()=>{
 const f=await fixture();try{const old=randomUUID();await f.admin.query("insert into memory_item(id,account_id,layer,dossier_id,key,value)values($1,$2,'L2',$3,'lesson','{}')",[old,f.account,f.dossier]);const id=await f.proposal([{key:'lesson',value:'new',evidence:[f.eventRef],supersedes:old} as any]);expect((await f.request('/v1/promotions/'+id+'/decide',{decision:'approve'})).status).toBe(409);
 const id2=await f.proposal();await f.admin.query(`create function inbox_fail_${id2.replaceAll('-','')}() returns trigger language plpgsql as $$begin if new.account_id='${f.account}' and new.action='promotion.decided' then raise exception 'fixture rollback';end if;return new;end$$; create trigger inbox_fail_${id2.replaceAll('-','')} before insert on event for each row execute function inbox_fail_${id2.replaceAll('-','')}()`);
 try{expect((await f.request('/v1/promotions/'+id2+'/decide',{decision:'approve'})).status).toBe(500);expect((await f.admin.query('select status from promotion where id=$1',[id2])).rows[0].status).toBe('pending');expect((await f.admin.query('select count(*) from memory_item where account_id=$1',[f.account])).rows[0].count).toBe('1');}finally{await f.admin.query('drop trigger inbox_fail_'+id2.replaceAll('-','')+' on event; drop function inbox_fail_'+id2.replaceAll('-','')+'()');}
 }finally{await f.close();}
});
it('审批卡单次决定与门禁旧review快照拒绝，不产生永久授权',async()=>{
 const f=await fixture();try{
 const card=async(effects:unknown)=>{const id=randomUUID();await f.admin.query("insert into approval(id,account_id,run_id,kind,title,effects,risk)values($1,$2,$3,'permission','需批准',$4,'write')",[id,f.account,f.run,JSON.stringify(effects)]);return id;};
 const id=await card({operation:'approval.request',subject:'一次动作'}),path='/v1/approvals/'+id+'/decide';
 expect((await f.request('/v1/approvals')).status).toBe(200);expect((await f.request(path,{decision:'approve',scope:'session'})).status).toBe(400);
 const first=await f.request(path,{decision:'approve'});expect(first.status).toBe(200);expect(await(await f.request(path,{decision:'approve'})).json()).toEqual(await first.json());expect((await f.request(path,{decision:'reject'})).status).toBe(409);
 const gate=randomUUID(),artifact=randomUUID();await f.admin.query("insert into artifact(id,account_id,dossier_id,kind,path,sha256)values($1,$2,$3,'plan','plans/review.md',$4)",[artifact,f.account,f.dossier,'a'.repeat(64)]);
 await f.admin.query("insert into gate(id,account_id,dossier_id,subject,state,revision,review_artifact_id)values($1,$2,$3,'审核','review',2,$4)",[gate,f.account,f.dossier,artifact]);
 const stale=await card({operation:'gate.request_open',gateId:gate,gateSnapshot:{gateId:gate,state:'review',revision:1,artifactId:artifact}});expect((await f.request('/v1/approvals/'+stale+'/decide',{decision:'approve'})).status).toBe(409);
 const valid=await card({operation:'gate.request_open',gateId:gate,gateSnapshot:{gateId:gate,state:'review',revision:2,artifactId:artifact}});expect((await f.request('/v1/approvals/'+valid+'/decide',{decision:'approve'})).status).toBe(200);expect((await f.admin.query('select state from gate where id=$1',[gate])).rows[0].state).toBe('approved');
 }finally{await f.close();}
});

it('eventRef必须真实且绑定提议来源运行，证据可回看原对话、未知与旧字符串拒绝',async()=>{
 const f=await fixture();try{
 const id=await f.proposal();const evidence=await f.request('/v1/promotions/'+id+'/evidence');expect(evidence.status).toBe(200);expect((await evidence.json()).items).toContainEqual(expect.objectContaining({ref:f.eventRef,event:expect.objectContaining({payload:{text:'已人工核对的来源对话'}})}));
 const source=await f.request('/v1/promotions/'+id+'/evidence/'+f.eventRef.slice(6));expect(source.status).toBe(200);
 for(const ref of ['run:'+f.run,'event:9007199254740992','event:999999999999']){const invalid=await f.proposal([{key:'bad',value:'x',evidence:[ref]}]);expect((await f.request('/v1/promotions/'+invalid+'/decide',{decision:'approve'})).status).toBe(409);}
 const otherRun=randomUUID();await f.admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny)values($1,$2,$3,'research-read','read',$4,'running',1)",[otherRun,f.account,f.dossier,randomUUID()]);
 const otherEvent=await f.db.withAccount(f.account,c=>appendEvent(c,f.account,{dossierId:f.dossier,runId:otherRun,kind:'message',payload:{text:'另一运行'},dedupeKey:randomUUID()}));const wrong=await f.proposal([{key:'bad',value:'x',evidence:['event:'+otherEvent.seq]}]);expect((await f.request('/v1/promotions/'+wrong+'/decide',{decision:'approve'})).status).toBe(409);expect((await f.request('/v1/promotions/'+id+'/evidence/'+otherEvent.seq)).status).toBe(404);
 }finally{await f.close();}
});
