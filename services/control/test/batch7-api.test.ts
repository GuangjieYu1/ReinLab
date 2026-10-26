import { it, expect, vi } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { createServer } from "node:http";
import { mcpFixture } from "./mcp-fixture";
import { createApp } from "../src/api/app";
import { PricingService } from "../src/budget/pricing";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { DecisionService } from "../src/bridge/openscience/decisions";
import { materializeHarnessRole } from "../src/harness/materialize";
import { loadToolRegistry } from "../src/harness/manifest";
import { captureSearch, publishSearch } from "../src/clarify/candidates";
import { appendEvent } from '../src/ledger';
async function fixture(version = "1.2.0") {
  const f = await mcpFixture(undefined, false, version, "research-clarify");
  const secret = randomBytes(48),
    issuer = "http://clarify.fixture/auth/v1";
  const token = await new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setSubject(f.account)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        deepseek: {
          models: {
            "deepseek-v4-flash": {
              cost: { input: 0.15, output: 0.6 },
              limit: { context: 1000000, output: 32000 },
            },
          },
        },
      })
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const pricing = new PricingService({
    catalogUrl: "http://127.0.0.1:" + (server.address() as any).port,
    routes: {
      cheap: "deepseek/deepseek-v4-flash",
      strong: "deepseek/deepseek-v4-flash",
    },
    usdCny: "7.2",
  });
  const queued = vi.fn(async () => {});
  let native: any;
  const decisions = new DecisionService(f.db, { runtime: async () => native });
  const app = await createApp({
    pool: f.pool,
    auth: { issuer, secret },
    pricing,
    onRunQueued: queued,
    pipeline: {
      submit: queued,
      recoverAccount: vi.fn(async () => {}),
      decisions,
    },
  });
  const post = (path: string, body: any, key = randomUUID()) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const state = () =>
    app.request("/v1/dossiers/" + f.dossier + "/read-state", {
      headers: { authorization: "Bearer " + token },
    });
  return {
    ...f,
    app,
    post,
    state,
    inbox: () => app.request('/v1/approvals',{headers:{authorization:'Bearer '+token}}),
    queued,
    decisions,
    setNative: (n: any) => (native = n),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await f.close();
    },
  };
}
it("explicit clarification queues search-only cheap run once without confirmation, isolated from formal read and tenant state", async () => {
  const f = await fixture();
  try {
    const key = randomUUID(),
      path = "/v1/dossiers/" + f.dossier + "/read/clarify";
    const response = await f.post(path, { text: "我想读注意力机制" }, key);
    expect(response.status).toBe(201);
    const value = await response.json();
    expect(
      await (await f.post(path, { text: "我想读注意力机制" }, key)).json()
    ).toEqual(value);
    expect(f.queued).toHaveBeenCalledTimes(1);
    const run = (
      await f.admin.query("select * from run where id=$1", [value.runId])
    ).rows[0];
    expect(run.role_id).toBe("research-clarify");
    expect(Number(run.budget_cny)).toBe(0.5);
    const scope = (
      await f.admin.query("select scope from mcp_run where run_id=$1", [
        value.runId,
      ])
    ).rows[0].scope;
    expect(scope.grants.map((g: any) => g.name)).toEqual(["papers.search"]);
    const snap = await (await f.state()).json();
    expect(snap.run).toBeNull();
    expect(snap.clarification.capCny).toBe(0.5);
    expect(snap.clarification.chosen).toBeNull();
    expect(
      (
        await f.post("/v1/dossiers/" + randomUUID() + "/read/clarify", {
          text: "外档案",
        })
      ).status
    ).toBe(404);
    expect(
      (
        await f.post("/v1/runs/estimate", {
          dossierId: f.dossier,
          mode: "read",
          candidateId: randomUUID(),
          size: 1,
        })
      ).status
    ).toBe(409);
  } finally {
    await f.close();
  }
});
it.each(["research", "inbox", "reply"])(
  "%s native question requires a human receipt; page quote binds revision and unchoose never reopens old authority",
  async (entry) => {
    const f = await fixture();
    try {
      await f.admin.query("update run set state='queued' where id=$1", [f.run]);
      await f.admin.query(
        "insert into read_clarification(account_id,dossier_id)values($1,$2)",
        [f.account, f.dossier]
      );
      await f.admin.query(
        "insert into read_clarify_run(account_id,dossier_id,run_id)values($1,$2,$3)",
        [f.account, f.dossier, f.run]
      );
      const role = materializeHarnessRole(
        f.effective,
        await loadToolRegistry(),
        {
          dossierId: f.dossier,
          roleId: "research-clarify",
          modelRoutes: { cheap: "deepseek/deepseek-v4-flash" },
          memory: "",
        }
      );
      const b = await new BindingStore(f.db).prepare(f.account, f.run, {
        role,
        message: "fixture",
      });
      await f.admin.query(
        "update os_binding set phase='accepted',receipt=$2 where run_id=$1",
        [f.run, { runID: "native_" + f.run, acceptedAt: 1 }]
      );
      await f.admin.query("update run set state='waiting' where id=$1", [
        f.run,
      ]);
      const result = {},
        work = {
          id: "https://openalex.org/W1",
          title: "Attention Fixture",
          authorships: [{ author: { display_name: "A" } }],
          biblio: { first_page: "10", last_page: "21" },
          open_access: { is_oa: true },
          primary_location: { source: { display_name: "Fixture Venue" } },
        };
      const second = {
        id: "https://openalex.org/W2",
        title: "Second Fixture",
        authorships: [{ author: { display_name: "B" } }],
        biblio: { first_page: "1", last_page: "9" },
        open_access: { is_oa: false },
        primary_location: { source: { display_name: "Fixture Venue" } },
      };
      captureSearch(result, [work, second]);
      await f.db.withAccount(f.account, (c) =>
        publishSearch(c, f.account, f.dossier, f.run, "fixture-search", result)
      );
      const approval = randomUUID(),
        req = "que_" + randomUUID(),
        question = {
          id: req,
          sessionID: b.sessionId,
          questions: [
            {
              header: entry === "reply" ? "REINLAB_CLARIFY" : "REINLAB_PAPER_PICK",
              question: "请选择论文",
              multiple: false,
              custom: entry === "reply",
              options: [
                { label: "W1", description: "Attention Fixture" },
                ...(entry === "reply"
                  ? []
                  : [{ label: "W2", description: "Second Fixture" }]),
                { label: "都不是", description: "继续描述" },
              ],
            },
          ],
        };
      await f.db.withAccount(f.account, (c) =>
        c.query(
          "insert into approval(id,account_id,run_id,os_request_id,os_session_id,kind,title,effects,risk)values($1,$2,$3,$4,$5,'question','请选择论文',$6,'read')",
          [
            approval,
            f.account,
            f.run,
            req,
            b.sessionId,
            JSON.stringify([{ properties: question }]),
          ]
        )
      );
      const runtime = {
        snapshot: vi.fn(async () => ({
          sessionID: b.sessionId,
          runs: [
            {
              runID: "native_" + f.run,
              sessionID: b.sessionId,
              requestID: b.requestId,
              messageID: "msg_fixture",
              state: "running",
              acceptedAt: 1,
              updatedAt: 1,
            },
          ],
          oldestSequence: 0,
          latestSequence: 0,
          permissions: [],
          questions: [question],
          decisionScope: "connected_runtime",
        })),
        decide: vi.fn(async () => ({
          sessionID: b.sessionId,
          requestID: req,
          status: "resolved",
          decidedAt: 1,
        })),
        cancel: vi.fn(async () => ({
          runID: "native_" + f.run,
          sessionID: b.sessionId,
          requestID: b.requestId,
          messageID: "msg_fixture",
          state: "cancelled",
          acceptedAt: 1,
          updatedAt: 1,
        })),
      };
      f.setNative(runtime);
      if (entry === "reply") {
        expect((await (await f.inbox()).json()).items.some((a:any)=>a.runId===f.run)).toBe(false);
        const before=await (await f.state()).json();expect(before.clarification.pendingQuestion).toEqual({approvalId:approval,runId:f.run});
        const answer=await f.post("/v1/dossiers/"+f.dossier+"/read/clarify",{text:"补充：Toolformer",approvalId:approval});
        expect(answer.status).toBe(202);expect((await answer.json()).runId).toBe(f.run);
        expect(runtime.decide).toHaveBeenCalledTimes(1);expect(f.queued).not.toHaveBeenCalled();
        expect((await f.admin.query("select count(*)::int n from read_clarify_run where dossier_id=$1",[f.dossier])).rows[0].n).toBe(1);
        return;
      }
      let snap = await (await f.state()).json();
      expect(snap.clarification.chosen).toBeNull();
      const pick = snap.clarification.history.find(
          (e: any) => e.type === "pick"
        ),
        candidate = pick.candidates[0];
      expect(candidate).toMatchObject({
        title: work.title,
        authors: "A",
        pages: 12,
        // 只标了 is_oa、没有可下载 PDF 的论文按「只有摘要」算，别先说有全文。
        access: "abstract_only",
      });
      expect(pick.candidates[1].access).toBe("abstract_only");
      expect(
        (
          await f.post("/v1/runs/estimate", {
            dossierId: f.dossier,
            mode: "read",
            candidateId: candidate.id,
          })
        ).status
      ).toBe(409);
      expect(
        (
          await f.post("/v1/dossiers/" + f.dossier + "/read/pick", {
            pickId: approval,
            candidateId: randomUUID(),
          })
        ).status
      ).toBe(409);
      expect(runtime.decide).not.toHaveBeenCalled();
      const key = randomUUID(),
        path =
          entry === "inbox"
            ? "/v1/approvals/" + approval + "/decide"
            : "/v1/dossiers/" + f.dossier + "/read/pick",
        payload =
          entry === "inbox"
            ? { decision: "approve", scope: "once", answers: [["W1"]] }
            : { pickId: approval, candidateId: candidate.id };
      const selected = await f.post(path, payload, key);
      expect(selected.status).toBe(202);
      expect((await f.post(path, payload, key)).status).toBe(202);
      expect(runtime.decide).toHaveBeenCalledTimes(1);
      snap = await (await f.state()).json();
      expect(snap.clarification.chosen?.id).toBe(candidate.id);
      const estimate = await f.post("/v1/runs/estimate", {
        dossierId: f.dossier,
        mode: "read",
        candidateId: candidate.id,
      });
      expect(estimate.status).toBe(201);
      const quote = await estimate.json();
      expect(quote.assumptions).toMatchObject({
        estimatedPages: 12,
        candidateId: candidate.id,
        knownPages: 12,
        pagesSource: "bibliographic-range",
      });
      expect(
        (await f.post("/v1/dossiers/" + f.dossier + "/read/unchoose", {}))
          .status
      ).toBe(200);
      expect(
        (
          await f.admin.query(
            "select closed from read_clarify_run where run_id=$1",
            [f.run]
          )
        ).rows[0].closed
      ).toBe(true);
      // 「换一篇」之后，同一张已答的候选卡可以直接改选：不调模型，只换 read_candidate 里选定的那篇。
      const beforeSwap = await (await f.state()).json();
      const swapped = await f.post("/v1/dossiers/" + f.dossier + "/read/pick", {
        pickId: approval,
        candidateId: pick.candidates[1].id,
      });
      expect(swapped.status).toBe(201);
      expect(await swapped.json()).toMatchObject({ accepted: true, repicked: true });
      expect(runtime.decide).toHaveBeenCalledTimes(1);
      const afterSwap = await (await f.state()).json();
      expect(afterSwap.clarification.chosen?.id).toBe(pick.candidates[1].id);
      expect(afterSwap.clarification.selectionRevision).toBeGreaterThan(
        beforeSwap.clarification.selectionRevision
      );
      expect(
        (
          await f.post("/v1/runs/estimate", {
            dossierId: f.dossier,
            mode: "read",
            candidateId: pick.candidates[1].id,
          })
        ).status
      ).toBe(201);
      expect(
        (
          await f.post("/v1/dossiers/" + f.dossier + "/read/unchoose", {})
        ).status
      ).toBe(200);
      expect(
        (
          await f.post("/v1/runs", {
            dossierId: f.dossier,
            mode: "read",
            roleId: "research-read",
            estimateId: quote.id,
            budget: { cny: 5 },
            confirmed: true,
            input: { chosenCandidateId: candidate.id },
          })
        ).status
      ).toBe(409);
    } finally {
      await f.close();
    }
  }
);

it("closing unknown clarification permits a fresh run in the same dossier, while its own forwarding stays fenced",async()=>{
 const f=await fixture();try{
 const path='/v1/dossiers/'+f.dossier+'/read/clarify';
 const first=await (await f.post(path,{text:'第一轮'})).json();
 const reserve=(id:string,hash:string)=>f.db.withAccount(f.account,c=>c.query("insert into clarify_model_request(account_id,dossier_id,run_id,body_hash,maximum_micros,state)values($1,$2,$3,$4,33029,'forwarding')",[f.account,f.dossier,id,hash]));
 await reserve(first.runId,'a'.repeat(64));
 await f.db.withAccount(f.account,c=>appendEvent(c,f.account,{dossierId:f.dossier,runId:first.runId,kind:'cost',action:'priced_native_usage',costCny:.007253,dedupeKey:'priced-once'}));
 expect((await (await f.state()).json()).clarification).toMatchObject({spentCny:.007253,unknownCost:true});
 expect((await f.post('/v1/dossiers/'+f.dossier+'/read/cancel-clarify',{})).status).toBe(202);
 const ended=(await f.admin.query('select state,ended_at from run where id=$1',[first.runId])).rows[0];expect(ended.ended_at).not.toBeNull();
 expect((await f.post(path,{text:'迟到的旧输入',selectionRevision:0})).status).toBe(409);
 const current=(await(await f.state()).json()).clarification.selectionRevision;
 const second=await f.post(path,{text:'Toolformer',selectionRevision:current});expect(second.status).toBe(201);const run=(await second.json()).runId;expect(run).not.toBe(first.runId);
 await expect(reserve(run,'a'.repeat(64))).resolves.toBeDefined();
 await expect(reserve(run,'b'.repeat(64))).rejects.toMatchObject({code:'23514'});
 }finally{await f.close();}
});
