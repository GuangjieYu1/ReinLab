import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { KernelAuth } from "../src/kernel/auth";

/**
 * 「确认整份计划」的授权语义（契约 §3）：plan.confirm 就是「所有候选 → 已确认」，
 * 所以同一批里跟着来的 stop.confirm 不必再逐个点名；但用户没说确认时，
 * 整份确认仍然要出卡。
 */
const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 3,
});
const A = randomUUID();
const dossier = randomUUID();
const run = randomUUID();
const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
let app: Awaited<ReturnType<typeof createApp>>;
/** 驳回/批准后要送回原会话：这里记下投递内容。 */
const resumed: { runId: string; prompt: string }[] = [];
let cookie = "";

const headers = (key?: string) => ({
  Cookie: cookie,
  Origin: "http://localhost",
  "X-ReinLab-CSRF": "1",
  "Content-Type": "application/json",
  ...(key ? { "Idempotency-Key": key } : {}),
});

const ops = async (body: unknown) =>
  app.request(`/v1/explore/plans/${dossier}/ops`, {
    method: "POST",
    headers: headers(randomUUID()),
    body: JSON.stringify(body),
  });

const readPlan = async () => (await app.request(`/v1/explore/plans/${dossier}`, { headers: headers() })).json();

const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await app.request("/kernel/tool", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": auth.issue({ account: A, dossier, run }, Math.floor(Date.now() / 1000)),
    },
    body: JSON.stringify({ server: "explore", tool: name, args }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

/** 往档案里塞一条真实用户消息（助手授权只认这一种来源）。 */
const userSaid = async (text: string) =>
  admin.query(
    `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
     values($1,$2,$3,'dsh','user/message',$4,$5)`,
    [A, dossier, run, JSON.stringify({ id: `msg-${randomUUID()}`, content: [{ type: "text", text }] }), randomUUID()],
  );

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name,timezone) values($1,'A','Asia/Shanghai')", [A]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','授权语义',$3)",
    [dossier, A, "/data/dossiers/" + dossier],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'bench-explore','explore',$4,'running',1)",
    [run, A, dossier, "req-" + run.slice(0, 8)],
  );
  const token = randomBytes(32).toString("base64url");
  await admin.query("select reinlab_session_open($1,$2)", [
    A,
    createHash("sha256").update(token).digest("hex"),
  ]);
  cookie = "rl_session=" + token;
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    kernelTools: { auth, dispatch: async () => ({}) },
    kernel: {
      isLive: () => false,
      resumeAfterAnswer: async (_account: string, runId: string, prompt: string) => {
        resumed.push({ runId, prompt });
      },
    } as never,
  });

  // 页面先 GET 一次拿到当前修订号，再带上它写（契约第 3 节）。
  const draft = await readPlan();
  const created = await ops({
    baseRevision: draft.plan.revision,
    ops: [
      {
        op: "plan.set",
        patch: {
          destination: { name: "杭州", center: [120.1405, 30.2566], timezone: "Asia/Shanghai" },
          days: ["2026-11-20"],
        },
      },
      {
        op: "stop.add",
        stop: {
          kind: "spot",
          name: "断桥残雪",
          geometry: { type: "Point", coordinates: [120.14663, 30.26047] },
          day: "2026-11-20",
          window: { start: "2026-11-20T07:00:00+08:00", end: "2026-11-20T08:00:00+08:00" },
        },
      },
      {
        op: "stop.add",
        stop: {
          kind: "spot",
          name: "平湖秋月",
          geometry: { type: "Point", coordinates: [120.1414, 30.2545] },
          day: "2026-11-20",
          window: { start: "2026-11-20T08:20:00+08:00", end: "2026-11-20T09:00:00+08:00" },
        },
      },
    ],
  });
  expect(created.status).toBe(200);
}, 40_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("确认整份计划的授权语义", () => {
  it("用户说「确认整份计划」：同批 stop.confirm 不必点名，直接生效不出卡", async () => {
    await admin.query("update account set timezone='Asia/Shanghai' where id=$1", [A]);
    await userSaid("就按这个安排，确认整份计划。");
    const plan = await readPlan();
    const ids = plan.plan.stops.map((stop: any) => stop.id);
    const response = await tool("ops", { ops: [{ op: "stop.confirm", ids }, { op: "plan.confirm" }] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as any).pending ?? null).toBeNull();
    const after = await readPlan();
    expect(after.plan.state).toBe("ready");
    expect(after.plan.stops.every((stop: any) => stop.state === "confirmed")).toBe(true);
  });

  it("用户只问「天气怎么样」：整份确认要出卡，计划仍是草稿", async () => {
    const fresh = randomUUID();
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','授权语义二',$3)",
      [fresh, A, "/data/dossiers/" + fresh],
    );
    const planOf = async () =>
      (await app.request(`/v1/explore/plans/${fresh}`, { headers: headers() })).json();
    const write = async (body: unknown) =>
      app.request(`/v1/explore/plans/${fresh}/ops`, {
        method: "POST",
        headers: headers(randomUUID()),
        body: JSON.stringify(body),
      });

    const seed = await planOf();
    const created = await write({
      baseRevision: seed.plan.revision,
      ops: [
        {
          op: "plan.set",
          patch: {
            destination: { name: "杭州", center: [120.1405, 30.2566], timezone: "Asia/Shanghai" },
            days: ["2026-11-22"],
          },
        },
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "苏堤春晓",
            geometry: { type: "Point", coordinates: [120.1438, 30.2489] },
            day: "2026-11-22",
            window: { start: "2026-11-22T07:00:00+08:00", end: "2026-11-22T08:00:00+08:00" },
          },
        },
      ],
    });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);

    // 用户这句话没要求确认。
    await admin.query(
      `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
       values($1,$2,null,'dsh','user/message',$3,$4)`,
      [
        A,
        fresh,
        JSON.stringify({ id: `msg-${randomUUID()}`, content: [{ type: "text", text: "那天天气怎么样？" }] }),
        randomUUID(),
      ],
    );
    // 助手路径：整份确认没有被这句话授权 → 出卡，计划不动。
    const call = await app.request("/kernel/tool", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.issue({ account: A, dossier: fresh, run }, Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ server: "explore", tool: "ops", args: { ops: [{ op: "plan.confirm" }] } }),
    });
    // 待批：工具返回 409 + pending（插件据此在对话里渲染计划修改卡）
    expect(call.status).toBe(409);
    const body = (await call.json()) as any;
    expect(body).toMatchObject({ state: "pending" });
    expect(body.pending?.approvalId).toBeTruthy();
    expect(body.pending?.ops?.length).toBeGreaterThan(0);
    expect((await planOf()).plan.state).toBe("draft");
  });

  it("用户说「候选都留下」：等同整份确认，直接生效不出卡", async () => {
    const fresh = randomUUID();
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','都留下',$3)",
      [fresh, A, "/data/dossiers/" + fresh],
    );
    const planOf = async () => (await app.request(`/v1/explore/plans/${fresh}`, { headers: headers() })).json();
    const write = async (body: unknown) =>
      app.request(`/v1/explore/plans/${fresh}/ops`, {
        method: "POST",
        headers: headers(randomUUID()),
        body: JSON.stringify(body),
      });
    const seed = await planOf();
    await write({
      baseRevision: seed.plan.revision,
      ops: [
        {
          op: "plan.set",
          patch: {
            destination: { name: "上海", center: [121.4905, 31.2415], timezone: "Asia/Shanghai" },
            days: ["2026-11-28"],
          },
        },
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "外滩",
            geometry: { type: "Point", coordinates: [121.4905, 31.2415] },
            day: "2026-11-28",
            window: { start: "2026-11-28T06:00:00+08:00", end: "2026-11-28T07:00:00+08:00" },
          },
        },
      ],
    });
    await admin.query(
      `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
       values($1,$2,null,'dsh','user/message',$3,$4)`,
      [
        A,
        fresh,
        JSON.stringify({ id: `msg-${randomUUID()}`, content: [{ type: "text", text: "候选都留下吧。" }] }),
        randomUUID(),
      ],
    );
    const call = await app.request("/kernel/tool", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.issue({ account: A, dossier: fresh, run }, Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        server: "explore",
        tool: "ops",
        args: { ops: [{ op: "stop.confirm", ids: [(await planOf()).plan.stops[0].id] }, { op: "plan.confirm" }] },
      }),
    });
    expect(call.status, JSON.stringify(await call.clone().json())).toBe(200);
    const after = await planOf();
    expect(after.plan.state).toBe("ready");
    expect(after.plan.stops.every((stop: any) => stop.state === "confirmed")).toBe(true);
  });

  it("驳回也要送回原会话：不然下一轮助手还会说「那张卡等你点」", async () => {
    const fresh = randomUUID();
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','驳回回送',$3)",
      [fresh, A, "/data/dossiers/" + fresh],
    );
    const seed = await (await app.request(`/v1/explore/plans/${fresh}`, { headers: headers() })).json();
    await app.request(`/v1/explore/plans/${fresh}/ops`, {
      method: "POST",
      headers: headers(randomUUID()),
      body: JSON.stringify({
        baseRevision: seed.plan.revision,
        ops: [
          {
            op: "plan.set",
            patch: {
              destination: { name: "杭州", center: [120.14, 30.25], timezone: "Asia/Shanghai" },
              days: ["2026-12-01"],
            },
          },
          {
            op: "stop.add",
            stop: {
              kind: "spot",
              name: "日出剧场",
              geometry: { type: "Point", coordinates: [114.07, 22.54] },
              day: "2026-12-01",
              state: "confirmed",
            },
          },
        ],
      }),
    });
    // 用户这句话没要求删除 → 出卡
    await admin.query(
      `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
       values($1,$2,null,'dsh','user/message',$3,$4)`,
      [
        A,
        fresh,
        JSON.stringify({ id: `msg-${randomUUID()}`, content: [{ type: "text", text: "这个点放在哪比较好？" }] }),
        randomUUID(),
      ],
    );
    const stopId = (await (await app.request(`/v1/explore/plans/${fresh}`, { headers: headers() })).json()).plan
      .stops[0].id;
    const card = await app.request("/kernel/tool", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.issue({ account: A, dossier: fresh, run }, Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ server: "explore", tool: "ops", args: { ops: [{ op: "stop.remove", id: stopId }] } }),
    });
    expect(card.status).toBe(409);
    const approvalId = ((await card.json()) as any).approvalId as string;
    expect(approvalId).toBeTruthy();
    // 把这张卡挂到一条 waiting 的运行上（真实场景就是这样）
    const waitingRun = randomUUID();
    await admin.query(
      "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'bench-explore','explore',$4,'waiting',1)",
      [waitingRun, A, fresh, "req-" + waitingRun.slice(0, 8)],
    );
    await admin.query("update approval set run_id=$1 where id=$2", [waitingRun, approvalId]);
    const decided = await app.request(`/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: headers(randomUUID()),
      body: JSON.stringify({ decision: "reject", scope: "once" }),
    });
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({ state: "rejected" });
    const delivered = resumed.filter((row) => row.runId === waitingRun);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].prompt).toContain("驳回");
    // 计划没变
    const after = await (await app.request(`/v1/explore/plans/${fresh}`, { headers: headers() })).json();
    expect(after.plan.stops).toHaveLength(1);
  });

  it("切卫星被拒：第一版只有矢量底图", async () => {
    const response = await tool("view", { viewport: { center: [120.14, 30.25], zoom: 12, bearing: 0, pitch: 0 }, basemap: "satellite" });
    expect(response.status).toBe(409);
    expect((response.body as any).code).toBe("BASEMAP_UNSUPPORTED");
    // vector 正常
    const ok = await tool("view", { viewport: { center: [120.14, 30.25], zoom: 12, bearing: 0, pitch: 0 }, basemap: "vector" });
    expect(ok.status).toBe(200);
  });
});
