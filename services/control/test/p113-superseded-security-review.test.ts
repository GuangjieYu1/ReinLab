import { it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { mcpFixture } from "./mcp-fixture";
import { createApp } from "../src/api/app";

it("superseded reads bind account, proposal reference, key, layer and dossier even for concurrent requests", async () => {
  const f = await mcpFixture(), other = randomUUID(), secret = randomBytes(48), issuer = "https://p113-review.invalid/auth/v1";
  try {
    const app = await createApp({ pool: f.pool, auth: { issuer, secret } });
    const jwt = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience("authenticated").setSubject(f.account).setIssuedAt().setExpirationTime("1h").sign(secret);
    const read = (p: string, m: string) => app.request("/v1/promotions/" + p + "/superseded/" + m, { headers: { authorization: "Bearer " + jwt } });
    await f.admin.query("insert into account(id) values($1)", [other]);
    const otherDossier = randomUUID(); await f.admin.query("insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','review other','/data/review-other')", [otherDossier, f.account]);
    const own = randomUUID(), foreign = randomUUID(), wrongLayer = randomUUID(), wrongDossier = randomUUID(), local = randomUUID();
    await f.admin.query("insert into memory_item(id,account_id,layer,key,value) values($1,$3,'L4','fact','\"own\"'),($2,$4,'L4','fact','\"foreign\"')", [own, foreign, f.account, other]);
    await f.admin.query("insert into memory_item(id,account_id,layer,key,value) values($1,$2,'L3','fact','\"wrong-layer\"')", [wrongLayer, f.account]);
    await f.admin.query("insert into memory_item(id,account_id,layer,dossier_id,key,value) values($1,$3,'L2',$4,'fact','\"other-dossier\"'),($2,$3,'L2',$5,'fact','\"current-dossier\"')", [wrongDossier, local, f.account, otherDossier, f.dossier]);
    const proposal = async (memory?: string, key = "fact") => {
      const id = randomUUID();
      await f.admin.query("insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at) values($1,$2,$3,'L4.knowledge',$4,'review fixture',now()+interval '1 day')", [id, f.account, f.run, JSON.stringify([{ key, value: "new", evidence: [], ...(memory ? { supersedes: memory } : {}) }])]); return id;
    };
    const valid = await proposal(own), unreferenced = await proposal(), badKey = await proposal(own, "other-key");
    const requests = [read(valid, own), read(unreferenced, own), read(badKey, own), read(await proposal(foreign), foreign), read(await proposal(wrongLayer), wrongLayer), read(await proposal(wrongDossier), wrongDossier), read(await proposal(local), local)];
    expect((await Promise.all(requests)).map(r => r.status)).toEqual([200, 404, 404, 404, 404, 404, 200]);
    const otherRun = randomUUID(), otherAccountDossier = randomUUID(), foreignProposal = randomUUID();
    await f.admin.query("insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','foreign account','/data/foreign-account')", [otherAccountDossier, other]);
    await f.admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'running',1)", [otherRun, other, otherAccountDossier, randomUUID()]);
    await f.admin.query("insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at) values($1,$2,$3,'L4.knowledge',$4,'foreign proposal',now()+interval '1 day')", [foreignProposal, other, otherRun, JSON.stringify([{ key: "fact", value: "new", evidence: [], supersedes: foreign }])]);
    expect((await read(foreignProposal, foreign)).status).toBe(404);
  } finally { await f.close(); }
});
