import {appendEvent} from '../src/ledger';
import { it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { mcpFixture } from "./mcp-fixture";
import { createApp } from "../src/api/app";

it("promotion supersession is tenant-scoped and multi-item failures roll back with immutable tenant receipts", async () => {
  const f = await mcpFixture(), issuer = "https://review.invalid/auth/v1", secret = randomBytes(48), other = randomUUID();
  try {
    const app = await createApp({ pool: f.pool, auth: { issuer, secret } });
    const token = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience("authenticated").setSubject(f.account).setIssuedAt().setExpirationTime("1h").sign(secret);
    const request = (id: string, decision: string) => app.request("/v1/promotions/" + id + "/decide", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ decision }) });
    await f.admin.query("insert into account(id) values($1)", [other]);
    const foreignDossier = randomUUID(), foreignRun = randomUUID(), foreignPromotion = randomUUID(), foreignApproval = randomUUID();
    await f.admin.query("insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','foreign fixture','/data/foreign')", [foreignDossier, other]);
    await f.admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'running',1)", [foreignRun, other, foreignDossier, randomUUID()]);
    await f.admin.query("insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at) values($1,$2,$3,'L4.knowledge','[{\"key\":\"foreign\",\"value\":\"x\",\"evidence\":[\"synthetic\"]}]','fixture',now()+interval '1 day')", [foreignPromotion, other, foreignRun]);
    expect((await request(foreignPromotion, "approve")).status).toBe(404);
    await f.admin.query("insert into approval(id,account_id,run_id,kind,title,effects,risk) values($1,$2,$3,'permission','foreign fixture','{\"operation\":\"approval.request\"}','write')", [foreignApproval, other, foreignRun]);
    const foreignDecision = await app.request("/v1/approvals/" + foreignApproval + "/decide", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ decision: "approve", scope: "once" }) });
    expect(foreignDecision.status).toBe(404);
    const foreign = randomUUID();
    await f.admin.query("insert into memory_item(id,account_id,layer,key,value,evidence) values($1,$2,'L4','foreign','{}','[]')", [foreign, other]);
    const source=await f.db.withAccount(f.account,c=>appendEvent(c,f.account,{dossierId:f.dossier,runId:f.run,kind:'message',payload:{text:'independent user evidence'},dedupeKey:randomUUID()})),eventRef='event:'+source.seq;
    const proposal = async (items: unknown) => {
      const id = randomUUID();
      await f.admin.query("insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at) values($1,$2,$3,'L4.knowledge',$4,'synthetic evidence',now()+interval '1 day')", [id, f.account, f.run, JSON.stringify(items)]); return id;
    };
    const bad = await proposal([{ key: "first", value: "valid", evidence: [eventRef] }, { key: "foreign", value: "new", evidence: [eventRef], supersedes: foreign }]);
    expect((await request(bad, "approve")).status).toBe(409);
    expect((await f.admin.query("select 1 from memory_item where account_id=$1", [f.account])).rowCount).toBe(0);
    expect((await f.admin.query("select status from promotion where id=$1", [bad])).rows[0].status === "pending").toBe(true);
    const old = randomUUID();
    await f.admin.query("insert into memory_item(id,account_id,layer,key,value,evidence) values($1,$2,'L4','same','{}','[]')", [old, f.account]);
    const good = await proposal([{ key: "same", value: "new", evidence: [eventRef], supersedes: old }]);
    const response = await request(good, "approve"); expect(response.status).toBe(200);
    expect((await f.admin.query("select 1 from memory_item where account_id=$1 and supersedes=$2", [f.account, old])).rowCount).toBe(1);
    expect((await f.db.withAccount(other, c => c.query("select 1 from promotion_decision where promotion_id=$1", [good]))).rowCount).toBe(0);
    await expect(f.db.withAccount(f.account, c => c.query("update promotion_decision set request_hash=request_hash where promotion_id=$1", [good]))).rejects.toMatchObject({ code: "42501" });
    const security = (await f.admin.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where oid in ('promotion_decision'::regclass,'card_decision'::regclass)")).rows;
    expect(security.length === 2 && security.every(r => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  } finally { await f.close(); }
});
