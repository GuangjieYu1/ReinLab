// 创作台页面接口：真 Postgres（含 pgRouting）、真事务、真事件流。
// 覆盖：快照、操作批次与修订、REVISION_STALE、轨迹（真路网算路）、改造层、
// 检查与修法、版本、OSM / Azgaar 导入、幂等重放、跨账户隔离。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import type { OverpassTransport } from "../src/creative/network";

const admin = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 4,
});
const A = randomUUID();
const B = randomUUID();
const dossierA = randomUUID();
const dossierResearch = randomUUID();
let app: Awaited<ReturnType<typeof createApp>>;
let cookieA = "";
let cookieB = "";

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

/** 两块城之间一条三段的路：节点 11 → 12 → 13 → 14。 */
const ways = [
  { type: "way", id: 100, nodes: [11, 12], geometry: [{ lon: 118.5, lat: 36.7 }, { lon: 118.8, lat: 36.85 }], tags: { highway: "primary", name: "官道" } },
  { type: "way", id: 101, nodes: [12, 13], geometry: [{ lon: 118.8, lat: 36.85 }, { lon: 119.0, lat: 37.0 }], tags: { highway: "primary", name: "官道" } },
  { type: "way", id: 102, nodes: [13, 14], geometry: [{ lon: 119.0, lat: 37.0 }, { lon: 119.2, lat: 37.1 }], tags: { highway: "primary", name: "官道" } },
];

let overpassCalls = 0;
const overpass: OverpassTransport = async (_url, body) => {
  overpassCalls += 1;
  const query = decodeURIComponent(body.replace(/^data=/, ""));
  const payload = query.includes("out count")
    ? { elements: [{ type: "count", tags: { ways: String(ways.length) } }] }
    : { elements: ways };
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};

const api = async (path: string, init: RequestInit = {}, cookie = cookieA) =>
  app.request(path, { ...init, headers: { ...headers(cookie), ...(init.headers ?? {}) } });

const ops = async (body: unknown, cookie = cookieA, key = randomUUID()) =>
  api(`/v1/creative/worlds/${dossierA}/ops`, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": key } }, cookie);

const snapshot = async (cookie = cookieA) => (await api(`/v1/creative/worlds/${dossierA}`, {}, cookie)).json();

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name) values($1,'A'),($2,'B')", [A, B]);
  for (const [id, bench, title] of [
    [dossierA, "creative", "旧河道考"],
    [dossierResearch, "research", "一篇论文"],
  ] as const)
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,$3,$4,$5)",
      [id, A, bench, title, "/data/dossiers/" + id],
    );
  cookieA = await issueSession(A);
  cookieB = await issueSession(B);
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    kernelTools: { auth: { issue: (() => "t") as never, verify: (() => ({ account: A, dossier: dossierA, run: randomUUID() })) as never }, dispatch: async () => ({}) },
    creativeOverpass: overpass,
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
});

const placeOp = (name: string, coordinates: [number, number], level = "city") => ({
  op: "entity.add",
  entity: {
    kind: "place",
    name,
    aliases: [],
    place: { level, parentId: null, geo: { type: "Point", coordinates }, geoCertainty: "exact", connects: [] },
  },
});

describe("创作台页面接口", () => {
  it("第一次打开就有一份空世界观：修订 1、默认交通方式、时间轴为空", async () => {
    const body = await snapshot();
    expect(body.world.revision).toBe(1);
    expect(body.world.title).toBe("旧河道考");
    expect(body.world.timeSpan).toBeNull();
    expect(body.world.network.state).toBe("none");
    expect(body.entities).toEqual([]);
    expect(body.modes.map((mode: { id: string }) => mode.id)).toContain("walk");
    expect(body.check).toBeNull();
    expect(body.cursor).toBe(0);
    expect(body.proposals).toEqual([]);
  });

  it("别的账户看不到；非创作档案没有世界观", async () => {
    const denied = await api(`/v1/creative/worlds/${dossierA}`, {}, cookieB);
    expect([403, 404]).toContain(denied.status);
    const wrong = await api(`/v1/creative/worlds/${dossierResearch}`);
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe("BENCH_UNSUPPORTED");
  });

  it("建人物、地点、事件：一个批次原子提交，修订 +1，推 creative.op 与 creative.check", async () => {
    const response = await ops({
      baseRevision: 1,
      ops: [
        placeOp("青州城", [118.5, 36.7]),
        placeOp("清河镇", [119.2, 37.1]),
        { op: "entity.add", entity: { kind: "person", name: "张三", aliases: [], person: {} } },
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.revision).toBe(2);
    expect(body.applied).toHaveLength(3);
    expect(body.applied[0].summary).toContain("青州城");
    expect(body.check.revision).toBe(2);

    const after = await snapshot();
    expect(after.entities).toHaveLength(3);
    const zhang = after.entities.find((item: { name: string }) => item.name === "张三");
    const qingzhou = after.entities.find((item: { name: string }) => item.name === "青州城");
    const qinghe = after.entities.find((item: { name: string }) => item.name === "清河镇");
    const events = await ops({
      baseRevision: 2,
      ops: [
        {
          op: "event.add",
          event: {
            title: "出发", what: "动身", kind: "stay",
            participants: [{ entityId: zhang.id, as: "actor" }],
            placeId: qingzhou.id, travel: null, narrative: "fact",
            start: { input: "1684-04-21 08:00" }, end: { input: "1684-04-21 09:00" },
          },
        },
        {
          op: "event.add",
          event: {
            title: "进城", what: "到镇上", kind: "stay",
            participants: [{ entityId: zhang.id, as: "actor" }],
            placeId: qinghe.id, travel: { fromId: qingzhou.id, toId: qinghe.id, modeId: "walk" }, narrative: "fact",
            start: { input: "1684-04-21 10:00" }, end: { input: "1684-04-21 12:00" },
          },
        },
      ],
    });
    expect(events.status).toBe(200);
    const eventBody = await events.json();
    expect(eventBody.revision).toBe(3);
    expect(eventBody.check.insufficient.some((item: { gaps: string[] }) => item.gaps.length > 0)).toBe(true);
  });

  it("baseRevision 落后就回 409 REVISION_STALE，并带最新快照", async () => {
    const stale = await ops({ baseRevision: 1, ops: [placeOp("第三个地方", [118.9, 36.9])] });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe("REVISION_STALE");
    expect(body.revision).toBeGreaterThan(1);
    expect(body.snapshot.world.revision).toBe(body.revision);
  });

  it("同一个幂等键重放不重复记账", async () => {
    const key = randomUUID();
    const payload = { baseRevision: (await snapshot()).world.revision, ops: [placeOp("重放测试", [118.6, 36.8])] };
    const first = await ops(payload, cookieA, key);
    const second = await ops(payload, cookieA, key);
    expect(await first.json()).toEqual(await second.json());
    const after = await snapshot();
    expect(after.entities.filter((item: { name: string }) => item.name === "重放测试")).toHaveLength(1);
  });

  it("导入一块 OSM 区域：真 pgRouting 边表，导完状态 ready，推 creative.network", { timeout: 40_000 }, async () => {
    const response = await api(`/v1/creative/worlds/${dossierA}/network/import`, {
      method: "POST",
      body: JSON.stringify({ source: "osm", bbox: [118.5, 36.7, 119.0, 37.2] }),
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(response.status).toBe(202);
    expect((await response.json()).jobId).toBeTruthy();
    // 异步导入：等状态落到 ready。
    let state = "";
    let last: any = null;
    for (let index = 0; index < 120 && state !== "ready" && state !== "failed"; index += 1) {
      await new Promise((done) => setTimeout(done, 150));
      last = await snapshot();
      state = last.world.network.state;
    }
    if (state !== "ready") console.error("NETWORK_IMPORT_DEBUG", JSON.stringify(last.world.network));
    expect(state).toBe("ready");
    // 一次取全（不再先数一遍）：公共实例很慢，两趟等于双倍等待。
    expect(overpassCalls).toBeGreaterThanOrEqual(1);
    const after = await snapshot();
    expect(after.world.network.sources[0].kind).toBe("osm");
    expect(after.world.network.sources[0].edges).toBeGreaterThanOrEqual(3);
  });

  it("轨迹沿真实路网走：leg 是 network，点数是三段路拼出来的，不是直线", async () => {
    const body = await snapshot();
    const leg = body.legs.find((item: { fromEventId: string }) => item.kind === "network");
    expect(leg).toBeTruthy();
    expect(leg.path.type).toBe("LineString");
    expect(leg.path.coordinates.length).toBeGreaterThanOrEqual(4);
    expect(leg.distanceKm).toBeGreaterThan(50);
    expect(leg.durationMin).toBeGreaterThan(0);
    expect(leg.failure).toBeNull();

    const tracks = await (
      await api(`/v1/creative/worlds/${dossierA}/tracks`).valueOf()
    ).json();
    const zhang = body.entities.find((item: { name: string }) => item.name === "张三");
    const track = tracks.tracks.find((item: { entityId: string }) => item.entityId === zhang.id);
    expect(track).toBeTruthy();
    expect(track.spans.map((span: { kind: string }) => span.kind)).toEqual(
      expect.arrayContaining(["at", "move"]),
    );
    const move = track.spans.find((span: { kind: string }) => span.kind === "move");
    expect(move.routeKind).toBe("network");
    expect(move.legId).toBe(leg.id);
  });

  it("时间不够就报红色赶不到，接受修法后重查消失", async () => {
    let body = await snapshot();
    expect(body.check.conflicts.some((item: { kind: string }) => item.kind === "travel_time")).toBe(true);
    const conflict = body.check.conflicts.find((item: { kind: string }) => item.kind === "travel_time");
    const fix = conflict.fixes[0];
    expect(fix.preview.length).toBeGreaterThan(0);
    const applied = await ops({ baseRevision: body.world.revision, ops: fix.ops });
    expect(applied.status).toBe(200);
    const result = await applied.json();
    expect(result.check.conflicts.some((item: { kind: string }) => item.kind === "travel_time")).toBe(false);
    // 修法之后再手动全部重查，结论一致。
    const manual = await api(`/v1/creative/worlds/${dossierA}/check`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(manual.status).toBe(200);
    const check = await manual.json();
    expect(check.conflicts.some((item: { kind: string }) => item.kind === "travel_time")).toBe(false);
    expect(check.clean).toContain("travel_time");
    body = await snapshot();
    expect(body.check.conflicts.some((item: { kind: string }) => item.kind === "travel_time")).toBe(false);
  });

  it("改造层按故事时间生效：封路以后同一段路算不出来了", async () => {
    const body = await snapshot();
    const qingzhou = body.entities.find((item: { name: string }) => item.name === "青州城");
    const event = body.events.find((item: { title: string }) => item.title === "出发");
    const closed = await ops({
      baseRevision: body.world.revision,
      ops: [
        {
          op: "edit.add",
          edit: {
            title: "拆桥封路",
            effect: "passability",
            // 地图瓦片上的 feature.id：way 101 → 1010（floor(1010/10) = 101）。
            target: { osm: { type: "way", id: 1010 } },
            geometry: null,
            passable: { open: false },
            valid: { from: { input: "1684-04-21 07:00" }, to: null },
          },
        },
      ],
    });
    expect(closed.status).toBe(200);
    const after = await snapshot();
    const leg = after.legs.find((item: { id: string }) => item.id === after.legs[0].id);
    expect(leg.kind).toBe("none");
    expect(leg.failure).toContain("不连通");
    expect(leg.path).toBeNull();

    const geojson = await (
      await api(`/v1/creative/worlds/${dossierA}/edits/geojson?t=${after.events[0].start.t}`)
    ).json();
    expect(geojson.type).toBe("FeatureCollection");
    expect(geojson.features[0].properties.effect).toBe("passability");
    expect(geojson.features[0].properties.osm.id).toBe(1010);
    // 拆桥生效以前（比如前一晚）这条路还在。
    const early = await (
      await api(`/v1/creative/worlds/${dossierA}/edits/geojson?t=${after.events[0].start.t - 200}`)
    ).json();
    expect(early.features).toEqual([]);
    void qingzhou;
    void event;
  });

  it("路由算不出来时 AI 推断路线没开也要明确回缺口，不伪造路线", async () => {
    const body = await snapshot();
    const leg = body.legs.find((item: { kind: string }) => item.kind === "none");
    expect(leg).toBeTruthy();
    expect(leg.path).toBeNull();
    // 没配模型通道：什么都不发生，但「路线待定」必须在信息不足里。
    expect(
      body.check.insufficient.some((item: { gaps: string[] }) => item.gaps.some((text) => text.includes("路线待定"))),
    ).toBe(true);
  });

  it("改造层里的新增古道按故事时间生效，算路重新走通", async () => {
    const body = await snapshot();
    const closed = body.edits.find((item: { effect: string }) => item.effect === "passability");
    // 同一时刻把封路撤掉，再加一条绕行的古道。
    const label = (await ops({
      baseRevision: body.world.revision,
      ops: [
        { op: "edit.update", id: closed.id, patch: { valid: { from: { input: "1684-04-21 07:00" }, to: { input: "1684-04-20 07:00" } } } },
        {
          op: "edit.add",
          edit: {
            title: "新修古道",
            effect: "add",
            target: null,
            geometry: {
              type: "LineString",
              coordinates: [[118.8, 36.85], [118.9, 36.95], [119.0, 37.0]],
            },
            props: { name: "翻山古道", style: "ancient_road" },
            passable: { open: true },
            valid: { from: null, to: null },
          },
        },
      ],
    })).status;
    expect(label).toBe(200);
    const after = await snapshot();
    expect(after.edits.some((item: { title: string }) => item.title === "新修古道")).toBe(true);
    const edgeCount = (
      await admin.query("select count(*)::int n from creative_edge where dossier_id=$1 and kind='edit'", [dossierA])
    ).rows[0].n;
    expect(edgeCount).toBeGreaterThanOrEqual(2);
  });

  it("上传 Azgaar 的 Routes GeoJSON 再导入：坐标已经是经纬度，边表按 azgaar 记", { timeout: 40_000 }, async () => {
    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[118.4, 36.6], [118.7, 36.8], [119.1, 37.05]] },
          properties: { id: 7, group: "roads", name: "商路" },
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: [[119.1, 37.05], [119.25, 37.15]] },
          properties: { id: 8, group: "trails", name: "山道" },
        },
      ],
    };
    const upload = await api(`/v1/creative/worlds/${dossierA}/assets`, {
      method: "POST",
      body: JSON.stringify({ name: "azgaar-routes.geojson", content: JSON.stringify(geojson), format: "geojson" }),
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(upload.status).toBe(201);
    const { assetId } = await upload.json();
    const imported = await api(`/v1/creative/worlds/${dossierA}/network/import`, {
      method: "POST",
      body: JSON.stringify({ source: "azgaar", assetId }),
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(imported.status).toBe(202);
    let state = "";
    for (let index = 0; index < 120 && state !== "ready" && state !== "failed"; index += 1) {
      await new Promise((done) => setTimeout(done, 150));
      state = (await snapshot()).world.network.state;
    }
    const azgaarEdges = (
      await admin.query("select count(*)::int n from creative_edge where dossier_id=$1 and kind='azgaar'", [dossierA])
    ).rows[0].n;
    expect(azgaarEdges).toBe(3);
    const after = await snapshot();
    expect(after.world.network.sources.some((item: { kind: string }) => item.kind === "azgaar")).toBe(true);
  });

  it("路网几何接口：只读、按 bbox 过滤（1A 遗留 4）", async () => {
    const all = await api(`/v1/creative/worlds/${dossierA}/network/geojson`);
    expect(all.status).toBe(200);
    const collection = await all.json();
    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features.length).toBeGreaterThanOrEqual(3);
    const feature = collection.features[0];
    expect(feature.type).toBe("Feature");
    expect(feature.geometry.type).toBe("LineString");
    expect(feature.geometry.coordinates.length).toBe(2);
    expect(feature.properties.kind).toBe("osm");
    expect(feature.properties.roadClass).toBe("primary");

    const part = await api(`/v1/creative/worlds/${dossierA}/network/geojson?bbox=118.4,36.6,118.85,36.9`);
    expect(part.status).toBe(200);
    const partBody = await part.json();
    expect(partBody.features.length).toBeLessThan(collection.features.length);
    expect(partBody.features.some((item: any) => item.properties.kind === "osm")).toBe(true);

    const wrong = await api(`/v1/creative/worlds/${dossierA}/network/geojson?bbox=119,36,118,35`);
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe("INVALID_INPUT");
  });

  it("卡在「导入中」的路网，控制面重启后第一次打开就改成失败（1A 遗留 3）", async () => {
    await admin.query(
      `update creative_world
          set document = jsonb_set(jsonb_set(document, '{network,state}', '"importing"'),
                                   '{networkUpdatedAt}', to_jsonb(($2::timestamptz)::text))
        where dossier_id = $1`,
      [dossierA, new Date(Date.now() - 3600_000).toISOString()],
    );
    const after = await snapshot();
    expect(after.world.network.state).toBe("failed");
    expect(after.world.network.error).toContain("导入中断");
    // 事件流里要能看到这条变化
    const events = await admin.query(
      "select data from creative_event where dossier_id=$1 and type='creative.network' order by seq desc limit 1",
      [dossierA],
    );
    expect(events.rows[0]?.data?.error).toContain("导入中断");

    // 再打开一次不会反复改
    const again = await snapshot();
    expect(again.world.network.state).toBe("failed");
  });

  it("存版本、取历史版本；刷新以后记录还在", async () => {
    const body = await snapshot();
    const saved = await api(`/v1/creative/worlds/${dossierA}/versions`, {
      method: "POST",
      body: JSON.stringify({ summary: "第一版设定" }),
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(saved.status).toBe(201);
    const version = await saved.json();
    expect(version.n).toBe(1);
    expect(version.summary).toBe("第一版设定");

    const list = await snapshot();
    expect(list.versions).toHaveLength(1);
    expect(list.world.version.latest).toBe(1);
    expect(list.world.version.draftChanges).toBeGreaterThanOrEqual(0);

    const history = await (await api(`/v1/creative/worlds/${dossierA}?version=1`)).json();
    // 历史快照带的是存版本那一刻的修订号，不是版本号本身。
    expect(history.world.revision).toBeGreaterThan(1);
    expect(history.entities).toHaveLength(body.entities.length);
    expect(history.check).toBeNull();

    const missing = await api(`/v1/creative/worlds/${dossierA}?version=99`);
    expect(missing.status).toBe(404);
  });

  it("事件流能按 cursor 续订（页面断线重连用）", async () => {
    const body = await snapshot();
    const first = await admin.query(
      "select seq::text seq, type from creative_event where dossier_id=$1 order by seq limit 1",
      [dossierA],
    );
    expect(first.rowCount).toBe(1);
    expect(Number(first.rows[0].seq)).toBeLessThanOrEqual(body.cursor);
    const types = await admin.query(
      "select distinct type from creative_event where dossier_id=$1",
      [dossierA],
    );
    const seen = types.rows.map((row) => row.type);
    expect(seen).toEqual(expect.arrayContaining(["creative.op", "creative.check", "creative.network"]));
  });

  it("删除还被引用的实体回 409 IN_USE 并说明引用在哪", async () => {
    const body = await snapshot();
    const place = body.entities.find((item: { name: string }) => item.name === "青州城");
    const response = await ops({ baseRevision: body.world.revision, ops: [{ op: "entity.remove", id: place.id }] });
    expect(response.status).toBe(409);
    const failure = await response.json();
    expect(failure.code).toBe("IN_USE");
    expect(failure.message).toContain("青州城");
  });

  it("改一处只动这一处：别处还在的冲突不能被批次检查冲掉", async () => {
    let body = await snapshot();
    const qingzhou = body.entities.find((item: { name: string }) => item.name === "青州城");
    const qinghe = body.entities.find((item: { name: string }) => item.name === "清河镇");
    const add = await ops({ baseRevision: body.world.revision, ops: [{ op: "entity.add", entity: { kind: "person", name: "李四", aliases: [], person: {} } }] });
    expect(add.status).toBe(200);
    body = await snapshot();
    const li = body.entities.find((item: { name: string }) => item.name === "李四");
    const at = (title: string, placeId: string, start: string, end: string) => ({
      op: "event.add",
      event: { title, what: "", kind: "stay", participants: [{ entityId: li.id, as: "actor" }], placeId, travel: null, narrative: "fact", start: { input: start }, end: { input: end } },
    });
    const made = await ops({ baseRevision: body.world.revision, ops: [
      at("李四在城里", qingzhou.id, "1684-06-01 08:00", "1684-06-01 12:00"),
      at("李四在镇上", qinghe.id, "1684-06-01 09:00", "1684-06-01 11:00"),
      at("李四另一天", qingzhou.id, "1684-07-01 08:00", "1684-07-01 09:00"),
    ] });
    expect(made.status).toBe(200);
    expect((await made.json()).check.conflicts.some((item: { kind: string }) => item.kind === "double_location")).toBe(true);
    body = await snapshot();
    const other = body.events.find((item: { title: string }) => item.title === "李四另一天");
    // 只改一条和冲突无关的事件：返回的、存下的检查都还得有那条同时异地
    const touched = await ops({ baseRevision: body.world.revision, ops: [{ op: "event.update", id: other.id, patch: { what: "改个说明" } }] });
    expect(touched.status).toBe(200);
    expect((await touched.json()).check.conflicts.some((item: { kind: string }) => item.kind === "double_location")).toBe(true);
    expect((await snapshot()).check.conflicts.some((item: { kind: string }) => item.kind === "double_location")).toBe(true);
  });

  it("OSM 范围超过单块上限当场 422，不去查 Overpass", async () => {
    const before = overpassCalls;
    const response = await api(`/v1/creative/worlds/${dossierA}/network/import`, {
      method: "POST",
      body: JSON.stringify({ source: "osm", bbox: [73, 18, 135, 54] }),
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("NETWORK_BBOX_TOO_LARGE");
    expect(overpassCalls).toBe(before);
  });
});
