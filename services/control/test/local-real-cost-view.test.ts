import { expect,it } from "vitest";
import { randomBytes,randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { mcpFixture } from "./mcp-fixture";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { materializeHarnessRole } from "../src/harness/materialize";
import { loadToolRegistry } from "../src/harness/manifest";
import { appendEvent } from "../src/ledger";
import { createApp } from "../src/api/app";
it.each([true,false])("failed read retains known charges=%s and never projects unknown-only usage as zero",async known=>{
 const f=await mcpFixture(undefined,false,"1.1.0");
 try{
  await f.admin.query("update run set state='queued' where id=$1",[f.run]);
  const role=materializeHarnessRole(f.effective,await loadToolRegistry(),{dossierId:f.dossier,roleId:"research-read",modelRoutes:{strong:"deepseek/deepseek-v4-flash"},memory:""}),b=await new BindingStore(f.db).prepare(f.account,f.run,{role,message:"fixture"});
  const event=await f.db.withAccount(f.account,c=>appendEvent(c,f.account,{dossierId:f.dossier,runId:f.run,kind:"cost",payload:{fixtureOnly:true},dedupeKey:randomUUID()}));
  await f.admin.query("insert into os_usage(account_id,dossier_id,run_id,session_id,part_id,message_id,source_hash,cost_cny,metadata,event_seq)values($1,$2,$3,$4,'part_fixture','msg_fixture',$5,$6,'{}',$7)",[f.account,f.dossier,f.run,b.sessionId,"a".repeat(64),known?".021596":null,event.seq]);
  await f.admin.query("update run set state='failed',ended_at=now(),spent_cny=0 where id=$1",[f.run]);await f.admin.query("update budget_hold set state='unpriced' where id=$1",[f.hold]);
  const secret=randomBytes(48),issuer="https://cost.fixture/auth/v1",app=await createApp({pool:f.pool,auth:{issuer,secret}}),jwt=await new SignJWT({role:"authenticated"}).setProtectedHeader({alg:"HS256"}).setIssuer(issuer).setAudience("authenticated").setSubject(f.account).setIssuedAt().setExpirationTime("1h").sign(secret);
  const response=await app.request("/v1/dossiers/"+f.dossier+"/read-state",{headers:{authorization:"Bearer "+jwt}});expect(response.status).toBe(200);const data=await response.json() as any;
  expect(data.run.usageUnknown).toBe(true);expect(data.run.spentCny).toBe(known?.021596:null);
 }finally{await f.close();}
});
