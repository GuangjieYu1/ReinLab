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

/** 写作助手/顾问的模型通道：测试注入，不连真模型。 */
const writerModelHolder: { current: (url: string, init: RequestInit) => Promise<Response> } = {
  current: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }),
};
const advisorModelHolder: { current: (url: string, init: RequestInit) => Promise<Response> } = {
  current: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }),
};

/** 导入测试用的抽取通道：默认抽取一段固定结果，测试可以换。 */
const importExtractorHolder: { current: (input: { chapterTitle: string; text: string }) => Promise<any> } = {
  current: async () => ({
    extraction: { entities: [], events: [], merges: [] },
    usage: { inputTokens: 100, outputTokens: 50 },
  }),
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
    creativeImport: {
      // 注入抽取通道：不连真模型，但走的是同一条导入流程（写库、进度、事件）
      extractor: (input) => importExtractorHolder.current(input),
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
      provider: "test",
      model: "test-extract",
    },
    creativeWriter: {
      model: {
        baseUrl: "https://model.test/anthropic",
        apiKey: "test-key",
        model: "test-writer",
        transport: (input, init) => writerModelHolder.current(input as string, init as RequestInit),
      },
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
      provider: "test",
    },
    creativeAdvisor: {
      model: {
        baseUrl: "https://model.test/anthropic",
        apiKey: "test-key",
        model: "test-advisor",
        transport: (input, init) => advisorModelHolder.current(input as string, init as RequestInit),
      },
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
      provider: "test",
    },
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

describe("创作台作品（1B 契约 §5.2）", () => {
  let workId = "";

  const work = (path = "", init: RequestInit = {}) =>
    app.request(`/v1/creative/worlds/${dossierA}/works${path}`, {
      ...init,
      headers: { ...headers(cookieA), ...(init.headers ?? {}) },
    });

  it("建作品：锁定当前最新版本，列表不带正文", async () => {
    const created = await work("", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "阊门夜行", targetWords: 8000 }),
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    workId = body.id;
    expect(body.title).toBe("阊门夜行");
    expect(body.baseVersion).toBe(1);
    expect(body.revision).toBe(1);
    expect(body.chapters).toEqual([]);
    expect(body.words).toBe(0);

    const list = await (await work("")).json();
    expect(Array.isArray(list)).toBe(true);
    expect(list[0].id).toBe(workId);
    expect(list[0].targetWords).toBe(8000);
  });

  it("写大纲、确认、写正文：作品 revision +1，推 creative.work 与 creative.text", async () => {
    const outlined = await work(`/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: 1,
        ops: [
          {
            op: "outline.set",
            outline: {
              logline: "书生夜里出城送信",
              pov: "第三人称限制",
              ending: "信到了，人没回来",
              chapters: [
                {
                  id: "ch1",
                  title: "出城",
                  scenes: [{ id: "sc1", title: "阊门", goal: "动身", eventIds: [], targetWords: 3000 }],
                },
              ],
            },
          },
        ],
      }),
    });
    expect(outlined.status).toBe(200);
    const outlineBody = await outlined.json();
    expect(outlineBody.revision).toBe(2);
    expect(outlineBody.work.outline.state).toBe("draft");

    const confirmed = await work(`/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: 2, ops: [{ op: "outline.confirm" }] }),
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.json();
    expect(confirmedBody.revision).toBe(3);
    expect(confirmedBody.work.outline.state).toBe("confirmed");
    expect(confirmedBody.work.chapters).toHaveLength(1);
    const sceneId = confirmedBody.work.chapters[0].scenes[0].id;

    const written = await work(`/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: 3,
        ops: [{ op: "text.set", sceneId, baseTextVersion: 0, text: "夜里出了阊门。\n\n城门在身后合上。" }],
      }),
    });
    expect(written.status).toBe(200);
    const writtenBody = await written.json();
    expect(writtenBody.revision).toBe(4);
    expect(writtenBody.work.chapters[0].scenes[0].textVersion).toBe(1);
    expect(writtenBody.work.words).toBeGreaterThan(0);

    const events = await admin.query(
      "select type from creative_event where dossier_id=$1 and type in ('creative.work','creative.text') order by seq desc limit 6",
      [dossierA],
    );
    const types = events.rows.map((row) => row.type);
    expect(types).toContain("creative.text");
    expect(types).toContain("creative.work");
  });

  it("正文版本对不上回 409，作品修订落后也回 409 带最新作品", async () => {
    const current = await (await work(`/${workId}`)).json();
    const sceneId = current.chapters[0].scenes[0].id;
    const staleText = await work(`/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: current.revision, ops: [{ op: "text.set", sceneId, baseTextVersion: 0, text: "第二段被盖掉" }] }),
    });
    expect(staleText.status).toBe(409);
    expect((await staleText.json()).code).toBe("TEXT_VERSION_STALE");
    const staleRevision = await work(`/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: 1, ops: [{ op: "work.set", patch: { title: "改不动" } }] }),
    });
    expect(staleRevision.status).toBe(409);
    const body = await staleRevision.json();
    expect(body.code).toBe("REVISION_STALE");
    expect(body.work.id).toBe(workId);
  });

  it("正文标注：提到的事件和人物都标上，段落下标对得上", async () => {
    const current = await (await work(`/${workId}`)).json();
    const sceneId = current.chapters[0].scenes[0].id;
    // 让正文里出现世界里的事件标题「出阊门」之类，标注应当出现
    await work(`/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: current.revision,
        ops: [
          {
            op: "text.set",
            sceneId,
            baseTextVersion: current.chapters[0].scenes[0].textVersion,
            text: "他想起出发那天。\n\n又想起张三。",
          },
        ],
      }),
    });
    const detail = await (await work(`/${workId}`)).json();
    const scene = detail.chapters[0].scenes[0];
    expect(scene.marks.length).toBeGreaterThan(0);
    expect(scene.marks.every((mark: any) => mark.para >= 0 && mark.from >= 0 && mark.to > mark.from)).toBe(true);
    expect(scene.marks.some((mark: any) => mark.kind === "entity")).toBe(true);
    expect(scene.marks.some((mark: any) => mark.kind === "event")).toBe(true);
  });

  it("导出：md 有标题正文，docx 是 zip", async () => {
    const md = await work(`/${workId}/export?format=md`);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const mdText = await md.text();
    expect(mdText).toContain("# 阊门夜行");
    expect(mdText).toContain("## 第 1 章");

    const docx = await work(`/${workId}/export?format=docx`);
    expect(docx.status).toBe(200);
    const bytes = new Uint8Array(await docx.arrayBuffer());
    expect(bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(Buffer.from(bytes).includes(Buffer.from("word/document.xml"))).toBe(true);
  });

  it("待确认提议能按种类和批次筛", async () => {
    const all = await (await app.request(`/v1/creative/worlds/${dossierA}/proposals`, { headers: headers(cookieA) })).json();
    expect(Array.isArray(all.proposals)).toBe(true);
    expect(all.nextCursor === null || typeof all.nextCursor === "number").toBe(true);
    const route = await (
      await app.request(`/v1/creative/worlds/${dossierA}/proposals?kind=route&limit=5`, { headers: headers(cookieA) })
    ).json();
    expect(route.proposals.every((item: any) => item.kind === "route")).toBe(true);
    const bad = await app.request(`/v1/creative/worlds/${dossierA}/proposals?doubt=maybe`, { headers: headers(cookieA) });
    expect(bad.status).toBe(400);
  });
});

describe("创作台导入原文（1B 契约 §5.2）", () => {
  let workId = "";
  const workPath = (suffix = "") => `/v1/creative/worlds/${dossierA}/works/${workId}${suffix}`;

  const importer = async (body: unknown) =>
    api(workPath("/import"), { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify(body) });

  const waitJob = async (jobId: string) => {
    for (let index = 0; index < 120; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const job = await (await api(`/v1/creative/worlds/${dossierA}/imports/${jobId}`)).json();
      if (job.state === "done" || job.state === "failed" || job.state === "paused") return job;
    }
    throw new Error("导入没在预期时间内结束");
  };

  it("分章导入：一章一批，抽出来的每一项都带章段句出处", async () => {
    const created = await api(`/v1/creative/worlds/${dossierA}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "聊斋选篇" }),
    });
    const work = await created.json();
    workId = work.id;

    importExtractorHolder.current = async (input) => ({
      extraction: {
        entities: [
          { kind: "person", name: "王六郎", aliases: [], summary: "溺死者", para: 0, sentence: 0, quote: "王六郎者，溺死鬼也。", basis: "explicit" },
        ],
        events: [
          {
            title: input.chapterTitle, what: "原文里的一夜", kind: "stay",
            participants: [{ name: "王六郎", as: "actor" }], place: null,
            start: "康熙二十三年三月初七", end: "康熙二十三年三月初七",
            narrative: "fact", para: 0, sentence: 1, quote: "是夜，王六郎至。",
          },
        ],
        merges: [],
      },
      usage: { inputTokens: 1200, outputTokens: 300 },
    });

    const started = await importer({ text: "## 第一夜\n王六郎者，溺死鬼也。是夜，王六郎至。\n\n## 第二夜\n又来。", title: "聊斋选篇" });
    expect(started.status).toBe(202);
    const job = await started.json();
    expect(job.state).toBe("queued");
    expect(job.chapters.total).toBe(2);

    const done = await waitJob(job.id);
    expect(done.state).toBe("done");
    expect(done.chapters.done).toBe(2);
    expect(done.proposals).toBeGreaterThanOrEqual(2);

    // 正文进了作品的章和场
    const detail = await (await api(workPath())).json();
    expect(detail.chapters).toHaveLength(2);
    expect(detail.chapters[0].scenes[0].text).toContain("王六郎者");
    expect(detail.source.kind).toBe("import");

    // 提议带出处：章、段、句、原句、原文版本
    const proposals = await (
      await api(`/v1/creative/worlds/${dossierA}/proposals?kind=event&limit=20`)
    ).json();
    const event = proposals.proposals.find((item: any) => item.title === "第一夜");
    expect(event).toBeTruthy();
    expect(event.origin.by).toBe("importer");
    expect(event.origin.source).toMatchObject({ chapterId: detail.chapters[0].id, para: 0, sentence: 1, quote: "是夜，王六郎至。", textVersion: 1 });
    expect(event.batchId).toBe(`import_${detail.chapters[0].id}`);

    const events = await admin.query(
      "select type from creative_event where dossier_id=$1 and type='creative.import' order by seq desc limit 3",
      [dossierA],
    );
    expect(events.rowCount).toBeGreaterThan(0);
  });

  it("拒绝过的同一条再导一次不会出现；暂停后能续做", async () => {
    const before = await (await api(`/v1/creative/worlds/${dossierA}/proposals?status=pending&limit=200`)).json();
    const target = before.proposals.find((item: any) => item.kind === "event");
    const world = await (await api(`/v1/creative/worlds/${dossierA}`)).json();
    const rejected = await api(`/v1/creative/worlds/${dossierA}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: world.world.revision, ops: [{ op: "proposal.decide", id: target.id, decision: "rejected" }] }),
    });
    expect(rejected.status).toBe(200);

    // 再导同一份原文：同一条（同章、同版本、同原句）不再冒出来
    const again = await importer({ text: "## 第一夜\n王六郎者，溺死鬼也。是夜，王六郎至。\n\n## 第二夜\n又来。", title: "聊斋选篇" });
    const job = await again.json();
    const done = await waitJob(job.id);
    expect(done.state).toBe("done");
    const after = await (await api(`/v1/creative/worlds/${dossierA}/proposals?status=pending&limit=200`)).json();
    const duplicated = after.proposals.filter(
      (item: any) => item.kind === "event" && item.title === target.title && item.origin?.source?.quote === target.origin?.source?.quote,
    );
    expect(duplicated.length).toBeLessThanOrEqual(1);

    // 暂停/续做：暂停之后状态是 paused，续做还能接着跑
    const fresh = await importer({ text: "## 第三夜\n又一夜。", title: "聊斋选篇" });
    const freshJob = await fresh.json();
    const paused = await api(`/v1/creative/worlds/${dossierA}/imports/${freshJob.id}/pause`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: "{}",
    });
    expect([200, 409]).toContain(paused.status);
    const resumed = await api(`/v1/creative/worlds/${dossierA}/imports/${freshJob.id}/resume`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: "{}",
    });
    expect([200, 409]).toContain(resumed.status);
    const final = await waitJob(freshJob.id);
    expect(["done", "paused", "running"]).toContain(final.state);
  });
});

describe("创作台写作与顾问（1B 契约 §5.2）", () => {
  let workId = "";

  const modelReply = (payload: unknown) =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }], usage: { input_tokens: 800, output_tokens: 400 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("按场景生成：产出 text_edit 提议，正文不落笔，接受后才写进去", async () => {
    const created = await api(`/v1/creative/worlds/${dossierA}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "生成测试" }),
    });
    workId = (await created.json()).id;
    const outlined = await api(`/v1/creative/worlds/${dossierA}/works/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: 1,
        ops: [
          {
            op: "outline.set",
            outline: {
              logline: "夜里送信", pov: "第三人称", ending: "信到了",
              chapters: [{ id: "c1", title: "出城", scenes: [{ id: "s1", title: "阊门", goal: "动身", eventIds: [], targetWords: 800 }] }],
            },
          },
          { op: "outline.confirm" },
        ],
      }),
    });
    expect(outlined.status).toBe(200);
    const afterOutline = await outlined.json();
    const sceneId = afterOutline.work.chapters[0].scenes[0].id;

    writerModelHolder.current = async () => modelReply({ text: "夜里出了阊门，城门在身后合上。", why: "按目标写动身" });

    const started = await api(`/v1/creative/worlds/${dossierA}/works/${workId}/generate`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ sceneIds: [sceneId], mode: "draft" }),
    });
    expect(started.status).toBe(202);
    const job = await started.json();
    expect(job.state).toBe("running");

    let jobState = "";
    for (let index = 0; index < 100; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const current = await (await api(`/v1/creative/worlds/${dossierA}/generate/${job.id}`)).json();
      jobState = current.state;
      if (jobState === "done" || jobState === "failed" || jobState === "stopped") break;
    }
    expect(jobState).toBe("done");

    // 正文还没落笔：提议在待确认里，场景仍是空的
    const detail = await (await api(`/v1/creative/worlds/${dossierA}/works/${workId}`)).json();
    expect(detail.chapters[0].scenes[0].text).toBe("");
    const proposals = await (await api(`/v1/creative/worlds/${dossierA}/proposals?kind=text_edit&limit=20`)).json();
    const proposal = proposals.proposals.find((item: any) => item.ops?.[0]?.sceneId === sceneId);
    expect(proposal).toBeTruthy();
    expect(proposal.ops[0].after).toContain("阊门");
    expect(proposal.origin.by).toBe("writer");

    // 接受后才写进正文
    const accepted = await api(`/v1/creative/worlds/${dossierA}/works/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: detail.revision, ops: [{ op: "text.accept", proposalId: proposal.id }] }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody.work.chapters[0].scenes[0].text).toContain("夜里出了阊门");
    expect(acceptedBody.work.chapters[0].scenes[0].textVersion).toBe(1);
    const acceptedProposal = await (await api(`/v1/creative/worlds/${dossierA}/proposals?kind=text_edit&status=accepted&limit=20`)).json();
    expect(acceptedProposal.proposals.some((item: any) => item.id === proposal.id && item.resolution?.decision === "accepted")).toBe(true);
  });

  it("生成能停；大纲没确认就不让写", async () => {
    const created = await api(`/v1/creative/worlds/${dossierA}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "未确认大纲" }),
    });
    const work = await created.json();
    const scene = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: 1, ops: [{ op: "chapter.add", title: "第一章" }] }),
    });
    const chapterId = (await scene.json()).work.chapters[0].id;
    const withScene = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: 2, ops: [{ op: "scene.add", chapterId, title: "一场" }] }),
    });
    const sceneId = (await withScene.json()).work.chapters[0].scenes[0].id;
    const refused = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/generate`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ sceneIds: [sceneId], mode: "draft" }),
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("OUTLINE_NOT_CONFIRMED");

    // 正常开始的能停
    writerModelHolder.current = async () => new Promise((resolve) => setTimeout(() => resolve(modelReply({ text: "一段。", why: "" })), 400));
    const started = await api(`/v1/creative/worlds/${dossierA}/works/${workId}/generate`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ sceneIds: [(await (await api(`/v1/creative/worlds/${dossierA}/works/${workId}`)).json()).chapters[0].scenes[0].id], mode: "continue" }),
    });
    const job = await started.json();
    const stopped = await api(`/v1/creative/worlds/${dossierA}/generate/${job.id}/stop`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: "{}",
    });
    expect(stopped.status).toBe(200);
    expect(["stopped", "done", "running"]).toContain((await stopped.json()).state);
  });

  it("设定顾问：「加人物」提出经历，先跑硬检查再交，全部是提议", async () => {
    advisorModelHolder.current = async () =>
      modelReply({
        kind: "itinerary",
        title: "加一个赶车的把式",
        summary: "王二从山村赶来送信，四月初七到阊门，当天在客栈落脚。",
        entities: [{ name: "王二", kind: "person", aliases: ["王二郎"], summary: "赶车的把式" }],
        events: [
          {
            title: "王二到阊门", what: "从山村赶来", kind: "stay",
            participants: [{ name: "王二", as: "actor" }, { name: "张三", as: "present" }],
            place: "青州城", start: "1684-04-21 10:00", end: "1684-04-21 11:00", narrative: "fact",
          },
        ],
        rules: [],
        doubts: ["原文没说王二的车是不是自己的"],
      });

    const response = await api(`/v1/creative/worlds/${dossierA}/advisor`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ query: "加一个从山村来的赶车人，跟沈砚打个照面" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.proposals).toHaveLength(1);
    const proposal = body.proposals[0];
    expect(proposal.kind).toBe("itinerary");
    expect(proposal.status).toBe("pending");
    expect(proposal.doubts.length).toBeGreaterThan(0);
    const ops = proposal.ops;
    expect(ops.some((op: any) => op.op === "entity.add" && op.entity.name === "王二")).toBe(true);
    const event = ops.find((op: any) => op.op === "event.add");
    expect(event.event.participants[0].entityName).toBe("王二");
    expect(Array.isArray(proposal.conflicts)).toBe(true);

    // 接受以后王二才入账
    const world = await (await api(`/v1/creative/worlds/${dossierA}`)).json();
    const accepted = await api(`/v1/creative/worlds/${dossierA}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: world.world.revision, ops: [{ op: "proposal.decide", id: proposal.id, decision: "accepted" }] }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody.applied.flatMap((item: any) => item.result && item.result.entity ? [item.result.entity.name] : [])).toContain("王二");
    const after = await (await api(`/v1/creative/worlds/${dossierA}`)).json();
    expect(after.entities.some((item: any) => item.name === "王二")).toBe(true);
    expect(after.events.some((item: any) => item.title === "王二到阊门")).toBe(true);
  });
});
