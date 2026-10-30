import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { KernelAuth } from "../src/kernel/auth";
import { subscribe } from "../src/dossier/service";
import { mapConfigFrom } from "../src/explore/map-config";
import type { AppliedOp } from "@reinlab/contracts";

const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 4,
});
const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
// 令牌用真实时间签发：应用里的校验用的是当前时钟。
const now = () => Math.floor(Date.now() / 1000);
const A = randomUUID();
const B = randomUUID();
const dossierA = randomUUID();
const dossierResearch = randomUUID();
const runId = randomUUID();
let app: Awaited<ReturnType<typeof createApp>>;
let cookieA = "";
let cookieB = "";
let tokenA = "";

const headers = (cookie = cookieA, key?: string) => ({
  Cookie: cookie,
  Origin: "http://localhost",
  "X-ReinLab-CSRF": "1",
  "Content-Type": "application/json",
  ...(key ? { "Idempotency-Key": key } : {}),
});

async function issueSession(account: string) {
  const token = randomBytes(32).toString("base64url");
  await admin.query("select reinlab_session_open($1,$2)", [
    account,
    createHash("sha256").update(token).digest("hex"),
  ]);
  return "rl_session=" + token;
}

const ops = async (body: unknown, basis = { key: randomUUID(), cookie: cookieA }) =>
  app.request(`/v1/explore/plans/${dossierA}/ops`, {
    method: "POST",
    headers: headers(basis.cookie, basis.key),
    body: JSON.stringify(body),
  });

const readPlan = async (cookie = cookieA) =>
  (await app.request(`/v1/explore/plans/${dossierA}`, { headers: headers(cookie) })).json();

const addStopOp = (name = "白川旁的石桥") => ({
  op: "stop.add",
  stop: {
    kind: "spot",
    name,
    geometry: { type: "Point", coordinates: [135.78, 35.01] },
    day: "2026-11-15",
    window: { start: "2026-11-15T07:10:00+09:00", end: "2026-11-15T07:50:00+09:00" },
    reason: "清晨逆光",
  },
});

/** 走真实的 /kernel/tool 网关（Agent 的工具在服务端调同一组业务函数）。 */
const tool = async (name: string, args: Record<string, unknown> = {}, run = runId) => {
  const response = await app.request("/kernel/tool", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": auth.issue({ account: A, dossier: dossierA, run }, now()) },
    body: JSON.stringify({ server: "explore", tool: name, args }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name) values($1,'A'),($2,'B')", [A, B]);
  for (const [id, bench, title] of [
    [dossierA, "exploration", "京都秋日旅拍"],
    [dossierResearch, "research", "一篇论文"],
  ] as const)
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,$3,$4,$5)",
      [id, A, bench, title, "/data/dossiers/" + id],
    );
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,'bench-explore','explore',$4,'waiting',1,$5)`,
    [runId, A, dossierA, randomUUID(), JSON.stringify({ query: "帮我排一下京都秋天的旅拍" })],
  );
  cookieA = await issueSession(A);
  cookieB = await issueSession(B);
  tokenA = auth.issue({ account: A, dossier: dossierA, run: runId }, now());
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    kernelTools: { auth, dispatch: async () => ({}) },
    mapConfig: () =>
      mapConfigFrom({
        MAP_PUBLIC_KEY: "public-key",
        MAP_SATELLITE_TILEJSON: "https://tiles.example/satellite.json",
        MAP_CONTOURS_TILEJSON: "https://tiles.example/contours.json",
      }),
  });
}, 40_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("探索台页面接口", () => {
  it("第一次打开就有一份草稿计划，返回计划、画布、参考和最后视野", async () => {
    const body = await readPlan();
    expect(body.plan.revision).toBe(1);
    expect(body.plan.state).toBe("draft");
    expect(body.plan.stops).toEqual([]);
    expect(body.canvas).toEqual([]);
    // 参考图还没接通：如实给空，不拿示例顶。
    expect(body.refs).toEqual([]);
    expect(body.lastViewport).toBeNull();
    expect(body.basemap).toBe("vector");
  });

  it("别的账户看不到这份计划；非探索档案没有旅拍计划", async () => {
    const denied = await app.request(`/v1/explore/plans/${dossierA}`, { headers: headers(cookieB) });
    expect([403, 404]).toContain(denied.status);
    const wrong = await app.request(`/v1/explore/plans/${dossierResearch}`, { headers: headers(cookieA) });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe("BENCH_UNSUPPORTED");
  });

  it("加一个候选停留点：修订 +1，返回权威结果并推 explore.op", async () => {
    const seen: any[] = [];
    const stop = subscribe(A, "exploration", (event) => seen.push(event));
    try {
      const response = await ops({ baseRevision: 1, ops: [addStopOp()] });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.revision).toBe(2);
      expect(body.pending).toBeNull();
      const applied = body.applied as AppliedOp[];
      expect(applied).toHaveLength(1);
      expect(applied[0].summary).toBe("添加候选机位「白川旁的石桥」");
      const created = applied[0].result.stop!;
      expect(created.state).toBe("candidate");
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

      const plan = await readPlan();
      expect(plan.plan.revision).toBe(2);
      expect(plan.plan.stops.map((row: any) => row.name)).toEqual(["白川旁的石桥"]);

      const op = seen.find((event) => event.type === "explore.op");
      expect(op?.revision).toBe(2);
      expect(op?.applied[0].summary).toBe("添加候选机位「白川旁的石桥」");
    } finally {
      stop();
    }
  });

  it("修订对不上就 409，并给出最新修订，不覆盖别人的修改", async () => {
    const response = await ops({ baseRevision: 1, ops: [addStopOp("旧画面上的点")] });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("REVISION_CONFLICT");
    expect(body.revision).toBe(2);
    const plan = await readPlan();
    expect(plan.plan.stops).toHaveLength(1);
  });

  it("一批里有一条不成立就整批不生效", async () => {
    const before = await readPlan();
    const response = await ops({
      baseRevision: before.plan.revision,
      ops: [addStopOp("银阁寺"), { op: "stop.remove", id: randomUUID() }],
    });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("STOP_NOT_FOUND");
    const after = await readPlan();
    expect(after.plan.revision).toBe(before.plan.revision);
    expect(after.plan.stops).toHaveLength(1);
  });

  it("view.save 只记最后视野：不加修订、不出现在 applied", async () => {
    const before = await readPlan();
    const response = await ops({
      baseRevision: before.plan.revision,
      ops: [
        {
          op: "view.save",
          viewport: { center: [135.78, 35.01], zoom: 15, bearing: 12, pitch: 0 },
          basemap: "satellite",
        },
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.revision).toBe(before.plan.revision);
    expect(body.applied).toEqual([]);
    const after = await readPlan();
    expect(after.lastViewport.zoom).toBe(15);
    expect(after.basemap).toBe("satellite");
  });

  it("拖动视野时页面传 baseRevision:-1（不关心修订）也能存下最后视野", async () => {
    const response = await ops({
      baseRevision: -1,
      ops: [
        {
          op: "view.save",
          viewport: { center: [135.79, 35.02], zoom: 16, bearing: 0, pitch: 0 },
          basemap: "vector",
        },
      ],
    });
    expect(response.status).toBe(200);
    expect((await readPlan()).lastViewport.zoom).toBe(16);
  });

  it("确认整份计划要先有时区；设好之后进入待执行，所有停留点转正", async () => {
    const plan = await readPlan();
    const missing = await ops({ baseRevision: plan.plan.revision, ops: [{ op: "plan.confirm" }] });
    expect(missing.status).toBe(409);
    expect((await missing.json()).code).toBe("TIMEZONE_REQUIRED");

    const settings = await app.request("/v1/account/settings", {
      method: "PUT",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ timezone: "Asia/Tokyo" }),
    });
    expect(settings.status).toBe(200);
    expect(
      await (await app.request("/v1/account/settings", { headers: headers(cookieA) })).json(),
    ).toEqual({ timezone: "Asia/Tokyo" });

    const current = await readPlan();
    const confirmed = await ops({ baseRevision: current.plan.revision, ops: [{ op: "plan.confirm" }] });
    expect(confirmed.status).toBe(200);
    const body = await confirmed.json();
    expect(body.revision).toBe(current.plan.revision + 1);
    const after = await readPlan();
    expect(after.plan.state).toBe("ready");
    expect(after.plan.stops.every((row: any) => row.state === "confirmed")).toBe(true);
  });

  it("Helper 不能靠补丁把服务端字段改掉", async () => {
    const plan = await readPlan();
    const stopId = plan.plan.stops[0].id;
    const response = await ops({
      baseRevision: plan.plan.revision,
      ops: [{ op: "stop.update", id: stopId, patch: { name: "改名", state: "candidate", source: "agent" } }],
    });
    expect(response.status).toBe(200);
    const after = await readPlan();
    expect(after.plan.stops[0].name).toBe("改名");
    // 状态只能经 plan.confirm / stop.confirm 改变，patch 里的 state 不认。
    expect(after.plan.stops[0].state).toBe("confirmed");
    expect(after.plan.stops[0].source).toBe("user");
  });

  it("地图公开配置：矢量源默认 OpenFreeMap（免 key），卫星/等高线缺配置就置空并列缺项", async () => {
    const configured = await (await app.request("/v1/explore/map-config", { headers: headers(cookieA) })).json();
    expect(configured.publicKey).toBe("public-key");
    expect(configured.satellite.tilejson).toBe("https://tiles.example/satellite.json");
    expect(configured.contours.tilejson).toBe("https://tiles.example/contours.json");
    expect(configured.vector.tilejson).toContain("openfreemap.org");
    // 缺配置时不编造地址：卫星和等高线为 null，并列明缺哪几项。
    const empty = mapConfigFrom({});
    expect(empty.publicKey).toBeNull();
    expect(empty.satellite).toBeNull();
    expect(empty.contours).toBeNull();
    expect(empty.vector.tilejson).toContain("openfreemap.org");
    expect(empty.missing).toEqual(["MAP_SATELLITE_TILEJSON", "MAP_CONTOURS_TILEJSON", "MAP_PUBLIC_KEY"]);
  });
});

describe("探索台 Agent 工具", () => {
  it("读计划时带 stopIds，方便对话里按 id 显示候选卡", async () => {
    const { status, body } = await tool("get");
    expect(status).toBe(200);
    expect(body.result.plan.state).toBe("ready");
    expect(body.result.stopIds).toHaveLength(1);
  });

  it("助手要删已确认停留点、用户没说 → 出一张计划修改卡，计划不动", async () => {
    const before = await readPlan();
    const stopId = before.plan.stops[0].id;
    const { status, body } = await tool("ops", { ops: [{ op: "stop.remove", id: stopId }] });
    expect(status).toBe(409);
    expect(body.state).toBe("pending");
    expect(body.pending.changes[0]).toMatchObject({ stopId, after: null });
    expect(body.pending.summary).toContain("删掉");
    const after = await readPlan();
    // 待批就是待批：停留点还在，修订不变。
    expect(after.plan.stops).toHaveLength(1);
    expect(after.plan.revision).toBe(before.plan.revision);
    const card = (
      await admin.query("select state,effects from approval where id=$1", [body.approvalId])
    ).rows[0];
    expect(card.state).toBe("pending");
    expect(card.effects[0].kind).toBe("explore.planChange");
  });

  it("用户在对话里说「删掉南禅寺」→ 直接执行，不再出卡（同一句话只能用一次）", async () => {
    // 助手先加一个候选，再让用户明确要求确认它。
    const added = await tool("ops", {
      ops: [
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "南禅寺水路阁",
            geometry: { type: "Point", coordinates: [135.79, 35.01] },
            day: "2026-11-15",
          },
        },
      ],
    });
    expect(added.status).toBe(200);
    const created = (added.body.result.applied as AppliedOp[])[0].result.stop!;
    const message = await admin.query(
      `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
       values($1,$2,$3,'dsh','user/message',$4,$5) returning seq`,
      [
        A,
        dossierA,
        runId,
        JSON.stringify({
          id: "msg-1",
          content: [{ type: "text", text: "把南禅寺水路阁留下，这次就它了" }],
        }),
        "test-msg-1",
      ],
    );
    expect(message.rowCount).toBe(1);

    const confirmed = await tool("ops", { ops: [{ op: "stop.confirm", ids: [created.id] }] });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.result.pending).toBeNull();
    const plan = await readPlan();
    expect(plan.plan.stops.find((row: any) => row.id === created.id).state).toBe("confirmed");

    // 同一句话不能再用一次：再要改已确认的点就回到卡。
    const again = await tool("ops", {
      ops: [{ op: "stop.update", id: created.id, patch: { window: null } }],
    });
    expect(again.status).toBe(409);
    expect(again.body.state).toBe("pending");
  });

  it("助手撤回自己最近一笔画布改动；用户能撤回助手画的", async () => {
    const drawn = await tool("ops", {
      ops: [
        {
          op: "canvas.add",
          object: {
            kind: "area",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [135.78, 35.01],
                  [135.79, 35.01],
                  [135.79, 35.02],
                  [135.78, 35.01],
                ],
              ],
            },
            text: "白川附近街区",
          },
        },
      ],
    });
    expect(drawn.status).toBe(200);
    const plan = await readPlan();
    expect(plan.canvas).toHaveLength(1);

    const undone = await tool("undo");
    expect(undone.status).toBe(200);
    expect((undone.body.result.applied as AppliedOp[])[0].summary).toContain("撤回：");
    const after = await readPlan();
    expect(after.canvas).toHaveLength(0);
  });

  it("撤回只动画布：不碰正式停留点，也不会把停留点改动一起撤掉", async () => {
    const plan = await readPlan();
    const stopId = plan.plan.stops[0].id;
    // 只改停留点（页面的修改会记一笔），此时没有任何画布改动可撤。
    const edited = await ops({
      baseRevision: plan.plan.revision,
      ops: [{ op: "stop.update", id: stopId, patch: { reason: "早晨人少" } }],
    });
    expect(edited.status).toBe(200);
    const undo = await ops({ baseRevision: (await readPlan()).plan.revision, ops: [{ op: "canvas.undo" }] });
    expect(undo.status).toBe(409);
    expect((await undo.json()).code).toBe("NOTHING_TO_UNDO");
    expect((await readPlan()).plan.stops[0].reason).toBe("早晨人少");
  });

  it("移视野推 explore.camera，不改修订", async () => {
    const seen: any[] = [];
    const stop = subscribe(A, "exploration", (event) => seen.push(event));
    try {
      const before = await readPlan();
      const moved = await tool("view", {
        viewport: { center: [135.8, 35.02], zoom: 16, bearing: 0, pitch: 0 },
      });
      expect(moved.status).toBe(200);
      const camera = seen.find((event) => event.type === "explore.camera");
      expect(camera?.viewport.zoom).toBe(16);
      const after = await readPlan();
      expect(after.plan.revision).toBe(before.plan.revision);
    } finally {
      stop();
    }
  });

  it("批准计划修改卡之后才生效", async () => {
    const before = await readPlan();
    const stopId = before.plan.stops[0].id;
    const request = await tool("ops", {
      ops: [{ op: "stop.update", id: stopId, patch: { window: null } }],
    });
    expect(request.status).toBe(409);
    const approvalId = request.body.approvalId as string;

    const decided = await app.request(`/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ decision: "approve", scope: "once" }),
    });
    expect(decided.status).toBe(200);
    expect((await decided.json()).state).toBe("approved");
    const after = await readPlan();
    expect(after.plan.stops[0].window).toBeNull();
    expect(after.plan.revision).toBe(before.plan.revision + 1);
  });

  it("计划在等待期间被改过，旧卡不再适用，也不会覆盖", async () => {
    const before = await readPlan();
    const stopId = before.plan.stops[0].id;
    const request = await tool("ops", {
      ops: [{ op: "stop.update", id: stopId, patch: { reason: "助手想改理由" } }],
    });
    // 理由不在受保护字段里，直接生效；换一个受保护的时窗来造卡。
    const guarded = await tool("ops", {
      ops: [{ op: "stop.update", id: stopId, patch: { day: "2026-11-16" } }],
    });
    expect(guarded.status).toBe(409);
    const approvalId = guarded.body.approvalId as string;
    // 用户自己在页面上先改了日期：卡里的内容就过期了。
    const current = await readPlan();
    await ops({
      baseRevision: current.plan.revision,
      ops: [{ op: "stop.update", id: stopId, patch: { day: "2026-11-17" } }],
    });
    const decided = await app.request(`/v1/approvals/${approvalId}/decide`, {
      method: "POST",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ decision: "approve", scope: "once" }),
    });
    expect(decided.status).toBe(200);
    expect((await decided.json()).state).toBe("stale");
    const after = await readPlan();
    expect(after.plan.stops[0].day).toBe("2026-11-17");
  });

  it("别处改了计划，这张卡仍然适用（只核对目标，不是核对修订号）", async () => {
    const before = await readPlan();
    const stopId = before.plan.stops[0].id;
    const card = await tool("ops", { ops: [{ op: "stop.update", id: stopId, patch: { window: null } }] });
    expect(card.status).toBe(409);
    // 期间页面加了另一个无关的候选点：修订 +1，但这张卡的目标没被动过。
    await ops({ baseRevision: (await readPlan()).plan.revision, ops: [addStopOp("顺带拍的河岸")] });
    const decided = await app.request(`/v1/approvals/${card.body.approvalId}/decide`, {
      method: "POST",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ decision: "approve", scope: "once" }),
    });
    expect(decided.status).toBe(200);
    expect((await decided.json()).state).toBe("approved");
    const after = await readPlan();
    expect(after.plan.stops.find((row: any) => row.id === stopId).window).toBeNull();
  });

  it("给草图加一句话也能撤回（反向 patch 不会变成空的）", async () => {
    const drawn = await tool("ops", {
      ops: [
        {
          op: "canvas.add",
          object: {
            kind: "note",
            geometry: { type: "Point", coordinates: [135.78, 35.01] },
          },
        },
      ],
    });
    expect(drawn.status).toBe(200);
    const noteId = (drawn.body.result.applied as AppliedOp[])[0].result.object!.id;
    const edited = await tool("ops", {
      ops: [{ op: "canvas.update", id: noteId, patch: { text: "这里逆光" } }],
    });
    expect(edited.status).toBe(200);
    const undo = await ops({ baseRevision: (await readPlan()).plan.revision, ops: [{ op: "canvas.undo" }] });
    expect(undo.status).toBe(200);
    const after = await readPlan();
    const note = after.canvas.find((row: any) => row.id === noteId);
    expect(note.text).toBeUndefined();
  });

  it("换日期这类计划级改动，一句含糊的话不放行", async () => {
    await admin.query(
      `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
       values($1,$2,$3,'dsh','user/message',$4,$5)`,
      [
        A,
        dossierA,
        runId,
        JSON.stringify({ id: "msg-vague", content: [{ type: "text", text: "改一下理由吧" }] }),
        "test-msg-vague",
      ],
    );
    const request = await tool("ops", { ops: [{ op: "plan.set", patch: { days: ["2026-11-20"] } }] });
    expect(request.status).toBe(409);
    expect(request.body.state).toBe("pending");
    expect((await readPlan()).plan.days).not.toContain("2026-11-20");
  });

  it("助手不能借 token 去改别人的档案", async () => {
    const response = await app.request("/kernel/tool", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.issue({ account: B, dossier: dossierA, run: randomUUID() }, now()),
      },
      body: JSON.stringify({ server: "explore", tool: "get", args: {} }),
    });
    expect([403, 404]).toContain(response.status);
  });
});
