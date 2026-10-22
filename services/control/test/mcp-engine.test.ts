import { it,expect } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilityEngine } from "../src/mcp/engine";
import { implementedCatalog,mcpFixture } from "./mcp-fixture";
it("T-MCP-2/3/8 direct client is checked, once approval binds parameters, concurrent writes execute once",async()=>{
 const f=await mcpFixture(await implementedCatalog());
 try{
  const a=new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync("ed25519").privateKey));
  const token=await a.issue(f.account,f.run);let effects=0;
  const e=new CapabilityEngine(a,{"files.write":async()=>({versionId:randomUUID(),count:++effects})});
  const req={capability:"files.write",args:{path:"findings/a.md",content:"approved content"},requestId:randomUUID()};
  const pending=await e.call("files",token,req).catch(error=>error);
  expect(pending.code).toBe("APPROVAL_REQUIRED");expect(effects).toBe(0);
  await expect(e.decide(randomUUID(),pending.approvalId,"approve")).rejects.toMatchObject({code:"APPROVAL_INVALID"});
  await expect(e.call("files",token,{...req,approvalId:pending.approvalId})).rejects.toMatchObject({code:"APPROVAL_INVALID"});
  await e.decide(f.account,pending.approvalId,"approve");
  await expect(e.call("files",token,{...req,args:{...req.args,content:"changed"},approvalId:pending.approvalId})).rejects.toMatchObject({code:"APPROVAL_PARAMETERS_CHANGED"});
  const accepted={...req,approvalId:pending.approvalId};
  const first=await e.call("files",token,accepted);
  expect(effects).toBe(1);expect(await e.call("files",token,accepted)).toEqual(first);expect(effects).toBe(1);
  await expect(e.call("files",token,{...accepted,args:{...req.args,content:"changed"}})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  await expect(e.call("files",token,{...accepted,requestId:randomUUID()})).rejects.toMatchObject({code:"APPROVAL_INVALID"});
  await expect(e.call("files",token,{capability:"files.undo",args:{versionId:randomUUID()},requestId:randomUUID()})).rejects.toMatchObject({code:"CAPABILITY_DENIED"});
  const states=(await f.admin.query("select consumed,decision from mcp_approval where id=$1",[pending.approvalId])).rows[0];
  expect(states).toEqual({consumed:true,decision:"approve"});
  expect((await f.admin.query("select count(*)::int n from event where run_id=$1 and action='capability.call'",[f.run])).rows[0].n).toBe(2);
  expect((await f.admin.query("select count(*)::int n from event where run_id=$1 and action='capability.denied'",[f.run])).rows[0].n).toBeGreaterThan(3);
 }finally{await f.close();}
});
it("T-MCP-1 invalid unauthenticated clients get anonymous refusal audit without victim tenant pollution",async()=>{
 const f=await mcpFixture();
 try{
  const e=new CapabilityEngine(new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync("ed25519").privateKey)),{});
  const before=(await f.admin.query("select count(*)::int n from mcp_anonymous_denial")).rows[0].n;
  await expect(e.call("cards",undefined,{capability:"cards.card.finding",args:{}})).rejects.toMatchObject({code:"CAPABILITY_TOKEN_INVALID"});
  expect((await f.admin.query("select count(*)::int n from mcp_anonymous_denial")).rows[0].n).toBe(before+1);
  expect((await f.admin.query("select count(*)::int n from event where run_id=$1",[f.run])).rows[0].n).toBe(0);
 }finally{await f.close();}
});
