import { expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CapabilitySigner, verifyCapabilityToken } from "../src/mcp/token";
import { CapabilityAuthority } from "../src/mcp/authority";
import { mcpFixture } from "./mcp-fixture";
it("T-MCP-1 tenant isolation, immutable scope, online revocation and run-end expiry use actual PostgreSQL", async()=>{
 const f=await mcpFixture();
 try {
  const signer=new CapabilitySigner(generateKeyPairSync("ed25519").privateKey), a=new CapabilityAuthority(f.db,signer);
  const token=await a.issue(f.account,f.run), claims=verifyCapabilityToken(token,signer.publicKey,Math.floor(Date.now()/1000));
  expect((await a.validate(token)).claims.run).toBe(f.run);
  await expect(f.db.withAccount(randomUUID(), c=>c.query("select * from mcp_run"))).resolves.toMatchObject({rowCount:0});
  await expect(f.db.withAccount(f.account,c=>c.query("update mcp_run set scope='{}' where run_id=$1",[f.run]))).rejects.toMatchObject({code:"42501"});
  await a.revoke(f.account,f.run);
  await expect(a.validate(token)).rejects.toMatchObject({code:"CAPABILITY_TOKEN_INVALID"});
  await expect(a.issue(f.account,f.run)).rejects.toMatchObject({code:"CAPABILITY_TOKEN_INVALID"});
  expect((await f.admin.query("select revoked_at from mcp_credential where jti=$1",[claims.jti])).rows[0].revoked_at).not.toBeNull();
  await expect(f.db.withAccount(f.account,c=>c.query("update mcp_credential set revoked_at=null where jti=$1",[claims.jti]))).rejects.toMatchObject({code:"23514"});
 }finally{await f.close();}
});
it("run end denies tokens, and a legacy run with no frozen capability snapshot cannot mint current grants",async()=>{
 const f=await mcpFixture();
 try{
  const a=new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync("ed25519").privateKey));
  const token=await a.issue(f.account,f.run);
  await f.admin.query("update run set state='completed',ended_at=now() where id=$1",[f.run]);
  await expect(a.validate(token)).rejects.toMatchObject({code:"CAPABILITY_TOKEN_INVALID"});
  await expect(a.issue(f.account,randomUUID())).rejects.toMatchObject({code:"CAPABILITY_SNAPSHOT_MISSING"});
 }finally{await f.close();}
});
