import {it,expect} from "vitest";
import {generateKeyPairSync,randomUUID} from "node:crypto";
import {CapabilitySigner,hash} from "../src/mcp/token";
import {CapabilityAuthority} from "../src/mcp/authority";
import {dataHandlers} from "../src/mcp/data-handlers";
import {implementedCatalog,mcpFixture} from "./mcp-fixture";
it("T-MCP-5 Q060 scopes exclude other dossiers, threads, revoked/superseded entries; propose never mutates memory",async()=>{
 const f=await mcpFixture(await implementedCatalog());
 try{
  const a=new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync("ed25519").privateKey)),token=await a.issue(f.account,f.run),context=await a.validate(token),h=dataHandlers(f.db);
  const visible=randomUUID(),hidden=randomUUID();
  await f.admin.query("insert into memory_item(id,account_id,layer,dossier_id,key,value) values($1,$2,'L2',$3,'visible','\"visible\"'),($4,$2,'L3',$3,'wrongscope','\"hidden\"')",[visible,f.account,f.dossier,hidden]);
  expect((await h["memory.read"](context,{},randomUUID())).items).toEqual([expect.objectContaining({id:visible})]);
  await expect(h["memory.read"](context,{layers:["L1"]},randomUUID())).rejects.toThrow();
  const restricted=structuredClone(context);restricted.scope.memory.refs=[];
  expect((await h["memory.read"](restricted,{},randomUUID())).items).toEqual([]);
  await expect(h["memory.read"](restricted,{refs:[visible]},randomUUID())).rejects.toMatchObject({code:"MEMORY_SCOPE_DENIED"});
  const before=(await f.admin.query("select * from memory_item where account_id=$1 order by id",[f.account])).rows;
  const proposal=await h["memory.propose"](context,{targetLayer:"L4",key:"idea",value:{text:"new"},evidence:[]},randomUUID());
  expect(proposal.status).toBe("pending");
  expect((await f.admin.query("select * from memory_item where account_id=$1 order by id",[f.account])).rows).toEqual(before);
  expect((await f.admin.query("select status,target_layer from promotion where id=$1",[proposal.promotionId])).rows[0]).toEqual({status:"pending",target_layer:"L4.knowledge"});
  await f.admin.query("update memory_item set revoked_at=now() where id=$1",[visible]);
  expect((await h["memory.read"](context,{},randomUUID())).items).toEqual([]);
 }finally{await f.close();}
});
it("T-MCP-6 original research cannot emit undeclared cards; gate request leaves gate locked",async()=>{
 const f=await mcpFixture(await implementedCatalog());
 try{
  const a=new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync("ed25519").privateKey)),context=await a.validate(await a.issue(f.account,f.run)),h=dataHandlers(f.db),gate=randomUUID();
  await expect(h["cards.card.finding"](context,{card:{kind:"finding"}},randomUUID())).rejects.toMatchObject({code:"UNDECLARED_CARD"});
  await f.admin.query("insert into gate(id,account_id,dossier_id,subject,state) values($1,$2,$3,'mcp','locked')",[gate,f.account,f.dossier]);
  expect(await h["cards.gate.request_open"](context,{gateId:gate},randomUUID())).toMatchObject({state:"pending"});
  expect((await f.admin.query("select state from gate where id=$1",[gate])).rows[0].state).toBe("locked");
  await expect(h["cards.gate.request_open"](context,{gateId:randomUUID()},randomUUID())).rejects.toMatchObject({code:"GATE_SCOPE_DENIED"});
 }finally{await f.close();}
});

it("T-MCP-6 frozen manifest card schema is enforced before emitting an event",async()=>{
 const f=await mcpFixture(await implementedCatalog(),true);
 try{
  const a=new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync("ed25519").privateKey)),context=await a.validate(await a.issue(f.account,f.run)),h=dataHandlers(f.db);
  for(const card of [{kind:"finding"},{kind:"finding",claim:"ok",extra:true},{kind:"answer",claim:"wrong"}])
   await expect(h["cards.card.finding"](context,{card},randomUUID())).rejects.toMatchObject({code:"CARD_SCHEMA_MISMATCH"});
  const card={kind:"finding",claim:"fixture validated"};
  const result=await h["cards.card.finding"](context,{card},randomUUID());
  expect(result.cardId).toBeTypeOf("string");
  expect((await f.admin.query("select payload from event where run_id=$1 and action='card_created'",[f.run])).rows).toEqual([{payload:{cardId:result.cardId,card}}]);
 }finally{await f.close();}
});
