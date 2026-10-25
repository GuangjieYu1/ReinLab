import { beforeAll, afterAll, it, expect, vi } from "vitest";
import pg from "pg";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { SignJWT } from "jose";
import { applyMigrations } from "../src/db/migrate";
import { Database } from "../src/db/database";
import { createApp } from "../src/api/app";
import { micros, decimal } from "../src/budget/money";
import { PricingService, pricingFromEnvironment } from "../src/budget/pricing";
import {
  allocateBudget,
  authorizeTool,
  settleTool,
  increaseRunBudget,
} from "../src/budget";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { publishBench } from "../src/harness/store";

const admin = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      "postgres://postgres@127.0.0.1:55432/reinlab_test",
  }),
  pool = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL_APP ??
      "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    max: 8,
  }),
  db = new Database(pool),
  A = randomUUID(),
  B = randomUUID(),
  C = randomUUID(),
  secret = randomBytes(48),
  issuer = "http://localhost/budget/auth/v1";
let app: Awaited<ReturnType<typeof createApp>>,
  token: string,
  tokenB: string,
  server: Server,
  pricing: PricingService;
const catalog = {
  probe: {
    models: {
      "probe-model": {
        cost: { input: 1.5, output: 3 },
        limit: { context: 200000, output: 16000 },
      },
    },
  },
};
beforeAll(async () => {
  await applyMigrations(admin, path.resolve("infra/supabase/migrations"));
  const registry = await loadToolRegistry();
  await publishBench(
    admin,
    await loadBenchBundle({ benchId: "research", registry, version: "1.1.0" }),
    registry
  );
  await admin.query(
    "insert into account(id,monthly_budget_cny) values($1,10000),($2,300),($3,10)",
    [A, B, C]
  );
  server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(catalog));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  pricing = new PricingService({
    catalogUrl: "http://127.0.0.1:" + address.port,
    routes: {
      cheap: "probe/probe-model",
      mid: "probe/probe-model",
      strong: "probe/probe-model",
    },
    usdCny: "7",
  });
  app = await createApp({ pool, auth: { issuer, secret }, pricing });
  const sign = (id: string) =>
    new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(id)
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
  token = await sign(A);
  tokenB = await sign(B);
}, 30000);
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
  await admin.end();
});
async function dossier(account = A) {
  const id = randomUUID();
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path,bench_version) values($1,$2,'research','预算测试',$3,'1.1.0')",
    [id, account, "/data/dossiers/" + id]
  );
  return id;
}
async function run(budget = "10", account = A, limits = { quota: 0, gpu: 0 }) {
  const d = await dossier(account),
    id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit) values($1,$2,$3,'research-read','read',$4,'running',$5,$6,$7)",
    [id, account, d, randomUUID(), budget, limits.quota, limits.gpu]
  );
  const root = await db.withAccount(account, (c) =>
    allocateBudget(c, account, { dossierId: d, amountCny: budget })
  );
  const allocation = await db.withAccount(account, (c) =>
    allocateBudget(c, account, {
      dossierId: d,
      amountCny: budget,
      parentId: root.id,
      runId: id,
    })
  );
  return { id, d, root, allocation };
}
const post = (url: string, input: unknown, jwt = token, key = randomUUID()) =>
  app.request(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + jwt,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(input),
  });
const hold = (
  id: string,
  maximumCny: string,
  requestId = randomUUID(),
  extra = {}
) =>
  db.withAccount(A, (c) =>
    authorizeTool(c, A, { runId: id, requestId, maximumCny, ...extra })
  );
const pay = (holdId: string, costCny: string | null, extra = {}) =>
  db.withAccount(A, (c) =>
    settleTool(c, A, { holdId, costCny, credentialKind: "api_key", ...extra })
  );
it("定点数精确支持科学计数和六位，拒绝超精度/非有限/负数", () => {
  expect(micros("0.1") + micros("0.2")).toBe(300000n);
  expect(decimal(300001n)).toBe("0.300001");
  expect(micros(1e-6)).toBe(1n);
  for (const x of [
    "1e-7",
    "0.1234567",
    NaN,
    Infinity,
    -1,
    "",
    {},
    "0.30000000000000004",
  ])
    expect(() => micros(x)).toThrow();
});
it("真实HTTP价目格式读取，估算有模型汇率摘要和token假设", async () => {
  const q = await pricing.estimate({
    mode: "read",
    modelTier: "strong",
    size: 1,
  });
  expect(q.estimatedCny).toBe("0.336000");
  expect(q.model).toBe("probe/probe-model");
  expect(q.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(q.usdCnyRate).toBe("7.000000");
  expect(q.inputTokens).toBe(10000);
});
it("缺模型/汇率不提供假估算", async () => {
  await expect(
    pricingFromEnvironment({}).estimate({ mode: "read", modelTier: "strong" })
  ).rejects.toMatchObject({ code: "PRICING_UNAVAILABLE" });
  const wrong = new PricingService({
    catalogUrl: pricing.catalogUrl,
    routes: { strong: "probe/missing" },
    usdCny: "7",
  });
  await expect(
    wrong.estimate({ mode: "read", modelTier: "strong" })
  ).rejects.toMatchObject({ code: "PRICING_UNAVAILABLE" });
});
it("估算持久化后确认只排队，不执行模型；跨租户与重复消费拒绝", async () => {
  const d = await dossier();
  const estimateResponse = await post("/v1/runs/estimate", {
    dossierId: d,
    mode: "read",
    modelTier: "strong",
  });
  expect(estimateResponse.status).toBe(201);
  const estimate = await estimateResponse.json(),
    input = {
      dossierId: d,
      mode: "read",
      roleId: "research-read",
      budget: { cny: 5 },
      estimateId: estimate.id,
      confirmed: true,
      input: { question: "读论文" },
    };
  expect((await post("/v1/runs", input, tokenB)).status).toBe(404);
  const started = await post("/v1/runs", input);
  expect(started.status).toBe(201);
  const body = await started.json();
  expect(body.state).toBe("queued");
  expect(body.osSessionId).toBeUndefined();
  expect((await post("/v1/runs", input)).status).toBe(409);
});
it("估算不能更换模式/档案/角色档，过期拒绝", async () => {
  const d = await dossier(),
    e = await (
      await post("/v1/runs/estimate", {
        dossierId: d,
        mode: "read",
        modelTier: "strong",
      })
    ).json();
  const input = {
    dossierId: d,
    mode: "read",
    roleId: "research-read",
    budget: { cny: 5 },
    estimateId: e.id,
    confirmed: true,
    input: {},
  };
  expect(
    (await post("/v1/runs", { ...input, mode: "swarm", roleId: "swarm-lead" }))
      .status
  ).toBe(409);
  expect(
    (await post("/v1/runs", { ...input, dossierId: await dossier() })).status
  ).toBe(409);
  await admin.query(
    "update budget_estimate set expires_at=now()-interval '1 second' where id=$1",
    [e.id]
  );
  expect((await post("/v1/runs", input)).status).toBe(409);
});
it("账户只计根划拨，子划拨不能超父预算", async () => {
  const r = await run("10");
  const totals = await admin.query(
    "select sum(amount_cny)::text total from budget_allocation where account_id=$1 and parent_id is null and dossier_id=$2",
    [A, r.d]
  );
  expect(Number(totals.rows[0].total)).toBe(10);
  await expect(
    db.withAccount(A, (c) =>
      allocateBudget(c, A, {
        dossierId: r.d,
        amountCny: "1",
        parentId: r.root.id,
        runId: randomUUID(),
      })
    )
  ).rejects.toThrow();
  const d = await dossier(C);
  await expect(
    db.withAccount(C, (c) =>
      allocateBudget(c, C, { dossierId: d, amountCny: "10.000001" })
    )
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
});
it("跨账户父预算与run引用拒绝", async () => {
  const r = await run(),
    otherDossier = await dossier(B);
  await expect(
    db.withAccount(B, (c) =>
      allocateBudget(c, B, {
        dossierId: otherDossier,
        amountCny: "1",
        parentId: r.root.id,
      })
    )
  ).rejects.toThrow();
  await expect(
    db.withAccount(B, (c) =>
      authorizeTool(c, B, {
        runId: r.id,
        requestId: randomUUID(),
        maximumCny: "1",
      })
    )
  ).rejects.toMatchObject({ status: 404 });
});
it("80%只提醒一次，不暂停；100%停并创建一次预算审批", async () => {
  const r = await run(),
    h = await hold(r.id, "8");
  await pay(h.holdId!, "8");
  expect(
    (await admin.query("select state from run where id=$1", [r.id])).rows[0]
      .state
  ).toBe("running");
  const h2 = await hold(r.id, "0.5");
  await pay(h2.holdId!, "0.5");
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where run_id=$1 and action='budget_warning'",
        [r.id]
      )
    ).rows[0].n
  ).toBe(1);
  const last = await hold(r.id, "1.5");
  await pay(last.holdId!, "1.5");
  expect(
    (await admin.query("select state from run where id=$1", [r.id])).rows[0]
      .state
  ).toBe("paused_budget");
  expect((await hold(r.id, "0.01")).allowed).toBe(false);
  expect(
    (
      await admin.query(
        "select count(*)::int n from approval where run_id=$1 and kind='budget'",
        [r.id]
      )
    ).rows[0].n
  ).toBe(1);
});
it("并发两工具在边缘最多一个获准，真实超出保留额仍记账并说明", async () => {
  const r = await run("1"),
    first = await hold(r.id, "0.8");
  await pay(first.holdId!, "0.8");
  const attempts = await Promise.all([hold(r.id, "0.2"), hold(r.id, "0.2")]);
  expect(attempts.filter((h) => h.allowed)).toHaveLength(1);
  const winner = attempts.find((h) => h.allowed)!;
  await pay(winner.holdId!, "0.25");
  const last = (
    await admin.query(
      "select payload from event where run_id=$1 and kind='cost' order by seq desc limit 1",
      [r.id]
    )
  ).rows[0].payload;
  expect(last.overrunCny).toBe("0.050000");
  expect(last.reason).toBe("provider_report_exceeded_reservation");
  expect(
    (await admin.query("select spent_cny,state from run where id=$1", [r.id]))
      .rows[0]
  ).toMatchObject({ spent_cny: "1.050000", state: "paused_budget" });
});
it("费用保留与结算幂等，异内容冲突", async () => {
  const r = await run(),
    key = randomUUID(),
    h = await hold(r.id, "1", key);
  expect(await hold(r.id, "1", key)).toEqual(h);
  await expect(hold(r.id, "2", key)).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
  const paid = await pay(h.holdId!, "0.5");
  expect(await pay(h.holdId!, "0.5")).toEqual(paid);
  await expect(pay(h.holdId!, "0.6")).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where run_id=$1 and kind='cost'",
        [r.id]
      )
    ).rows[0].n
  ).toBe(1);
});
it("未知API费用保持null并暂停，加预算不能当作已对账", async () => {
  const r = await run(),
    h = await hold(r.id, "1");
  await pay(h.holdId!, null);
  expect(
    (
      await admin.query(
        "select cost_cny from event where run_id=$1 and kind='cost'",
        [r.id]
      )
    ).rows[0].cost_cny
  ).toBeNull();
  await db.withAccount(A, (c) => increaseRunBudget(c, A, r.id, "1"));
  expect(
    (await admin.query("select state from run where id=$1", [r.id])).rows[0]
      .state
  ).toBe("paused_budget");
  await pay(h.holdId!, "0.75");
  expect(
    (await admin.query("select spent_cny from run where id=$1", [r.id])).rows[0]
      .spent_cny
  ).toBe("0.750000");
});
it("会员额度与GPU秒独立预留结算，不折成人民币", async () => {
  const r = await run("10", A, { quota: 2, gpu: 60 }),
    h = await hold(r.id, "0", randomUUID(), {
      maximumQuota: 1,
      maximumGpuSeconds: 30,
    });
  expect(h.allowed).toBe(true);
  await pay(h.holdId!, null, {
    credentialKind: "subscription_oauth",
    quota: 1,
    gpuSeconds: 30,
  });
  expect(
    (
      await admin.query(
        "select spent_cny,quota_runs,gpu_seconds,state from run where id=$1",
        [r.id]
      )
    ).rows[0]
  ).toMatchObject({
    spent_cny: "0.000000",
    quota_runs: "1",
    gpu_seconds: "30",
    state: "running",
  });
  const h2 = await hold(r.id, "0", randomUUID(), {
    maximumQuota: 1,
    maximumGpuSeconds: 30,
  });
  await pay(h2.holdId!, null, {
    credentialKind: "external_runtime",
    quota: 1,
    gpuSeconds: 30,
  });
  expect(
    (await hold(r.id, "0", randomUUID(), { maximumQuota: 1 })).allowed
  ).toBe(false);
});
it("明确追加预算后恢复已暂停运行，根/子限额同步增加", async () => {
  const r = await run("1"),
    h = await hold(r.id, "1");
  await pay(h.holdId!, "1");
  const response = await post("/v1/runs/" + r.id + "/budget", { cny: 2 });
  expect(response.status).toBe(200);
  expect(
    (await admin.query("select state,budget_cny from run where id=$1", [r.id]))
      .rows[0]
  ).toMatchObject({ state: "running", budget_cny: "3.000000" });
  const nodes = await admin.query(
    "select amount_cny from budget_allocation where dossier_id=$1",
    [r.d]
  );
  expect(nodes.rows.every((x) => x.amount_cny === "3.000000")).toBe(true);
});
it("跨月先停，不自动动用新月额度", async () => {
  const r = await run();
  await admin.query(
    "update budget_allocation set period=(date_trunc('month',now())-interval '1 month')::date where dossier_id=$1",
    [r.d]
  );
  expect(await hold(r.id, "1")).toMatchObject({
    allowed: false,
    reason: "BUDGET_PERIOD_EXPIRED",
  });
  expect(
    (await admin.query("select state from run where id=$1", [r.id])).rows[0]
      .state
  ).toBe("paused_budget");
});
it("父运行不能花掉已给子运行的保留预算", async () => {
  const r = await run("10"),
    child = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,$4,'swarm-reader','swarm',$5,'running',8)",
    [child, A, r.d, r.id, randomUUID()]
  );
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: r.d,
      amountCny: "8",
      parentId: r.allocation.id,
      runId: child,
    })
  );
  expect(await hold(r.id, "3")).toMatchObject({
    allowed: false,
    reason: "BUDGET_EXCEEDED",
  });
  expect((await hold(child, "8")).allowed).toBe(false);
  await db.withAccount(A, (c) => increaseRunBudget(c, A, r.id, "1"));
  await db.withAccount(A, (c) => increaseRunBudget(c, A, child, "0.000001"));
  const h = await hold(child, "8");
  expect(h.allowed).toBe(true);
  await pay(h.holdId!, "9");
  expect(await hold(r.id, "2")).toMatchObject({ allowed: false });
});
it("新增预算表强制RLS，跨租户读取零行", async () => {
  const r = await run(),
    h = await hold(r.id, "1");
  for (const table of ["budget_estimate", "budget_allocation", "budget_hold"]) {
    const flags = await admin.query(
      "select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass",
      [table]
    );
    expect(flags.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    expect(
      (
        await db.withAccount(B, (c) =>
          c.query(`select * from ${table} where account_id=$1`, [A])
        )
      ).rowCount
    ).toBe(0);
  }
  await expect(
    db.withAccount(B, (c) =>
      settleTool(c, B, {
        holdId: h.holdId!,
        costCny: "1",
        credentialKind: "api_key",
      })
    )
  ).rejects.toMatchObject({ status: 404 });
});
it("追加子预算优先用父未划拨余额，不重复占账户月额度", async () => {
  const d = await dossier(),
    id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'running',5)",
    [id, A, d, randomUUID()]
  );
  const root = await db.withAccount(A, (c) =>
    allocateBudget(c, A, { dossierId: d, amountCny: "10" })
  );
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: d,
      amountCny: "5",
      parentId: root.id,
      runId: id,
    })
  );
  await db.withAccount(A, (c) => increaseRunBudget(c, A, id, "1"));
  expect(
    (
      await admin.query(
        "select amount_cny from budget_allocation where id=$1",
        [root.id]
      )
    ).rows[0].amount_cny
  ).toBe("10.000000");
});
it("跨档案委托从明确父划拨支出，账户不重复计费", async () => {
  const from = await dossier(),
    to = await dossier(),
    delegationId = randomUUID(),
    id = randomUUID();
  await admin.query(
    "insert into delegation(id,account_id,from_dossier,to_bench,to_dossier,budget_cny,request,state) values($1,$2,$3,'research',$4,5,'{}','pending')",
    [delegationId, A, from, to]
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'running',4)",
    [id, A, to, randomUUID()]
  );
  const root = await db.withAccount(A, (c) =>
    allocateBudget(c, A, { dossierId: from, amountCny: "10" })
  );
  const delegated = await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: from,
      amountCny: "5",
      parentId: root.id,
      delegationId,
    })
  );
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: to,
      amountCny: "4",
      parentId: delegated.id,
      runId: id,
    })
  );
  const h = await hold(id, "4");
  await pay(h.holdId!, "4");
  expect(
    (
      await admin.query("select spent_cny from budget_allocation where id=$1", [
        root.id,
      ])
    ).rows[0].spent_cny
  ).toBe("4.000000");
  await db.withAccount(A, (c) => increaseRunBudget(c, A, id, "2"));
  expect(
    (
      await admin.query(
        "select amount_cny from budget_allocation where id=$1",
        [root.id]
      )
    ).rows[0].amount_cny
  ).toBe("10.000000");
});
it("结算事件失败时累计费用/保留收据/审批整体回滚，修复后可重试", async () => {
  const r = await run("1"),
    h = await hold(r.id, "1"),
    suffix = randomUUID().replaceAll("-", ""),
    name = "budget_fault_" + suffix;
  await admin.query(
    `create function ${name}() returns trigger language plpgsql as $$ begin if NEW.run_id='${r.id}'::uuid and NEW.action='usage_reported' then raise exception 'injected cost event failure'; end if; return NEW; end $$; create trigger ${name} before insert on event for each row execute function ${name}();`
  );
  try {
    await expect(pay(h.holdId!, "1")).rejects.toThrow();
    expect(
      (await admin.query("select spent_cny,state from run where id=$1", [r.id]))
        .rows[0]
    ).toMatchObject({ spent_cny: "0.000000", state: "running" });
    expect(
      (
        await admin.query("select state,receipt from budget_hold where id=$1", [
          h.holdId,
        ])
      ).rows[0]
    ).toEqual({ state: "reserved", receipt: null });
    expect(
      (
        await admin.query(
          "select count(*)::int n from approval where run_id=$1",
          [r.id]
        )
      ).rows[0].n
    ).toBe(0);
  } finally {
    await admin.query(`drop trigger ${name} on event;drop function ${name}()`);
  }
  await pay(h.holdId!, "1");
  expect(
    (await admin.query("select spent_cny,state from run where id=$1", [r.id]))
      .rows[0]
  ).toMatchObject({ spent_cny: "1.000000", state: "paused_budget" });
});
it("账户和档案预算视图只计根，已知费用与未知分列", async () => {
  const before = await (
      await app.request("/v1/me", {
        headers: { Authorization: "Bearer " + token },
      })
    ).json(),
    r = await run("10"),
    h = await hold(r.id, "3");
  await pay(h.holdId!, "3");
  const after = await (
    await app.request("/v1/me", {
      headers: { Authorization: "Bearer " + token },
    })
  ).json();
  expect(
    Number(after.budget.allocatedCny) - Number(before.budget.allocatedCny)
  ).toBe(10);
  expect(
    Number(after.budget.spentKnownCny) - Number(before.budget.spentKnownCny)
  ).toBe(3);
  const detail = await (
    await app.request("/v1/dossiers/" + r.d, {
      headers: { Authorization: "Bearer " + token },
    })
  ).json();
  expect(detail.budget).toEqual({ allocatedCny: 10, spentCny: 3 });
  const other = await (
    await app.request("/v1/me", {
      headers: { Authorization: "Bearer " + tokenB },
    })
  ).json();
  expect(other.budget.monthlyLimitCny).toBe("300.000000");
});
it("双零或非法目录价格拒绝，非目标embedding记录不影响正常模型", async () => {
  const cost = catalog.probe.models["probe-model"].cost,
    saved = { ...cost };
  try {
    cost.input = 0;
    cost.output = 0;
    await expect(
      new PricingService({
        catalogUrl: pricing.catalogUrl,
        routes: { strong: "probe/probe-model" },
        usdCny: "7",
      }).estimate({ mode: "read", modelTier: "strong" })
    ).rejects.toMatchObject({ code: "PRICING_UNAVAILABLE" });
  } finally {
    Object.assign(cost, saved);
  }
  const models = catalog.probe.models as Record<string, unknown>;
  models.embedding = { cost: { input: 0 }, limit: { output: 0 } };
  try {
    expect(
      (
        await new PricingService({
          catalogUrl: pricing.catalogUrl,
          routes: { strong: "probe/probe-model" },
          usdCny: "7",
        }).estimate({ mode: "swarm", size: 8, modelTier: "strong" })
      ).estimatedCny
    ).toBe("10.752000");
  } finally {
    delete models.embedding;
  }
});
it("估算表不可更新，运行输入落库且过滤凭据字段", async () => {
  const d = await dossier(),
    e = await (
      await post("/v1/runs/estimate", {
        dossierId: d,
        mode: "read",
        modelTier: "strong",
      })
    ).json();
  await expect(
    db.withAccount(A, (c) =>
      c.query("update budget_estimate set quote=quote where id=$1", [e.id])
    )
  ).rejects.toThrow();
  const result = await post("/v1/runs", {
    dossierId: d,
    mode: "read",
    roleId: "research-read",
    estimateId: e.id,
    budget: { cny: 5 },
    confirmed: true,
    input: { question: "真实输入", password: "synthetic" },
  });
  expect(result.status).toBe(201);
  const id = (await result.json()).id;
  expect(
    (await admin.query("select input from run where id=$1", [id])).rows[0].input
  ).toEqual({ question: "真实输入", password: "[REDACTED]" });
});
it("子运行追加需要父预算增长时，父运行限额同步且不重复增加子限额", async () => {
  const r = await run("10"),
    child = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,$4,'swarm-reader','swarm',$5,'running',8)",
    [child, A, r.d, r.id, randomUUID()]
  );
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: r.d,
      amountCny: "8",
      parentId: r.allocation.id,
      runId: child,
    })
  );
  await db.withAccount(A, (c) => increaseRunBudget(c, A, child, "5"));
  expect(
    (await admin.query("select budget_cny from run where id=$1", [r.id]))
      .rows[0].budget_cny
  ).toBe("13.000000");
  expect(
    (await admin.query("select budget_cny from run where id=$1", [child]))
      .rows[0].budget_cny
  ).toBe("13.000000");
});
it("用户可单独追加会员额度和GPU分钟，零追加被拒绝", async () => {
  const r = await run("10", A, { quota: 1, gpu: 60 }),
    h = await hold(r.id, "0", randomUUID(), { maximumQuota: 1 });
  await pay(h.holdId!, null, {
    credentialKind: "subscription_oauth",
    quota: 1,
  });
  expect(
    (await post("/v1/runs/" + r.id + "/budget", { quotaRuns: 2 })).status
  ).toBe(200);
  expect(
    (await admin.query("select quota_limit,state from run where id=$1", [r.id]))
      .rows[0]
  ).toMatchObject({ quota_limit: "3", state: "running" });
  const hg = await hold(r.id, "0", randomUUID(), { maximumGpuSeconds: 60 });
  await pay(hg.holdId!, null, {
    credentialKind: "external_runtime",
    gpuSeconds: 60,
  });
  expect(
    (await post("/v1/runs/" + r.id + "/budget", { gpuMinutes: 1 })).status
  ).toBe(200);
  expect(
    (await admin.query("select gpu_limit,state from run where id=$1", [r.id]))
      .rows[0]
  ).toMatchObject({ gpu_limit: "120", state: "running" });
  expect((await post("/v1/runs/" + r.id + "/budget", { cny: 0 })).status).toBe(
    400
  );
});
it("跨月暂停后用户明确确认新月预算，同一运行保留历史费用后继续", async () => {
  const now = new Date(),
    clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)
      );
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run("10");
    const h = await hold(r.id, "3");
    await pay(h.holdId!, "3");
  } finally {
    clock.mockRestore();
  }
  expect((await hold(r!.id, "1")).reason).toBe("BUDGET_PERIOD_EXPIRED");
  const updated = await post("/v1/runs/" + r!.id + "/budget", { cny: 5 });
  expect(updated.status).toBe(200);
  expect(
    (
      await admin.query(
        "select state,budget_cny,spent_cny from run where id=$1",
        [r!.id]
      )
    ).rows[0]
  ).toMatchObject({
    state: "running",
    budget_cny: "8.000000",
    spent_cny: "3.000000",
  });
  expect((await hold(r!.id, "5")).allowed).toBe(true);
});
it("父运行在途费用必须扣除后才能划拨子预算", async () => {
  const r = await run("10");
  await hold(r.id, "8");
  const id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,$4,'swarm-reader','swarm',$5,'running',10)",
    [id, A, r.d, r.id, randomUUID()]
  );
  await expect(
    db.withAccount(A, (c) =>
      allocateBudget(c, A, {
        dossierId: r.d,
        amountCny: "10",
        parentId: r.allocation.id,
        runId: id,
      })
    )
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
});
it("会员及GPU子预算不能绕过父级已在途上限", async () => {
  const r = await run("10", A, { quota: 1, gpu: 60 });
  await hold(r.id, "0", randomUUID(), {
    maximumQuota: 1,
    maximumGpuSeconds: 60,
  });
  const id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit) values($1,$2,$3,$4,'swarm-reader','swarm',$5,'running',2,2,120)",
    [id, A, r.d, r.id, randomUUID()]
  );
  await expect(
    db.withAccount(A, (c) =>
      allocateBudget(c, A, {
        dossierId: r.d,
        amountCny: "2",
        parentId: r.allocation.id,
        runId: id,
      })
    )
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
});
it("子运行会员/GPU实际用量向祖先累计，达到父上限整体暂停且不重复计费", async () => {
  const r = await run("10", A, { quota: 2, gpu: 120 }),
    id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit) values($1,$2,$3,$4,'swarm-reader','swarm',$5,'running',2,2,120)",
    [id, A, r.d, r.id, randomUUID()]
  );
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: r.d,
      amountCny: "2",
      parentId: r.allocation.id,
      runId: id,
    })
  );
  const h = await hold(id, "0", randomUUID(), {
    maximumQuota: 2,
    maximumGpuSeconds: 120,
  });
  await pay(h.holdId!, null, {
    credentialKind: "subscription_oauth",
    quota: 2,
    gpuSeconds: 120,
  });
  expect(
    (
      await admin.query(
        "select quota_runs,gpu_seconds,state from run where id=$1",
        [r.id]
      )
    ).rows[0]
  ).toEqual({ quota_runs: "2", gpu_seconds: "120", state: "paused_budget" });
  expect(
    (
      await admin.query(
        "select count(*)::int n from event where run_id=any($1::uuid[]) and kind='cost'",
        [[r.id, id]]
      )
    ).rows[0].n
  ).toBe(1);
});
it("三维子追加先用父剩余，不足才同步父上限，每次决定只提升一次版本", async () => {
  const r = await run("10", A, { quota: 2, gpu: 120 }),
    id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit) values($1,$2,$3,$4,'swarm-reader','swarm',$5,'running',2,1,60)",
    [id, A, r.d, r.id, randomUUID()]
  );
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: r.d,
      amountCny: "2",
      parentId: r.allocation.id,
      runId: id,
    })
  );
  await hold(r.id, "0", randomUUID(), {
    maximumQuota: 1,
    maximumGpuSeconds: 60,
  });
  expect(
    (await post("/v1/runs/" + id + "/budget", { quotaRuns: 2, gpuMinutes: 2 }))
      .status
  ).toBe(200);
  expect(
    (
      await admin.query(
        "select quota_limit,gpu_limit,budget_revision from run where id=$1",
        [r.id]
      )
    ).rows[0]
  ).toEqual({ quota_limit: "4", gpu_limit: "240", budget_revision: 1 });
  expect(
    (
      await admin.query(
        "select quota_limit,gpu_limit,budget_revision from run where id=$1",
        [id]
      )
    ).rows[0]
  ).toEqual({ quota_limit: "3", gpu_limit: "180", budget_revision: 1 });
});
it("子额度达到父上限后，用户追加同时重新核准祖先再继续", async () => {
  const r = await run("10", A, { quota: 1, gpu: 60 }),
    id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit) values($1,$2,$3,$4,'swarm-reader','swarm',$5,'running',2,1,60)",
    [id, A, r.d, r.id, randomUUID()]
  );
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: r.d,
      amountCny: "2",
      parentId: r.allocation.id,
      runId: id,
    })
  );
  const h = await hold(id, "0", randomUUID(), {
    maximumQuota: 1,
    maximumGpuSeconds: 60,
  });
  await pay(h.holdId!, null, {
    credentialKind: "subscription_oauth",
    quota: 1,
    gpuSeconds: 60,
  });
  expect(
    (await post("/v1/runs/" + id + "/budget", { quotaRuns: 1, gpuMinutes: 1 }))
      .status
  ).toBe(200);
  expect(
    (await admin.query("select state from run where id=$1", [r.id])).rows[0]
      .state
  ).toBe("running");
  expect(
    (
      await hold(id, "0", randomUUID(), {
        maximumQuota: 1,
        maximumGpuSeconds: 60,
      })
    ).allowed
  ).toBe(true);
});
it("合法单次费用极端超额仍完整累计，两笔在途真实回报不因总额大而丢账", async () => {
  const accountId = randomUUID();
  await admin.query(
    "insert into account(id,monthly_budget_cny) values($1,300)",
    [accountId]
  );
  const r = await run("1", accountId),
    authorize = () =>
      db.withAccount(accountId, (c) =>
        authorizeTool(c, accountId, {
          runId: r.id,
          requestId: randomUUID(),
          maximumCny: "0.1",
        })
      ),
    a = await authorize(),
    b = await authorize();
  for (const holdId of [a.holdId!, b.holdId!])
    await db.withAccount(accountId, (c) =>
      settleTool(c, accountId, {
        holdId,
        costCny: "600000",
        credentialKind: "api_key",
      })
    );
  expect(
    (await admin.query("select spent_cny,state from run where id=$1", [r.id]))
      .rows[0]
  ).toEqual({ spent_cny: "1200000.000000", state: "paused_budget" });
  expect(
    (
      await admin.query(
        "select sum(cost_cny)::text total from event where run_id=$1 and kind='cost'",
        [r.id]
      )
    ).rows[0].total
  ).toBe("1200000.000000");
});
it("预算与工具收据身份不能改写，数据库拒绝双节点来源环", async () => {
  const r = await run(),
    h = await hold(r.id, "1");
  await expect(
    db.withAccount(A, (c) =>
      c.query("update budget_allocation set parent_id=null where id=$1", [
        r.allocation.id,
      ])
    )
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    db.withAccount(A, (c) =>
      c.query("update budget_hold set maximum_cny=0 where id=$1", [h.holdId])
    )
  ).rejects.toMatchObject({ code: "42501" });
  const x = randomUUID(),
    y = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
  for (const id of [x, y])
    await admin.query(
      "insert into run(id,account_id,dossier_id,parent_run_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,$4,'swarm-reader','swarm',$5,'running',1)",
      [id, A, r.d, r.id, randomUUID()]
    );
  await expect(
    db.withAccount(A, (c) =>
      c.query(
        "insert into budget_allocation(id,account_id,dossier_id,parent_id,run_id,period,amount_cny,quota_limit,gpu_limit) values($1,$2,$3,$4,$5,date_trunc('month',now())::date,1,0,0),($4,$2,$3,$1,$6,date_trunc('month',now())::date,1,0,0)",
        [a, A, r.d, b, x, y]
      )
    )
  ).rejects.toMatchObject({ code: "23514" });
});
it("显式根额度也可经用户追加向上核准，不捏造账户月配额", async () => {
  const d = await dossier(),
    id = randomUUID();
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit) values($1,$2,$3,'research-read','read',$4,'running',5,1,60)",
    [id, A, d, randomUUID()]
  );
  const root = await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: d,
      amountCny: "10",
      quotaRuns: 2,
      gpuSeconds: 120,
    })
  );
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: d,
      amountCny: "5",
      parentId: root.id,
      runId: id,
    })
  );
  expect(
    (await post("/v1/runs/" + id + "/budget", { quotaRuns: 2, gpuMinutes: 2 }))
      .status
  ).toBe(200);
  expect(
    (
      await admin.query(
        "select quota_limit,gpu_limit from budget_allocation where id=$1",
        [root.id]
      )
    ).rows[0]
  ).toEqual({ quota_limit: "3", gpu_limit: "180" });
});
it("委托携带的会员/GPU只能从来源运行划拨，目标不能多取", async () => {
  const r = await run("10", A, { quota: 2, gpu: 120 }),
    target = await dossier(),
    delegationId = randomUUID(),
    id = randomUUID();
  await admin.query(
    "insert into delegation(id,account_id,from_dossier,from_run,to_bench,to_dossier,budget_cny,request,state) values($1,$2,$3,$4,'research',$5,5,$6::jsonb,'pending')",
    [
      delegationId,
      A,
      r.d,
      r.id,
      target,
      JSON.stringify({ budget: { cny: 5, quotaRuns: 1, gpuMinutes: 1 } }),
    ]
  );
  const source = await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: r.d,
      amountCny: "5",
      parentId: r.allocation.id,
      delegationId,
    })
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit) values($1,$2,$3,'research-read','read',$4,'running',2,2,120)",
    [id, A, target, randomUUID()]
  );
  await expect(
    db.withAccount(A, (c) =>
      allocateBudget(c, A, {
        dossierId: target,
        amountCny: "2",
        parentId: source.id,
        runId: id,
      })
    )
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  await admin.query("update run set quota_limit=1,gpu_limit=60 where id=$1", [
    id,
  ]);
  await db.withAccount(A, (c) =>
    allocateBudget(c, A, {
      dossierId: target,
      amountCny: "2",
      parentId: source.id,
      runId: id,
    })
  );
  const h = await hold(id, "0", randomUUID(), {
    maximumQuota: 1,
    maximumGpuSeconds: 60,
  });
  await pay(h.holdId!, null, {
    credentialKind: "subscription_oauth",
    quota: 1,
    gpuSeconds: 60,
  });
  expect(
    (
      await admin.query("select quota_runs,gpu_seconds from run where id=$1", [
        r.id,
      ])
    ).rows[0]
  ).toEqual({ quota_runs: "1", gpu_seconds: "60" });
  expect(
    (await post("/v1/runs/" + id + "/budget", { quotaRuns: 1, gpuMinutes: 1 }))
      .status
  ).toBe(200);
  expect(
    (
      await admin.query("select request from delegation where id=$1", [
        delegationId,
      ])
    ).rows[0].request.budget
  ).toMatchObject({ quotaRuns: 2, gpuMinutes: 2 });
});
