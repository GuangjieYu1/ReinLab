import { beforeAll, afterAll, it, expect, vi } from "vitest";
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { SignJWT } from "jose";
import { Database } from "../src/db/database";
import { appendEvent } from "../src/ledger";
import { applyMigrations } from "../src/db/migrate";
import { createApp } from "../src/api/app";
import type { PricingService } from "../src/budget/pricing";
import { loadToolRegistry, loadBenchBundle } from "../src/harness/manifest";
import { HarnessStore, publishBench } from "../src/harness/store";
import { initialEffective } from "../src/harness/resolver";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import {
  DecisionService,
  type DecisionRuntimePort,
} from "../src/bridge/openscience/decisions";
import type { RuntimePipeline } from "../src/bridge/openscience/pipeline";
const admin = new pg.Pool({
    connectionString: "postgres://postgres@127.0.0.1:55432/reinlab_test",
    max: 2,
  }),
  pool = new pg.Pool({
    connectionString: "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    max: 5,
  }),
  db = new Database(pool),
  secret = randomBytes(48),
  issuer = "http://localhost/runtime-api-fixture/auth/v1";
let registry: Awaited<ReturnType<typeof loadToolRegistry>>,
  bundle: Awaited<ReturnType<typeof loadBenchBundle>>;
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  registry = await loadToolRegistry();
  bundle = await loadBenchBundle({ benchId: "research", registry });
  await publishBench(admin, bundle, registry);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function fixture(accepted = false) {
  const account = randomUUID(),
    foreign = randomUUID(),
    dossier = randomUUID(),
    run = randomUUID();
  await admin.query("insert into account(id) values($1),($2)", [
    account,
    foreign,
  ]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','http',$3)",
    [dossier, account, "/data/dossiers/" + dossier],
  );
  const effective = initialEffective(bundle);
  await admin.query(
    "insert into bench_effective(account_id,digest,bench,version,bundle_digest,snapshot) values($1,$2,$3,$4,$5,$6::jsonb)",
    [
      account,
      effective.digest,
      "research",
      bundle.manifest.version,
      bundle.digest,
      JSON.stringify(effective),
    ],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'queued',1)",
    [run, account, dossier, randomUUID()],
  );
  await admin.query(
    "insert into run_harness(account_id,dossier_id,run_id,bench,version,effective_digest,model_route) values($1,$2,$3,$4,$5,$6,$7)",
    [
      account,
      dossier,
      run,
      "research",
      bundle.manifest.version,
      effective.digest,
      "fixture/confirmed",
    ],
  );
  const binding = accepted
    ? await new BindingStore(db).prepare(account, run, {
        role: {
          dossierId: dossier,
          role: {
            id: "research-read",
            prompt: "PRIVATE_PROMPT_SENTINEL",
            toolGrants: { read: { risk: "read", permission: "ask" } },
            writeTargets: [],
            steps: 1,
          },
          model: "fixture/confirmed",
          memory: "PRIVATE_MEMORY_SENTINEL",
        },
        message: "private message",
      })
    : null;
  if (binding) {
    const lease = (await new BindingStore(db).claim(account, run))!;
    await new BindingStore(db).baseline(account, run, lease, 0);
    await new BindingStore(db).sendIntent(account, run, lease);
    await new BindingStore(db).receipt(account, run, {
      runID: "os_runtime_" + run,
      acceptedAt: 1,
    });
    await admin.query("update run set state='running' where id=$1", [run]);
  }
  const approval = randomUUID(),
    question = randomUUID(),
    request = "permission_" + run,
    questionRequest = "question_" + run;
  if (binding)
    for (const [id, kind, requestId] of [
      [approval, "permission", request],
      [question, "question", questionRequest],
    ])
      await admin.query(
        "insert into approval(id,account_id,run_id,os_request_id,os_session_id,kind,title,effects,risk,state) values($1,$2,$3,$4,$5,$6,'fixture approval','[]','read','pending')",
        [id, account, run, requestId, binding.sessionId, kind],
      );
  const decide = vi.fn(async (input: any) => ({
      status: "resolved",
      sessionID: binding!.sessionId,
      requestID: input.requestID,
    })),
    cancel = vi.fn(async () => ({
      sessionID: binding!.sessionId,
      runID: "os_runtime_" + run,
      requestID: binding!.requestId,
      state: "cancelled",
    }));
  const snapshotCalls = vi.fn();
  const runtime = {
    snapshot: async () => (
      snapshotCalls(),
      {
        sessionID: binding!.sessionId,
        runs: [
          {
            runID: "os_runtime_" + run,
            sessionID: binding!.sessionId,
            requestID: binding!.requestId,
            state: "running",
          },
        ],
        permissions: [
          { id: request, sessionID: binding!.sessionId, permission: "read" },
        ],
        questions: [
          {
            id: questionRequest,
            sessionID: binding!.sessionId,
            questions: [{ options: [{ label: "yes" }], custom: false }],
          },
        ],
      }
    ),
    decide,
    cancel,
  } as unknown as DecisionRuntimePort;
  const decisions = new DecisionService(db, { runtime: async () => runtime }),
    submit = vi.fn(async () => ({
      status: "accepted" as const,
      receipt: { runID: "must-not-leak", acceptedAt: 1 },
    })),
    recoverAccount = vi.fn(async () => 0),
    pipeline = { decisions, submit, recoverAccount } as unknown as Pick<
      RuntimePipeline,
      "decisions" | "submit" | "recoverAccount"
    >;
  const app = await createApp({
    pool,
    auth: { issuer, secret },
    harness: new HarnessStore(db, bundle, registry),
    pipeline,
  });
  const token = async (id: string) =>
      new SignJWT({ role: "authenticated" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(id)
        .setIssuer(issuer)
        .setAudience("authenticated")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(secret),
    jwt = await token(account),
    foreignJwt = await token(foreign);
  const post = (
    path: string,
    body: unknown,
    key: string | undefined = randomUUID(),
    auth = jwt,
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + auth,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  const get = (path: string, auth = jwt) =>
    app.request(path, { headers: { authorization: "Bearer " + auth } });
  return {
    account,
    foreign,
    dossier,
    run,
    binding,
    approval,
    question,
    app,
    post,
    get,
    submit,
    recoverAccount,
    decide,
    cancel,
    snapshotCalls,
    foreignJwt,
    jwt,
    pipeline,
  };
}
it("safe run DTO excludes prompts, memory and native identities and rejects foreign ownership", async () => {
  const f = await fixture(true),
    response = await f.get("/v1/runs/" + f.run);
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  expect(body.id).toBe(f.run);
  expect(body.submissionPhase).toBe("accepted");
  for (const secret of [
    "PRIVATE_",
    "os_runtime_",
    f.binding!.sessionId,
    "must-not-leak",
  ])
    expect(JSON.stringify(body)).not.toContain(secret);
  expect((await f.get("/v1/runs/" + f.run, f.foreignJwt)).status).toBe(404);
  expect(f.recoverAccount).toHaveBeenCalledWith(f.account);
});
it("explicit submit saves202 then calls pipeline once, including same-key replay and deferred delivery", async () => {
  const f = await fixture(),
    key = randomUUID();
  f.submit.mockRejectedValue(new Error("PRIVATE_PROVIDER_FAILURE"));
  const response = await f.post("/v1/runs/" + f.run + "/submit", {}, key);
  expect(response.status).toBe(202);
  const body = await response.json();
  expect((await f.post("/v1/runs/" + f.run + "/submit", {}, key)).status).toBe(
    202,
  );
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(body)).not.toContain("PRIVATE");
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where run_id=$1 and action='runtime_submit_deferred'",
        [f.run],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("submit enforces exact body, idempotency, ownership and confirmed Harness binding", async () => {
  const f = await fixture();
  expect((await f.post("/v1/runs/" + f.run + "/submit", {}, "")).status).toBe(
    400,
  );
  for (const body of [
    { role: "evil" },
    { model: "evil/model" },
    { root: "/outside" },
    { approved: true },
  ])
    expect((await f.post("/v1/runs/" + f.run + "/submit", body)).status).toBe(
      400,
    );
  expect(
    (
      await f.post(
        "/v1/runs/" + f.run + "/submit",
        {},
        randomUUID(),
        f.foreignJwt,
      )
    ).status,
  ).toBe(404);
  expect(f.submit).not.toHaveBeenCalled();
  const run = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'queued',1)",
    [run, f.account, f.dossier, randomUUID()],
  );
  expect((await f.post("/v1/runs/" + run + "/submit", {})).status).toBe(409);
});
it("validates questions before saving HTTP or decision intent; missing idem header never reaches snapshot", async () => {
  const f = await fixture(true),
    key = randomUUID();
  const bad = await f.post(
    "/v1/approvals/" + f.question + "/decide",
    { decision: "approve", answers: [["bad"]] },
    key,
  );
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).code).toBe("INVALID_ANSWER");
  expect(
    (
      await admin.query("select decision_hash from approval where id=$1", [
        f.question,
      ])
    ).rows[0].decision_hash,
  ).toBeNull();
  expect(
    (
      await admin.query(
        "select count(*)::int n from http_request where account_id=$1",
        [f.account],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(f.decide).not.toHaveBeenCalled();
  expect(f.snapshotCalls).toHaveBeenCalledTimes(1);
  expect(
    (
      await f.post(
        "/v1/approvals/" + f.question + "/decide",
        { decision: "approve", answers: [["yes"]] },
        "",
      )
    ).status,
  ).toBe(400);
  expect(f.snapshotCalls).toHaveBeenCalledTimes(1);
});
it("decision prepare and dispatch remain idempotent across HTTP and alternate-key repeats", async () => {
  const f = await fixture(true),
    key = randomUUID(),
    body = { decision: "approve", scope: "once" };
  const first = await f.post(
    "/v1/approvals/" + f.approval + "/decide",
    body,
    key,
  );
  expect(first.status).toBe(202);
  expect(
    (await f.post("/v1/approvals/" + f.approval + "/decide", body, key)).status,
  ).toBe(202);
  expect(
    (await f.post("/v1/approvals/" + f.approval + "/decide", body)).status,
  ).toBe(202);
  expect(f.decide).toHaveBeenCalledTimes(1);
  expect(
    (
      await f.post(
        "/v1/approvals/" + f.approval + "/decide",
        { decision: "reject" },
        key,
      )
    ).status,
  ).toBe(409);
});
it("cancel records intent then uses only the durable cancellation service fence", async () => {
  const f = await fixture(true),
    key = randomUUID();
  expect((await f.post("/v1/runs/" + f.run + "/cancel", {}, key)).status).toBe(
    202,
  );
  expect((await f.post("/v1/runs/" + f.run + "/cancel", {}, key)).status).toBe(
    202,
  );
  expect((await f.post("/v1/runs/" + f.run + "/cancel", {})).status).toBe(202);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(
    (await f.post("/v1/runs/" + f.run + "/cancel", { force: true })).status,
  ).toBe(400);
  expect(
    (
      await f.post(
        "/v1/runs/" + f.run + "/cancel",
        {},
        randomUUID(),
        f.foreignJwt,
      )
    ).status,
  ).toBe(404);
});
it("approval state filter is exact and does not expose native request/session identities", async () => {
  const f = await fixture(true);
  await admin.query("update approval set state='indeterminate' where id=$1", [
    f.question,
  ]);
  await admin.query("update approval set effects=$2::jsonb where id=$1", [
    f.approval,
    JSON.stringify([
      {
        sessionID: f.binding!.sessionId,
        requestID: "native-private-request",
        questions: [
          { header: "VISIBLE_QUESTION", options: [{ label: "yes" }] },
        ],
      },
    ]),
  ]);
  const pending = await f.get("/v1/approvals?state=pending"),
    indeterminate = await f.get("/v1/approvals?state=indeterminate");
  expect(pending.status).toBe(200);
  expect(indeterminate.status).toBe(200);
  const a = (await pending.json()) as any,
    b = (await indeterminate.json()) as any;
  expect(a.items.map((x: any) => x.id)).toEqual([f.approval]);
  expect(b.items.map((x: any) => x.id)).toEqual([f.question]);
  expect(JSON.stringify([a, b])).not.toContain(f.binding!.sessionId);
  expect(JSON.stringify([a, b])).not.toContain("native-private-request");
  expect(JSON.stringify(a)).toContain("VISIBLE_QUESTION");
  expect((await f.get("/v1/approvals?state=approved")).status).toBe(400);
  expect(
    (
      (await (
        await f.get("/v1/approvals?state=pending", f.foreignJwt)
      ).json()) as any
    ).items,
  ).toEqual([]);
});
it("GET recovery failures are stable and never hide the requested safe data", async () => {
  const f = await fixture();
  f.recoverAccount.mockRejectedValue(new Error("PRIVATE_RECOVERY_FAILURE"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await f.get("/v1/runs/" + f.run)).status).toBe(200);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ code: "RUNTIME_RECOVERY_DEFERRED" }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE");
  } finally {
    log.mockRestore();
  }
});
it("Harness HTTP patch and user approval share http idempotency transaction without prompt plaintext", async () => {
  const f = await fixture(),
    path = "/v1/dossiers/" + f.dossier + "/harness";
  const summary = await f.get(path);
  expect(summary.status).toBe(200);
  const initial = (await summary.json()) as any;
  expect(initial.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(initial)).not.toContain(
    bundle.prompts["research-read"],
  );
  expect((await f.get(path, f.foreignJwt)).status).toBe(404);
  const key = randomUUID(),
    tight = { roles: { "research-read": { tools: { literature: "ask" } } } };
  const first = await f.post(path + "/patch", tight, key);
  expect(first.status).toBe(201);
  expect((await f.post(path + "/patch", tight, key)).status).toBe(201);
  expect(
    (
      await admin.query(
        "select count(*)::int n from harness_proposal where dossier_id=$1",
        [f.dossier],
      )
    ).rows[0].n,
  ).toBe(1);
  const proposed = await f.post(path + "/patch", {
    roles: { "research-read": { tools: { literature: "allow" } } },
  });
  expect(proposed.status).toBe(201);
  const proposal = (await proposed.json()) as any;
  expect(proposal.state).toBe("pending");
  const decisionPath = "/v1/harness/proposals/" + proposal.id + "/decide",
    decideKey = randomUUID();
  expect(
    (await f.post(decisionPath, { decision: "approve" }, decideKey)).status,
  ).toBe(200);
  expect(
    (await f.post(decisionPath, { decision: "approve" }, decideKey)).status,
  ).toBe(200);
  expect(
    (await f.post(decisionPath, { decision: "reject" }, decideKey)).status,
  ).toBe(409);
  expect((await f.post(path + "/patch", { prompt: "override" })).status).toBe(
    400,
  );
  expect((await f.post(decisionPath, { approved: true })).status).toBe(400);
});

it.each([false, true])(
  "confirmation selects default pipeline callback while explicit hook wins=%s",
  async (explicit) => {
    const f = await fixture(),
      hook = vi.fn(async () => {}),
      pricing = {
        route: () => "fixture/confirmed",
      } as unknown as PricingService;
    const app = await createApp({
      pool,
      auth: { issuer, secret },
      harness: new HarnessStore(db, bundle, registry),
      pipeline: f.pipeline,
      pricing,
      ...(explicit ? { onRunQueued: hook } : {}),
    });
    const estimate = randomUUID(),
      digest = (
        await admin.query(
          "select effective_digest from run_harness where run_id=$1",
          [f.run],
        )
      ).rows[0].effective_digest;
    await admin.query(
      "insert into budget_estimate(id,account_id,dossier_id,mode,model_tier,quote,expires_at) values($1,$2,$3,'read','strong',$4::jsonb,now()+interval '10 minutes')",
      [
        estimate,
        f.account,
        f.dossier,
        JSON.stringify({
          model: "fixture/confirmed",
          assumptions: { effectiveConfigDigest: digest },
        }),
      ],
    );
    const key = randomUUID(),
      request = {
        method: "POST",
        headers: {
          authorization: "Bearer " + f.jwt,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({
          dossierId: f.dossier,
          mode: "read",
          roleId: "research-read",
          budget: { cny: 1 },
          estimateId: estimate,
          confirmed: true,
          input: { question: "callback" },
        }),
      };
    expect((await app.request("/v1/runs", request)).status).toBe(201);
    expect((await app.request("/v1/runs", request)).status).toBe(201);
    expect(f.submit).toHaveBeenCalledTimes(explicit ? 0 : 1);
    expect(hook).toHaveBeenCalledTimes(explicit ? 1 : 0);
  },
);
it("post-commit decision delivery failure retains the accepted receipt and stable ledger error", async () => {
  const f = await fixture(true),
    dispatch = vi
      .spyOn(f.pipeline.decisions, "dispatch")
      .mockRejectedValue(new Error("PRIVATE_DELIVERY_FAILURE")),
    key = randomUUID();
  try {
    const first = await f.post(
      "/v1/approvals/" + f.approval + "/decide",
      { decision: "approve" },
      key,
    );
    expect(first.status).toBe(202);
    expect(
      (
        await f.post(
          "/v1/approvals/" + f.approval + "/decide",
          { decision: "approve" },
          key,
        )
      ).status,
    ).toBe(202);
    const rows = (
      await admin.query(
        "select payload from event where run_id=$1 and action='runtime_decision_deferred'",
        [f.run],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    expect(f.decide).not.toHaveBeenCalled();
  } finally {
    dispatch.mockRestore();
  }
});

it("run cost uncertainty includes unpriced observed usage even with a complete event history", async () => {
  const f = await fixture(true);
  await db.withAccount(f.account, async (client) => {
    const event = await appendEvent(client, f.account, {
      dossierId: f.dossier,
      runId: f.run,
      kind: "cost",
      action: "fixture_usage_unknown",
      costCny: null,
      payload: {},
      dedupeKey: "fixture-unknown:" + f.run,
    });
    await client.query(
      "insert into os_usage(account_id,dossier_id,run_id,session_id,part_id,message_id,source_hash,cost_cny,metadata,event_seq) values($1,$2,$3,$4,$5,$6,$7,null,$8::jsonb,$9)",
      [
        f.account,
        f.dossier,
        f.run,
        f.binding!.sessionId,
        "part_" + f.run,
        "msg_" + f.run,
        "a".repeat(64),
        JSON.stringify({ status: "unknown" }),
        event.seq,
      ],
    );
  });
  expect(
    ((await (await f.get("/v1/runs/" + f.run)).json()) as any).usageUnknown,
  ).toBe(true);
});
