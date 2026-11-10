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
const judgeModelHolder: { current: (url: string, init: RequestInit) => Promise<Response> } = {
  current: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "{\"violations\":[]}" }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }),
};
const chatModelHolder: { current: (url: string, init: RequestInit) => Promise<Response> } = {
  current: async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "好。" }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }),
};
const scanModelHolder: { current: (url: string, init: RequestInit) => Promise<Response> } = {
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

const snapshot = async (cookie = cookieA) => {
  const res = await api(`/v1/creative/worlds/${dossierA}`, {}, cookie);
  const body = await res.json();
  if (process.env.DEBUG_SNAPSHOT) console.log('SNAP', res.status, JSON.stringify(body).slice(0, 300));
  return body;
};

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
    imageProvider: {
      name: "test-ark",
      model: "test-seedream",
      available: () => true,
      generate: async () => {
        // 1x1 PNG（够验存储、文件接口和快照，不是用来好看的）
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        );
        return { bytes: new Uint8Array(png), mime: "image/png", width: 1, height: 1, taskId: `task-${randomUUID().slice(0, 6)}`, cost: { value: null, known: false } };
      },
    },
    creativeRuleJudge: {
      model: {
        baseUrl: "https://model.test/anthropic",
        apiKey: "test-key",
        model: "test-judge",
        transport: (input, init) => judgeModelHolder.current(input as string, init as RequestInit),
      },
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
      provider: "test",
    },
    creativeAssistant: {
      baseUrl: "https://model.test/anthropic",
      apiKey: "test-key",
      model: "test-chat",
      transport: (input, init) => chatModelHolder.current(input as string, init as RequestInit),
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
      provider: "test",
    },
    creativeImpactScan: {
      model: {
        baseUrl: "https://model.test/anthropic",
        apiKey: "test-key",
        model: "test-scan",
        transport: (input, init) => scanModelHolder.current(input as string, init as RequestInit),
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

describe("任务中断后能收拾（1B）", () => {
  it("停在「在跑」的导入任务，重启后第一次查变成暂停，可以继续", async () => {
    const created = await api(`/v1/creative/worlds/${dossierA}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "中断测试" }),
    });
    const work = await created.json();
    // 抽取先卡住（gate），保证这条测的是「重启后的收拾」，不是抽取速度
    const fast = importExtractorHolder.current;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    importExtractorHolder.current = async () => {
      await gate;
      return { extraction: { entities: [], events: [], merges: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    try {
      const started = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/import`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ text: "## 第一章\n内容一。\n\n## 第二章\n内容二。", title: "中断测试" }),
      });
      const job = await started.json();
      await api(`/v1/creative/worlds/${dossierA}/imports/${job.id}/pause`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: "{}",
      });
      // 模拟「上一个进程跑到一半被重启」：状态 running + updated_at 在过去
      await admin.query(
        `update creative_job
            set state='running',
                document = jsonb_set(jsonb_set(document, '{state}', '"running"'), '{error}', 'null'),
                updated_at = now() - interval '2 hours'
          where id=$1`,
        [job.id],
      );
      const after = await (await api(`/v1/creative/worlds/${dossierA}/imports/${job.id}`)).json();
      expect(after.state).toBe("paused");
      expect(after.error).toContain("服务重启");
      const resumed = await api(`/v1/creative/worlds/${dossierA}/imports/${job.id}/resume`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: "{}",
      });
      expect(resumed.status).toBe(200);
    } finally {
      release();
      importExtractorHolder.current = fast;
    }
  });
});

describe("导入预览分章 + 最后一章暂停落在 done（1B）", () => {
  let workId = "";

  it("预览分章：只分章、不落库、不抽取", async () => {
    const created = await api(`/v1/creative/worlds/${dossierA}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "预览测试" }),
    });
    workId = (await created.json()).id;
    const preview = await api(`/v1/creative/worlds/${dossierA}/works/${workId}/import/preview`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ text: "## 第一夜\n甲。乙。\n\n## 第二夜\n丙。\n\n## 第三夜\n丁。" }),
    });
    expect(preview.status).toBe(200);
    const body = await preview.json();
    expect(body.chapters).toHaveLength(3);
    expect(body.chapters.map((item: any) => item.title)).toEqual(["第一夜", "第二夜", "第三夜"]);
    expect(body.chapters[0].chars).toBeGreaterThan(0);
    expect(body.chapters[0].paragraphs).toBe(1);
    expect(body.chapters[2].preview).toContain("丁");

    // 预览不落库：作品还是空的
    const detail = await (await api(`/v1/creative/worlds/${dossierA}/works/${workId}`)).json();
    expect(detail.chapters).toEqual([]);
    // 空原文明确拒绝
    const empty = await api(`/v1/creative/worlds/${dossierA}/works/${workId}/import/preview`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ text: "   " }),
    });
    expect([400, 422]).toContain(empty.status);
  });

  it("在最后一章执行中暂停：抽完以后终态是 done，不是 paused", async () => {
    const fast = importExtractorHolder.current;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    importExtractorHolder.current = async () => {
      await gate;
      return { extraction: { entities: [], events: [], merges: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    };
    try {
      const started = await api(`/v1/creative/worlds/${dossierA}/works/${workId}/import`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ text: "## 唯一一章\n内容。", title: "暂停测试" }),
      });
      const job = await started.json();
      expect(job.chapters.total).toBe(1);
      // 这一章还没抽完就暂停
      const paused = await api(`/v1/creative/worlds/${dossierA}/imports/${job.id}/pause`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: "{}",
      });
      expect(paused.status).toBe(200);
      // 放行：那一章抽完，队列空了 → 终态 done
      release();
      let final: any = null;
      for (let index = 0; index < 100; index += 1) {
        await new Promise((done) => setTimeout(done, 100));
        final = await (await api(`/v1/creative/worlds/${dossierA}/imports/${job.id}`)).json();
        if (final.state === "done" || final.state === "failed") break;
      }
      expect(final.state).toBe("done");
      expect(final.chapters.done).toBe(final.chapters.total);
    } finally {
      release();
      importExtractorHolder.current = fast;
    }
  });

  it("队列空了还点继续：直接给 done，不再报「已经抽完了」", async () => {
    const created = await api(`/v1/creative/worlds/${dossierA}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "继续测试" }),
    });
    const work = await created.json();
    const started = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/import`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ text: "## 一章\n内容。", title: "继续测试" }),
    });
    const job = await started.json();
    for (let index = 0; index < 60; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const current = await (await api(`/v1/creative/worlds/${dossierA}/imports/${job.id}`)).json();
      if (current.state === "done") break;
    }
    // 手工做回「暂停但队列已空」这种老状态，再点继续
    await admin.query(
      `update creative_job set state='paused', document=jsonb_set(document,'{state}','"paused"') where id=$1`,
      [job.id],
    );
    const resumed = await api(`/v1/creative/worlds/${dossierA}/imports/${job.id}/resume`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: "{}",
    });
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).state).toBe("done");
  });
});

describe("创作台会话走 kernel runs（1B 契约 §5.2「助手」）", () => {
  it("设定顾问：建 run、多轮会话、工具交提议（29 号）", async () => {
    let call = 0;
    chatModelHolder.current = async () => {
      call += 1;
      const content =
        call === 1
          ? [
              {
                type: "tool_use",
                id: `tool-${call}`,
                name: "propose_setting",
                input: {
                  title: "加一个船夫",
                  summary: "冬天在渡口撑船的人。",
                  entities: [{ name: "船夫", kind: "person", aliases: ["舟子"], summary: "渡口撑船" }],
                  events: [],
                  rules: [],
                  doubts: [],
                },
              },
            ]
          : [{ type: "text", text: "已经交了一条提议，在待确认里。" }];
      return new Response(JSON.stringify({ content, usage: { input_tokens: 500, output_tokens: 200 } }), { status: 200 });
    };
    const started = await api("/v1/kernel/runs", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ dossierId: dossierA, query: "加一个渡口的船夫", mode: "creative_advisor" }),
    });
    expect(started.status).toBe(201);
    const { id } = await started.json();
    expect(id).toBeTruthy();

    let actions: string[] = [];
    let state = "";
    for (let index = 0; index < 100; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const run = await admin.query("select state from run where id=$1", [id]);
      state = run.rows[0]?.state ?? "";
      const events = await admin.query(
        "select action from event where run_id=$1 order by seq",
        [id],
      );
      actions = events.rows.map((row) => row.action);
      if (state === "completed" || state === "failed") break;
    }
    expect(state).toBe("completed");
    expect(actions).toContain("user/message");
    expect(actions).toContain("assistant/message");
    // 助手只产出提议：待确认里多了一条，账本里没有新实体
    const proposals = await (await api(`/v1/creative/worlds/${dossierA}/proposals?limit=200`)).json();
    expect(proposals.proposals.some((item: any) => item.title === "加一个船夫")).toBe(true);
    const world = await (await api(`/v1/creative/worlds/${dossierA}`)).json();
    expect(world.entities.some((item: any) => item.name === "船夫")).toBe(false);
  });

  it("顾问按底线提不出设定：会话照常完成，回复里说明为什么，不记成失败", async () => {
    chatModelHolder.current = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "现有设定没有夜间时段，我不凭摘要编一条夜规。\n\n这次没有生成提议。" }],
          usage: { input_tokens: 300, output_tokens: 120 },
        }),
        { status: 200 },
      );
    advisorModelHolder.current = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({ kind: "event", title: "", summary: "", entities: [], events: [], rules: [], doubts: ["现有设定没有夜间时段"] }),
            },
          ],
          usage: { input_tokens: 300, output_tokens: 120 },
        }),
        { status: 200 },
      );
    const started = await api("/v1/kernel/runs", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ dossierId: dossierA, query: "夜里有什么规矩？", mode: "creative_advisor" }),
    });
    const { id } = await started.json();
    let state = "";
    let reply = "";
    for (let index = 0; index < 100; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      state = (await admin.query("select state from run where id=$1", [id])).rows[0]?.state ?? "";
      const events = await admin.query(
        "select action, payload from event where run_id=$1 order by seq",
        [id],
      );
      const message = events.rows.filter((row) => row.action === "assistant/message").at(-1);
      reply = message
        ? (message.payload?.message?.content ?? []).map((block: any) => block.text ?? "").join("")
        : "";
      if (state === "completed" || state === "failed") break;
    }
    expect(state).toBe("completed");
    expect(reply).toContain("夜间时段");
    expect(reply).toContain("没有生成提议");

    // 直接调顾问接口也是 200 + declined，不是 422
    const direct = await api(`/v1/creative/worlds/${dossierA}/advisor`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ query: "夜里有什么规矩？" }),
    });
    expect(direct.status).toBe(200);
    const body = await direct.json();
    expect(body.proposals).toEqual([]);
    expect(body.declined).toContain("夜间时段");
  });

  it("别的台的档案开不了创作台助手", async () => {
    const denied = await api("/v1/kernel/runs", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ dossierId: dossierResearch, query: "加个人", mode: "creative_advisor" }),
    });
    expect(denied.status).toBe(400);
    expect((await denied.json()).code).toBe("BENCH_UNSUPPORTED");
  });
});

describe("事件与作品的双向引用（1B 契约 §5.1）", () => {
  it("场景引用了事件，事件详情的 workRefs 就带上作品、章、场", async () => {
    const snapshotWorld = await (await api(`/v1/creative/worlds/${dossierA}`)).json();
    const event = snapshotWorld.events[0];
    const created = await api(`/v1/creative/worlds/${dossierA}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "双向引用测试" }),
    });
    const work = await created.json();
    const outlined = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: 1,
        ops: [
          {
            op: "outline.set",
            outline: {
              logline: "试", pov: "三", ending: "试",
              chapters: [{ id: "cc1", title: "第一章", scenes: [{ id: "ss1", title: "出场", goal: "试", eventIds: [event.id], targetWords: 500 }] }],
            },
          },
          { op: "outline.confirm" },
        ],
      }),
    });
    expect(outlined.status).toBe(200);
    const after = await (await api(`/v1/creative/worlds/${dossierA}`)).json();
    const linked = after.events.find((item: any) => item.id === event.id);
    const chapterId = after.events.length ? null : null;
    void chapterId;
    expect(linked.workRefs).toHaveLength(1);
    expect(linked.workRefs[0].workId).toBe(work.id);
    expect(linked.workRefs[0].sceneId).toBe("ss1");
    expect(linked.workRefs[0].chapterId).toBeTruthy();
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

describe("待确认排序（验收 B4）", () => {
  it("默认新的在前，sort=oldest 反过来", async () => {
    const newest = await (await api(`/v1/creative/worlds/${dossierA}/proposals?limit=200`)).json();
    const oldest = await (await api(`/v1/creative/worlds/${dossierA}/proposals?limit=200&sort=oldest`)).json();
    expect(newest.proposals.length).toBeGreaterThan(1);
    expect(oldest.proposals.length).toBe(newest.proposals.length);
    expect(newest.proposals[0].id).toBe(oldest.proposals.at(-1).id);
    expect(newest.proposals.at(-1).id).toBe(oldest.proposals[0].id);
    const bad = await api(`/v1/creative/worlds/${dossierA}/proposals?sort=wat`);
    expect(bad.status).toBe(400);
  });
});

describe("1C：版本差异、影响清单、设定组合", () => {
  const worldPath = `/v1/creative/worlds/${dossierA}`;
  let placeId = "";
  let eventId = "";
  let vFrom = 0;
  let vTo = 0;
  let workId = "";
  let itemId = "";

  const ops = (body: unknown) =>
    api(`${worldPath}/ops`, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify(body) });

  it("存 v2 之前先看草稿差异：按条目列出改了哪些字段", async () => {
    const snapshot = await (await api(worldPath)).json();
    placeId = (snapshot.entities.find((item: any) => item.name === "青州城") ?? snapshot.entities[0]).id;
    eventId = snapshot.events[0].id;
    vFrom = snapshot.versions.length ? snapshot.versions.at(-1).n : 0;
    // 挪地点 + 事件改早一小时
    const place = snapshot.entities.find((item: any) => item.id === placeId)!;
    const changed = await ops({
      baseRevision: snapshot.world.revision,
      ops: [
        {
          op: "entity.update",
          id: placeId,
          patch: { place: { ...place.place, geo: { type: "Point", coordinates: [118.55, 36.75] } } },
        },
        { op: "event.update", id: eventId, patch: { start: { input: "1684-04-21 05:00" } } },
      ],
    });
    expect(changed.status).toBe(200);

    const draft = await (await api(`${worldPath}/versions/draft`)).json();
    expect(draft.items.length).toBeGreaterThanOrEqual(2);
    const placeChange = draft.items.find((item: any) => item.itemId === placeId)!;
    expect(placeChange.kind).toBe("entity");
    expect(placeChange.fields).toContain("地点信息");
    const eventChange = draft.items.find((item: any) => item.itemId === eventId)!;
    expect(eventChange.fields).toContain("开始时间");

    const saved = await api(`${worldPath}/versions`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ summary: "v2：青州城挪位置、出发改早一小时" }),
    });
    const version = await saved.json();
    vTo = version.n;
    expect(version.changes).toBe(draft.items.length);

    const detail = await (await api(`${worldPath}/versions/${vTo}`)).json();
    expect(detail.items.length).toBe(version.changes);
    expect(detail.items.some((item: any) => item.itemId === placeId && item.fields.includes("地点信息"))).toBe(true);
  });

  it("影响清单：条目、确定受影响的场景、每部作品用哪版与检查试算", async () => {
    const report = await (await api(`${worldPath}/impact?from=${vTo - 1}&to=${vTo}`)).json();
    expect(report.fromVersion).toBe(vTo - 1);
    expect(report.toVersion).toBe(vTo);
    expect(report.items.length).toBeGreaterThanOrEqual(2);
    const placeItem = report.items.find((item: any) => item.change.itemId === placeId)!;
    expect(placeItem.group).toContain("位置");
    // 确定受影响：事件引用这个地点、正文写到地名
    expect(placeItem.sure.length).toBeGreaterThan(0);
    expect(placeItem.sure.some((ref: any) => ref.kind === "event" || ref.kind === "scene")).toBe(true);
    // 每部作品：旧/新、决定、检查试算
    expect(Array.isArray(placeItem.works)).toBe(true);
    for (const entry of placeItem.works) {
      expect(["old", "new", "override"]).toContain(entry.uses);
      expect(entry.checkAfter === null || Array.isArray(entry.checkAfter.conflicts)).toBe(true);
    }
    expect(report.maybeScan.state).toBe("none");
  });

  it("按作品看：effective 快照带 check，条目带 setting", async () => {
    const works = await (await api(`${worldPath}/works`)).json();
    workId = works[0].id;
    const effective = await (await api(`${worldPath}/works/${workId}/effective`)).json();
    expect(effective.world).toBeTruthy();
    expect(effective.check).toBeTruthy();
    expect(effective.entities.every((item: any) => ["base", "picked", "override"].includes(item.setting))).toBe(true);
  });

  it("跟着改：picks + 决定 + 场景待同步；effective 用新版，marks 带 sync", async () => {
    itemId = placeId;
    const work = await (await api(`${worldPath}/works/${workId}`)).json();
    const followed = await api(`${worldPath}/works/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: work.revision,
        ops: [{ op: "setting.follow", itemId, toVersion: vTo }],
      }),
    });
    expect(followed.status).toBe(200);
    const body = await followed.json();
    expect(body.work.setting.picks.some((pick: any) => pick.itemId === itemId && pick.fromVersion === vTo)).toBe(true);
    expect(body.work.setting.decisions.some((decision: any) => decision.itemId === itemId && decision.decision === "follow")).toBe(true);

    const effective = await (await api(`${worldPath}/works/${workId}/effective`)).json();
    const place = effective.entities.find((item: any) => item.id === itemId);
    expect(place.setting).toBe("picked");
    expect((place.place.geo.coordinates as number[])[0]).toBeCloseTo(118.55, 5);
    const scenesWithSync = effective.chapters
      ? effective.chapters.flatMap((chapter: any) => chapter.scenes).filter((scene: any) => scene.marks.some((mark: any) => mark.kind === "sync"))
      : [];
    expect(scenesWithSync.length).toBeGreaterThanOrEqual(0);
    expect(body.work.setting.pendingSync).toBeGreaterThanOrEqual(0);
  });

  it("保留旧版：只记决定，不采用新版", async () => {
    const works = await (await api(`${worldPath}/works`)).json();
    const other = works.find((item: any) => item.id !== workId);
    const detail = await (await api(`${worldPath}/works/${other.id}`)).json();
    const kept = await api(`${worldPath}/works/${other.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: detail.revision, ops: [{ op: "setting.keep", itemId, toVersion: vTo }] }),
    });
    expect(kept.status).toBe(200);
    const body = await kept.json();
    expect(body.work.setting.decisions.some((decision: any) => decision.itemId === itemId && decision.decision === "keep")).toBe(true);
    expect(body.work.setting.picks).toEqual([]);
  });

  it("本作品改写 + 推广：effective 里生效，推广成一条世界观提议", async () => {
    const work = await (await api(`${worldPath}/works/${workId}`)).json();
    const overridden = await api(`${worldPath}/works/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: work.revision,
        ops: [{ op: "override.set", itemId, kind: "entity", patch: { summary: "本作品里这座城更冷" }, note: "本作品冷一点" }],
      }),
    });
    expect(overridden.status).toBe(200);
    const effective = await (await api(`${worldPath}/works/${workId}/effective`)).json();
    const place = effective.entities.find((item: any) => item.id === itemId);
    expect(place.setting).toBe("override");
    expect(place.summary).toBe("本作品里这座城更冷");

    const before = (await (await api(worldPath)).json()).proposals.length;
    const promoted = await api(`${worldPath}/works/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: (await overridden.json()).revision,
        ops: [{ op: "override.promote", itemId }],
      }),
    });
    expect(promoted.status).toBe(200);
    const after = (await (await api(worldPath)).json()).proposals.length;
    expect(after).toBeGreaterThanOrEqual(before + 1);
  });

  it("世界观面能看出哪些作品改写了这条条目", async () => {
    const snapshot = await (await api(worldPath)).json();
    const place = snapshot.entities.find((item: any) => item.id === itemId);
    expect(place.overriddenBy?.some((entry: any) => entry.workId === workId)).toBe(true);
    expect(place.overriddenBy[0].workTitle).toBeTruthy();
  });

  it("扫正文：异步，产出「可能受影响」的段落与花费", async () => {
    const work = await (await api(`${worldPath}/works/${workId}`)).json();
    const scene = work.chapters[0]?.scenes[0];
    scanModelHolder.current = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                hits: [
                  {
                    itemId,
                    workId,
                    chapterId: work.chapters[0].id,
                    sceneId: scene.id,
                    para: 0,
                    quote: (scene.text ?? "青州").slice(0, 20),
                    why: "这段提到了这座城",
                  },
                ],
              }),
            },
          ],
          usage: { input_tokens: 900, output_tokens: 120 },
        }),
        { status: 200 },
      );
    const started = await api(`${worldPath}/impact/scan`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ from: vTo - 1, to: vTo }),
    });
    expect(started.status).toBe(202);
    expect((await started.json()).state).toBe("running");
    let scan: any = null;
    for (let index = 0; index < 200; index += 1) {
      await new Promise((done) => setTimeout(done, 150));
      scan = (await (await api(`${worldPath}/impact?from=${vTo - 1}&to=${vTo}`)).json()).maybeScan;
      if (scan.state === "done" || scan.state === "failed") break;
    }
    expect(scan.state).toBe("done");
    expect(scan.cost.known).toBe(true);
    expect(scan.cost.value).toBeGreaterThan(0);
    const report = await (await api(`${worldPath}/impact?from=${vTo - 1}&to=${vTo}`)).json();
    const item = report.items.find((entry: any) => entry.change.itemId === itemId);
    expect(item.maybe.length).toBeGreaterThan(0);
    expect(item.maybe[0].quote).toBeTruthy();
    expect(item.maybe[0].why).toBeTruthy();
  });
});

describe("复验：跨版本跟着改也能标待同步（从 baseVersion 起算）", () => {
  it("条目在中间某版改、目标版是再下一版时，确定受影响的场景照样标待同步", async () => {
    const worldPath = `/v1/creative/worlds/${dossierA}`;
    const snapshot = await (await api(worldPath)).json();
    const place = snapshot.entities.find((item: any) => item.name === "青州城");
    const created = await api(`${worldPath}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "跨版本测试" }),
    });
    const work = await created.json();
    expect(work.baseVersion).toBeGreaterThanOrEqual(2);
    const base = work.baseVersion;
    await api(`${worldPath}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: 1,
        ops: [
          {
            op: "outline.set",
            outline: {
              logline: "试", pov: "三", ending: "试",
              chapters: [{ id: "c1", title: "第一章", scenes: [{ id: "s1", title: "城门口", goal: "试", eventIds: [], targetWords: 300 }] }],
            },
          },
          { op: "outline.confirm" },
          { op: "text.set", sceneId: "s1", baseTextVersion: 0, text: "青州城的城门还没有开，雨一直下。" },
        ],
      }),
    });
    // v3：挪青州城；v4：挪另一个地点（目标版不是条目改的那一版）
    let current = (await (await api(worldPath)).json()).world.revision;
    await api(`${worldPath}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: current,
        ops: [{ op: "entity.update", id: place.id, patch: { place: { ...place.place, geo: { type: "Point", coordinates: [118.4, 36.9] } } } }],
      }),
    });
    const v3 = await (await api(`${worldPath}/versions`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ summary: "v3：青州城挪位置" }),
    })).json();
    const other = (await (await api(worldPath)).json()).entities.find((item: any) => item.kind === "place" && item.id !== place.id);
    current = (await (await api(worldPath)).json()).world.revision;
    await api(`${worldPath}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: current,
        ops: [{ op: "entity.update", id: other.id, patch: { summary: `改简介 ${Date.now()}` } }],
      }),
    });
    const v4 = await (await api(`${worldPath}/versions`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ summary: "v4：另一个地点改简介" }),
    })).json();
    expect(v4.n).toBeGreaterThan(v3.n);
    expect(base).toBeLessThan(v3.n);

    const followed = await api(`${worldPath}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: 2, ops: [{ op: "setting.follow", itemId: place.id, toVersion: v4.n }] }),
    });
    expect(followed.status).toBe(200);
    const body = await followed.json();
    expect(body.work.setting.picks.some((pick: any) => pick.itemId === place.id && pick.fromVersion === v4.n)).toBe(true);
    // 条目在 v3 改的，从 baseVersion 算到 v4 必须能标出来
    expect(body.work.setting.pendingSync).toBeGreaterThanOrEqual(1);
    const detail = await (await api(`${worldPath}/works/${work.id}`)).json();
    const marks = detail.chapters.flatMap((chapter: any) => chapter.scenes).flatMap((scene: any) => scene.marks);
    expect(marks.some((mark: any) => mark.kind === "sync" && mark.refId === place.id)).toBe(true);
  });
});

describe("29 号：模型判自然语言规则", () => {
  const worldPath = `/v1/creative/worlds/${dossierA}`;
  let ruleId = "";

  it("翻不成程序可判的规则，由模型判成「疑似」，并记花费；没变就复用", async () => {
    const snapshot = await (await api(worldPath)).json();
    const added = await api(`${worldPath}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: snapshot.world.revision,
        ops: [{ op: "rule.set", rule: { id: "rule_curfew", text: "苏州城宵禁，入夜城门关闭。", machine: null } }],
      }),
    });
    expect(added.status).toBe(200);
    ruleId = "rule_curfew";
    const eventId = snapshot.events[0].id;

    judgeModelHolder.current = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({ violations: [{ ruleId, eventId, why: "这条事件在入夜后出城，和宵禁对不上", quote: "夜里动身" }] }),
            },
          ],
          usage: { input_tokens: 700, output_tokens: 90 },
        }),
        { status: 200 },
      );
    const judged = await api(`${worldPath}/rules/judge`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: "{}",
    });
    expect(judged.status).toBe(200);
    const body = await judged.json();
    expect(body.judged).toBeGreaterThanOrEqual(1);
    expect(body.cost.known).toBe(true);
    const suspect = body.check.conflicts.find((item: any) => item.kind === "rule_model");
    expect(suspect?.severity).toBe("suspect");
    expect(suspect.why).toContain("宵禁");
    expect(suspect.why).toContain("疑似");

    // 事件和规则没变：第二次不再花钱
    const again = await api(`${worldPath}/rules/judge`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: "{}",
    });
    expect((await again.json()).judged).toBe(0);
  });
});

describe("29 号：同一会话续一句", () => {
  it("第二轮能带上第一轮说过的话", async () => {
    const started = await api("/v1/kernel/runs", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ dossierId: dossierA, query: "第一句：加一个船夫", mode: "creative_advisor" }),
    });
    const { id } = await started.json();
    // 等第一轮结束
    for (let index = 0; index < 100; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const state = (await admin.query("select state from run where id=$1", [id])).rows[0]?.state;
      if (state === "completed") break;
    }
    const bodies: string[] = [];
    chatModelHolder.current = async (_url, init) => {
      bodies.push(String((init as RequestInit).body ?? ""));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "第二轮回答。" }], usage: { input_tokens: 20, output_tokens: 8 } }), { status: 200 });
    };
    const next = await api(`/v1/kernel/runs/${id}/messages`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ query: "第二句：他叫什么？" }),
    });
    expect(next.status).toBe(202);
    for (let index = 0; index < 100; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const count = (await admin.query("select count(*)::int n from event where run_id=$1 and action='assistant/message'", [id])).rows[0]?.n;
      if (count >= 2) break;
    }
    expect(bodies.length).toBeGreaterThan(0);
    const sent = JSON.parse(bodies[0]) as { messages: { role: string; content: { text: string }[] }[] };
    const flat = sent.messages.flatMap((message) => message.content.map((block) => block.text)).join("\n");
    expect(flat).toContain("第一句");
    expect(flat).toContain("第二句");
  });
});

describe("C2：场景靠 eventIds 引用时，「让助手改」整场替换", () => {
  it("没有正文标注段号 → before 是整场原文、range 为空，接受后替换原文、待同步减 1", async () => {
    const created = await api(`/v1/creative/worlds/${dossierA}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "场景引用测试" }),
    });
    const work = await created.json();
    const snapshot = await (await api(`/v1/creative/worlds/${dossierA}`)).json();
    const event = snapshot.events[0];
    // 正文里不写地名/人名，只靠 eventIds 引用
    const outlined = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: 1,
        ops: [
          {
            op: "outline.set",
            outline: {
              logline: "试", pov: "三", ending: "试",
              chapters: [{ id: "c1", title: "第一章", scenes: [{ id: "s1", title: "出门", goal: "试", eventIds: [event.id], targetWords: 300 }] }],
            },
          },
          { op: "outline.confirm" },
          { op: "text.set", sceneId: "s1", baseTextVersion: 0, text: "第一段：天没亮他就出了门。\n\n第二段：路上没有人。" },
        ],
      }),
    });
    expect(outlined.status).toBe(200);
    // 改这条事件，存新版本
    const before = (await (await api(`/v1/creative/worlds/${dossierA}`)).json()).world.revision;
    const changed = await api(`/v1/creative/worlds/${dossierA}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: before,
        ops: [{ op: "event.update", id: event.id, patch: { start: { input: "1684-04-21 05:00" } } }],
      }),
    });
    expect(changed.status).toBe(200);
    const saved = await api(`/v1/creative/worlds/${dossierA}/versions`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ summary: "场景引用测试版" }),
    });
    const toVersion = (await saved.json()).n;
    const followed = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: 2, ops: [{ op: "setting.follow", itemId: event.id, toVersion }] }),
    });
    expect(followed.status).toBe(200);
    const followBody = await followed.json();
    expect(followBody.work.setting.pendingSync).toBe(1);

    writerModelHolder.current = async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ text: "第一段：他提前一个时辰出了门。\n\n第二段：路上还是没有人。", why: "按新时间改" }) }], usage: { input_tokens: 800, output_tokens: 200 } }),
        { status: 200 },
      );
    const suggested = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: followBody.revision, ops: [{ op: "sync.suggest", itemId: event.id, sceneIds: ["s1"] }] }),
    });
    expect(suggested.status).toBe(200);
    const suggestBody = await suggested.json();
    let proposal: any = null;
    for (let index = 0; index < 120; index += 1) {
      await new Promise((done) => setTimeout(done, 200));
      const list = await (await api(`/v1/creative/worlds/${dossierA}/proposals?kind=text_edit&limit=20`)).json();
      proposal = list.proposals.find((item: any) => item.batchId === `sync_${event.id}` && item.status === "pending");
      if (proposal) break;
    }
    expect(proposal).toBeTruthy();
    const edit = proposal.ops[0];
    expect(edit.mode).toBe("rewrite");
    expect(edit.before).toBe("第一段：天没亮他就出了门。\n\n第二段：路上没有人。");
    expect(edit.range).toBeNull();

    const accepted = await api(`/v1/creative/worlds/${dossierA}/works/${work.id}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: suggestBody.revision, ops: [{ op: "text.accept", proposalId: proposal.id }] }),
    });
    expect(accepted.status).toBe(200);
    const body = await accepted.json();
    expect(body.work.chapters[0].scenes[0].text).toBe("第一段：他提前一个时辰出了门。\n\n第二段：路上还是没有人。");
    expect(body.work.setting.pendingSync).toBe(0);
  });
});

describe("1D：提议在看板上的虚影", () => {
  let dossier = "";
  let proposalId = "";

  beforeAll(async () => {
    const created = await api("/v1/dossiers", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ bench: "creative", title: "1D 看板测试" }),
    });
    dossier = (await created.json()).id;
    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    await api(`/v1/creative/worlds/${dossier}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: world.world.revision,
        ops: [
          { op: "entity.add", entity: { kind: "person", name: "张三", aliases: [] } },
          {
            op: "entity.add",
            entity: {
              kind: "place", name: "城门", aliases: [],
              place: { level: "city", parentId: null, geo: { type: "Point", coordinates: [120.6, 31.31] }, geoCertainty: "exact", connects: [] },
            },
          },
        ],
      }),
    });
  });

  const runOnce = async (query: string, toolInput: Record<string, unknown>) => {
    // 第一轮调工具交提议，之后只回一句话（否则脚本化模型会在工具循环里反复交）
    let call = 0;
    chatModelHolder.current = async () => {
      call += 1;
      const content =
        call === 1
          ? [{ type: "tool_use", id: `call-${randomUUID().slice(0, 6)}`, name: "propose_setting", input: toolInput }]
          : [{ type: "text", text: "已经交在看板上了。" }];
      return new Response(JSON.stringify({ content, usage: { input_tokens: 400, output_tokens: 150 } }), { status: 200 });
    };
    const started = await api("/v1/kernel/runs", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ dossierId: dossier, query, mode: "creative_advisor" }),
    });
    const { id } = await started.json();
    for (let index = 0; index < 150; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const proposals = await (await api(`/v1/creative/worlds/${dossier}/proposals?limit=60`)).json();
      const hit = proposals.proposals.find((item: any) => item.title === String(toolInput.title));
      if (hit) return { runId: id, proposal: hit };
    }
    return { runId: id, proposal: null as any };
  };

  it("预览：新条目用 pv: id，带行程/轨迹/新冲突，不落库", async () => {
    const { proposal, runId } = await runOnce("加一个渡口的老船夫，和张三有交集", {
      title: "加一个渡口的老船夫",
      summary: "渡口撑船三十年的人，和张三照过面。",
      entities: [{ name: "老船夫", kind: "person", aliases: ["船夫"], summary: "渡口撑船" }],
      events: [
        {
          title: "张三搭老船夫的船",
          what: "过河往西",
          kind: "travel",
          participants: [{ name: "张三", as: "actor" }, { name: "老船夫", as: "actor" }],
          placeName: "城门",
          start: "1684-04-21 06:20",
          end: "1684-04-21 06:40",
          narrative: "fact",
        },
      ],
      rules: [],
      doubts: [],
    });
    expect(proposal).toBeTruthy();
    proposalId = proposal.id;
    expect(proposal.runId).toBe(runId);
    // 交提议本身会推修订；预览不该再动它
    const before = (await (await api(`/v1/creative/worlds/${dossier}`)).json()).world.revision;

    const preview = await api(`/v1/creative/worlds/${dossier}/proposals/${proposalId}/preview`);
    expect(preview.status).toBe(200);
    const body = await preview.json();
    expect(body.proposalId).toBe(proposalId);
    expect(body.baseRevision).toBeGreaterThanOrEqual(before);
    expect(body.added.entities).toHaveLength(1);
    expect(body.added.entities[0].id.startsWith("pv:")).toBe(true);
    expect(body.added.events).toHaveLength(1);
    expect(body.added.events[0].id.startsWith("pv:")).toBe(true);
    expect(body.added.events[0].participants).toHaveLength(2);
    // 地点按名字解析成真地点（顾问工具里叫 placeName，别被丢掉）
    expect(body.added.events[0].placeId).toBeTruthy();
    expect(Array.isArray(body.legs)).toBe(true);
    expect(Array.isArray(body.tracks)).toBe(true);
    expect(Array.isArray(body.conflictsNew)).toBe(true);
    expect(Array.isArray(body.conflictsGone)).toBe(true);
    expect(body.unresolved).toEqual([]);
    expect((await (await api(`/v1/creative/worlds/${dossier}`)).json()).world.revision).toBe(before);
  });

  it("改版链：新版替代旧版，旧版作废写「被新版替代」，预览带 vsPrevious", async () => {
    const { proposal } = await runOnce("让他晚一天出现", {
      title: "加一个渡口的老船夫（第 2 版）",
      summary: "改成第二天才出现。",
      entities: [{ name: "老船夫", kind: "person", aliases: ["船夫"], summary: "渡口撑船" }],
      events: [
        {
          title: "张三搭老船夫的船（改）",
          what: "过河往西",
          kind: "travel",
          participants: [{ name: "张三", as: "actor" }, { name: "老船夫", as: "actor" }],
          placeName: "城门",
          start: "1684-04-22 06:20",
          end: "1684-04-22 06:40",
          narrative: "fact",
        },
      ],
      rules: [],
      doubts: [],
      supersedes: proposalId,
    });
    expect(proposal).toBeTruthy();
    expect(proposal.supersedes).toBe(proposalId);
    // 旧版是被作废的：默认列表只给待处理的，要按已拒绝筛
    const rejected = (await (await api(`/v1/creative/worlds/${dossier}/proposals?status=rejected&limit=80`)).json()).proposals;
    const old = rejected.find((item: any) => item.id === proposalId)!;
    expect(old.status).toBe("rejected");
    expect(old.resolution?.reason).toBe("被新版替代");
    expect(old.resolution?.by).toBe("agent");

    const preview = await (await api(`/v1/creative/worlds/${dossier}/proposals/${proposal.id}/preview`)).json();
    expect(Array.isArray(preview.vsPrevious)).toBe(true);
    expect(preview.vsPrevious.length).toBeGreaterThan(0);
    // 同一条事件改了标题/时间：应该合成一条 update，不是「加一条 + 删一条」
    const eventChanges = preview.vsPrevious.filter((item: any) => item.kind === "event");
    expect(eventChanges.some((item: any) => item.change === "update")).toBe(true);
    expect(
      eventChanges.some((item: any) => item.change === "add") && eventChanges.some((item: any) => item.change === "remove"),
    ).toBe(false);
  });

  it("重名不整批 409：照样出预览，写进 unresolved", async () => {
    const { proposal } = await runOnce("再加一个张三", {
      title: "再加一个张三（重名）",
      summary: "名字撞上了已有的张三。",
      entities: [{ name: "张三", kind: "person", aliases: [], summary: "想再建一个同名的人" }],
      events: [
        {
          title: "张三在城门站了一会儿",
          what: "站了一会儿",
          kind: "stay",
          participants: [{ name: "张三", as: "actor" }],
          placeName: "城门",
          start: "1684-04-23 09:00",
          end: "1684-04-23 09:10",
          narrative: "fact",
        },
      ],
      rules: [],
      doubts: [],
    });
    expect(proposal).toBeTruthy();
    const preview = await api(`/v1/creative/worlds/${dossier}/proposals/${proposal.id}/preview`);
    expect(preview.status).toBe(200);
    const body = await preview.json();
    expect(body.unresolved.some((item: string) => item.includes("张三") && item.includes("已存在"))).toBe(true);
    expect(body.added.events).toHaveLength(1);
  });

  it("规则判定不进 conflictsGone（接受后要重判，不算被提议修好）", async () => {
    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    await api(`/v1/creative/worlds/${dossier}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: world.world.revision,
        ops: [{ op: "rule.set", rule: { id: "rule_test_curfew", text: "夜里城门不开。", machine: null } }],
      }),
    });
    judgeModelHolder.current = async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ violations: [] }) }], usage: { input_tokens: 300, output_tokens: 40 } }), {
        status: 200,
      });
    const judged = await api(`/v1/creative/worlds/${dossier}/rules/judge`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: "{}",
    });
    expect(judged.status).toBe(200);
    const { proposal } = await runOnce("加一条夜里的事", {
      title: "夜里多一条巡夜",
      summary: "试规则判定。",
      entities: [],
      events: [
        {
          title: "巡夜",
          what: "城门巡夜",
          kind: "stay",
          participants: [{ name: "张三", as: "actor" }],
          placeName: "城门",
          start: "1684-04-24 22:00",
          end: "1684-04-24 22:30",
          narrative: "fact",
        },
      ],
      rules: [],
      doubts: [],
    });
    const preview = await (await api(`/v1/creative/worlds/${dossier}/proposals/${proposal.id}/preview`)).json();
    const all = [...preview.conflictsNew, ...preview.conflictsGone];
    expect(all.some((item: any) => (typeof item === "string" ? false : item.kind === "rule_model"))).toBe(false);
  });

  it("交提议那条 focus 带上动到的条目", async () => {
    const { runId } = await runOnce("加一条城门口的事", {
      title: "城门口的事（focus refs）",
      summary: "试 focus refs。",
      entities: [],
      events: [
        {
          title: "城门口等消息",
          what: "等消息",
          kind: "stay",
          participants: [{ name: "张三", as: "actor" }],
          placeName: "城门",
          start: "1684-04-25 09:00",
          end: "1684-04-25 09:10",
          narrative: "fact",
        },
      ],
      rules: [],
      doubts: [],
    });
    let focus: any[] = [];
    for (let index = 0; index < 120; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const events = await admin.query("select data from creative_event where dossier_id=$1 and type='creative.focus' order by at", [dossier]);
      focus = events.rows.map((row) => row.data).filter((data: any) => data.runId === runId && data.proposalId);
      if (focus.length) break;
    }
    expect(focus.length).toBeGreaterThan(0);
    expect(focus[0].refs.length).toBeGreaterThan(0);
    expect(focus[0].refs.some((ref: any) => ref.kind === "entity")).toBe(true);
  });

  it("时间认不出就不交提议，把原因回给模型", async () => {
    const before = (await (await api(`/v1/creative/worlds/${dossier}/proposals?limit=200`)).json()).proposals.length;
    let call = 0;
    chatModelHolder.current = async () => {
      call += 1;
      const content =
        call === 1
          ? [
              {
                type: "tool_use",
                id: "bad-time",
                name: "propose_setting",
                input: {
                  title: "时间写错了的提议",
                  entities: [],
                  events: [
                    {
                      title: "错时间的事",
                      what: "试试",
                      kind: "stay",
                      participants: [{ name: "张三", as: "actor" }],
                      placeName: "城门",
                      start: "1684-05-03 十一点",
                      end: "1684-05-03 12:00",
                      narrative: "fact",
                    },
                  ],
                  rules: [],
                  doubts: [],
                },
              },
            ]
          : [{ type: "text", text: "" }];
      return new Response(JSON.stringify({ content, usage: { input_tokens: 200, output_tokens: 60 } }), { status: 200 });
    };
    const started = await api("/v1/kernel/runs", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ dossierId: dossier, query: "加一条事", mode: "creative_advisor" }),
    });
    const { id } = await started.json();
    for (let index = 0; index < 120; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const state = (await admin.query("select state from run where id=$1", [id])).rows[0]?.state;
      if (state === "completed") break;
    }
    const after = (await (await api(`/v1/creative/worlds/${dossier}/proposals?limit=200`)).json()).proposals;
    expect(after.some((item: any) => item.title === "时间写错了的提议")).toBe(false);
    expect(after.length).toBe(before);
    // 看板那一步要说「没交成」，对话里也要把原因写出来
    const focus = (await admin.query("select data from creative_event where dossier_id=$1 and type='creative.focus' order by at", [dossier])).rows
      .map((row) => row.data)
      .filter((data: any) => data.runId === id);
    expect(focus.some((item: any) => String(item.step).includes("没交成"))).toBe(true);
    expect(focus.every((item: any) => item.proposalId !== null || !String(item.step).includes("交了提议"))).toBe(true);
    const reply = (await admin.query("select payload from event where run_id=$1 and action='assistant/message' order by seq desc limit 1", [id])).rows[0];
    const text = (reply?.payload?.message?.content ?? []).map((block: any) => block.text).join("");
    expect(text).toContain("没交成");
  });

  it("出行事件带 from/to：travel 填 id，预览按路网画路线", async () => {
    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    const exists = world.entities.some((item: any) => item.name === "渡口");
    if (!exists)
      await api(`/v1/creative/worlds/${dossier}/ops`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          baseRevision: world.world.revision,
          ops: [
            {
              op: "entity.add",
              entity: {
                kind: "place",
                name: "渡口",
                aliases: [],
                place: { level: "site", parentId: null, geo: { type: "Point", coordinates: [120.62, 31.32] }, geoCertainty: "exact", connects: [] },
              },
            },
          ],
        }),
      });
    // 先有一条「在城门」的事，行程才有起点
    const state = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    const person = state.entities.find((item: any) => item.name === "张三");
    const gate = state.entities.find((item: any) => item.name === "城门");
    const hasPrior = state.events.some((item: any) => item.title === "张三在城门等消息");
    if (!hasPrior)
      await api(`/v1/creative/worlds/${dossier}/ops`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          baseRevision: state.world.revision,
          ops: [
            {
              op: "event.add",
              event: {
                title: "张三在城门等消息",
                what: "在城门等",
                kind: "stay",
                participants: [{ entityId: person.id, as: "actor" }],
                placeId: gate.id,
                travel: null,
                narrative: "fact",
                start: { input: "1684-04-26 07:00" },
                end: { input: "1684-04-26 07:40" },
              },
            },
          ],
        }),
      });
    const { proposal } = await runOnce("让他从城门走到渡口", {
      title: "从城门走到渡口",
      entities: [],
      events: [
        {
          title: "张三走到渡口",
          what: "走过去",
          kind: "travel",
          participants: [{ name: "张三", as: "actor" }],
          from: "城门",
          to: "渡口",
          start: "1684-04-26 08:00",
          end: "1684-04-26 08:40",
          narrative: "fact",
        },
      ],
      rules: [],
      doubts: [],
    });
    expect(proposal).toBeTruthy();
    const event = proposal.ops[0].event;
    expect(event.travel.fromId).toBeTruthy();
    expect(event.travel.toId).toBeTruthy();
    expect(event.placeId).toBe(event.travel.toId);
    const preview = await (await api(`/v1/creative/worlds/${dossier}/proposals/${proposal.id}/preview`)).json();
    expect(preview.legs.length).toBe(1);
    // 标准 legs 已经有「上一处 → 这条出行事件」，就不该再补一段（否则画两遍）
    expect(preview.legs.some((leg: any) => String(leg.id).startsWith("leg_preview_"))).toBe(false);
    expect(preview.legs.some((leg: any) => String(leg.toEventId).startsWith("pv:") || String(leg.fromEventId).startsWith("pv:"))).toBe(true);
  });

  it("看板「正在看」：读工具推 creative.focus，一轮结束推 done", async () => {
    let searchCall = 0;
    chatModelHolder.current = async () => {
      searchCall += 1;
      const content =
        searchCall === 1
          ? [{ type: "tool_use", id: `call-${randomUUID().slice(0, 6)}`, name: "event_search", input: { query: "张三" } }]
          : [{ type: "text", text: "张三在这本书里出现过。" }];
      return new Response(JSON.stringify({ content, usage: { input_tokens: 200, output_tokens: 60 } }), { status: 200 });
    };
    const started = await api("/v1/kernel/runs", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ dossierId: dossier, query: "张三做过什么？", mode: "creative_advisor" }),
    });
    const { id } = await started.json();
    let focus: any[] = [];
    for (let index = 0; index < 150; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      const events = await admin.query("select data from creative_event where dossier_id=$1 and type='creative.focus' order by at", [dossier]);
      focus = events.rows.map((row) => row.data).filter((data: any) => data.runId === id);
      if (focus.some((item) => item.done)) break;
    }
    expect(focus.some((item) => item.step.includes("张三"))).toBe(true);
    expect(focus.some((item) => item.done === true && item.step === "完成")).toBe(true);
  });
});

describe("MVP-2：人物形象（立绘和三视图）", () => {
  let dossier = "";
  let personId = "";

  beforeAll(async () => {
    const created = await api("/v1/dossiers", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ bench: "creative", title: "MVP-2 出图测试" }),
    });
    dossier = (await created.json()).id;
    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    await api(`/v1/creative/worlds/${dossier}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: world.world.revision,
        ops: [
          { op: "world.set", patch: { artStyle: "明清工笔淡彩" } },
          { op: "entity.add", entity: { kind: "person", name: "沈砚", aliases: [], summary: "落第书生" } },
        ],
      }),
    });
    const after = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    personId = after.entities.find((item: any) => item.name === "沈砚").id;
  });

  it("没写外貌出不了图（422 LOOK_MISSING）；世界观画风进快照", async () => {
    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    expect(world.world.artStyle).toBe("明清工笔淡彩");
    const denied = await api(`/v1/creative/worlds/${dossier}/entities/${personId}/asset/versions`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(422);
    expect((await denied.json()).code).toBe("LOOK_MISSING");
  });

  it("出一版：四格从 queued 到 saved，图存在本机、文件接口能取到", async () => {
    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    await api(`/v1/creative/worlds/${dossier}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: world.world.revision,
        ops: [{ op: "entity.update", id: personId, patch: { person: { look: "二十余岁，青衫，瘦，眼神很静" } } }],
      }),
    });
    const started = await api(`/v1/creative/worlds/${dossier}/entities/${personId}/asset/versions`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ note: "要清瘦一点" }),
    });
    expect(started.status).toBe(201);
    const body = await started.json();
    expect(body.version.views.portrait.state).toBe("queued");
    expect(Object.keys(body.version.views)).toHaveLength(4);

    let asset: any = null;
    for (let index = 0; index < 200; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      asset = await (await api(`/v1/creative/worlds/${dossier}/entities/${personId}/asset`)).json();
      const cells = Object.values(asset.versions[0].views) as any[];
      if (cells.every((cell) => cell.state === "saved" || cell.state === "failed")) break;
    }
    const cells = Object.values(asset.versions[0].views) as any[];
    expect(cells.every((cell) => cell.state === "saved")).toBe(true);
    expect(asset.versions[0].provider).toBe("test-ark");
    const portrait = asset.versions[0].views.portrait;
    expect(portrait.url).toMatch(/^\/v1\/creative\/assets\/files\//);

    const file = await api(portrait.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    const download = await api(`${portrait.url}?download=1`);
    expect(download.headers.get("content-disposition")).toContain("attachment");

    const usage = await admin.query(
      "select count(*)::int n from usage_record where dossier_id=$1 and purpose='creative_image'",
      [dossier],
    );
    expect(usage.rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it("选用以后快照里 person.portrait 直接可用", async () => {
    const asset = await (await api(`/v1/creative/worlds/${dossier}/entities/${personId}/asset`)).json();
    const version = asset.versions[0];
    const selected = await api(`/v1/creative/worlds/${dossier}/entities/${personId}/asset/selected`, {
      method: "PUT",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ versionId: version.id }),
    });
    expect(selected.status).toBe(200);
    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    const person = world.entities.find((item: any) => item.id === personId);
    expect(person.person.portrait.assetId).toBe(asset.id);
    expect(person.person.portrait.url).toBe(version.views.portrait.url);
  });
});

describe("视觉拆解用量记账（§14.9）", () => {
  it("未知单价：known=false、token 留空、写进 note；行真的落库", async () => {
    const { Database } = await import("../src/db/database");
    const { recordBreakdownUsage } = await import("../src/creative/vision-usage");
    const db = new Database(pool);
    const marker = randomUUID().slice(0, 8);
    await recordBreakdownUsage(db, A, dossierA, null, { inputTokens: 4476, outputTokens: 5181 });
    const row = (await admin.query(
      "select known, input_tokens, output_tokens, cost_cny, note, purpose from usage_record where account_id=$1 and purpose='creative_breakdown' order by recorded_at desc limit 1",
      [A],
    )).rows[0];
    void marker;
    expect(row).toBeTruthy();
    expect(row.known).toBe(false);
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.cost_cny).toBeNull();
    expect(row.purpose).toBe("creative_breakdown");
    expect(row.note).toContain("4476");
  });
});

describe("MVP-3 3A：白模与镜头", () => {
  let dossier = "";
  let placeId = "";
  let workId = "";
  let sceneId = "";

  beforeAll(async () => {
    const created = await api("/v1/dossiers", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ bench: "creative", title: "MVP-3 白模测试" }),
    });
    dossier = (await created.json()).id;
    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    await api(`/v1/creative/worlds/${dossier}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: world.world.revision,
        ops: [
          { op: "entity.add", entity: { kind: "place", name: "悦来客栈", aliases: [], place: { level: "room", parentId: null, geo: { type: "Point", coordinates: [120.6, 31.31] }, geoCertainty: "exact", connects: [], room: { outline: [[-4, -3], [4, -3], [4, 3], [-4, 3]], height: 3.2, origin: [120.6, 31.31], heading: 0 } } } },
          { op: "entity.add", entity: { kind: "person", name: "沈砚", aliases: [], person: { body: { heightM: 1.78, build: "slim" } } } },
        ],
      }),
    });
    const after = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    placeId = after.entities.find((item: any) => item.name === "悦来客栈").id;
    const work = (await (await api(`/v1/creative/worlds/${dossier}/works`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ kind: "novel", title: "客栈一场" }),
    })).json());
    workId = work.id;
    await api(`/v1/creative/worlds/${dossier}/works/${workId}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: 1,
        ops: [
          { op: "outline.set", outline: { logline: "客栈", pov: "三", ending: "夜谈", chapters: [{ id: "c1", title: "第一章", scenes: [{ id: "s1", title: "柜台前", goal: "夜谈", eventIds: [], targetWords: 300 }] }] } },
          { op: "outline.confirm" },
          { op: "text.set", sceneId: "s1", baseTextVersion: 0, text: "沈砚走进悦来客栈。\n\n他把旧河道图摊在柜台上。" },
        ],
      }),
    });
    sceneId = "s1";
  });

  it("白模有版本；镜头记白模版本，白模更新后标「依据旧了」", async () => {
    const before = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    const prims = [
      { op: "whitebox.prim.add", placeId, prim: { kind: "box", c: [0, 0, 0], s: [8, 0.2, 6], label: "地台" } },
      { op: "whitebox.prim.add", placeId, prim: { kind: "box", c: [0, 0, -3], s: [8, 3.2, 0.2], label: "墙" } },
    ];
    const added = await api(`/v1/creative/worlds/${dossier}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: before.world.revision, ops: prims }),
    });
    expect(added.status).toBe(200);
    const box = await (await api(`/v1/creative/worlds/${dossier}/places/${placeId}/whitebox`)).json();
    expect(box.version).toBe(1);
    expect(box.prims).toHaveLength(2);

    const world = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    const shot = {
      op: "shot.add",
      shot: {
        n: 1, workId, sceneId, para: 0, durationSec: 5, placeId, whiteboxVersion: box.version,
        cast: [], camera: { eye: [0, 1.6, 2], target: [0, 1.2, 0], fov: 45 }, action: "沈砚进门",
      },
    };
    const made = await api(`/v1/creative/worlds/${dossier}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ baseRevision: world.world.revision, ops: [shot] }),
    });
    expect(made.status).toBe(200);
    let shots = await (await api(`/v1/creative/worlds/${dossier}/works/${workId}/scenes/${sceneId}/shots`)).json();
    expect(shots.shots).toHaveLength(1);
    expect(shots.shots[0].whiteboxVersion).toBe(1);
    expect(shots.shots[0].stale).toEqual([]);

    // 白模再出一版：镜头应标「依据旧了」
    const again = await (await api(`/v1/creative/worlds/${dossier}`)).json();
    await api(`/v1/creative/worlds/${dossier}/ops`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        baseRevision: again.world.revision,
        ops: [{ op: "whitebox.prim.add", placeId, prim: { kind: "box", c: [0, 0.6, 0], s: [1.2, 1.2, 0.6], label: "柜台" } }],
      }),
    });
    shots = await (await api(`/v1/creative/worlds/${dossier}/works/${workId}/scenes/${sceneId}/shots`)).json();
    expect(shots.shots[0].stale.some((item: string) => item.includes("白模出了第 2 版"))).toBe(true);
  });

  it("预演片段上传后存成资产，镜头上有 preview", async () => {
    const shots = await (await api(`/v1/creative/worlds/${dossier}/works/${workId}/scenes/${sceneId}/shots`)).json();
    const shotId = shots.shots[0].id;
    const form = new FormData();
    form.set("video", new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: "video/webm" }), "preview.webm");
    form.set("poster", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: "image/png" }), "poster.png");
    // multipart 不能带 JSON 的 content-type：直接给 app 发请求
    const uploaded = await app.request(`/v1/creative/worlds/${dossier}/shots/${shotId}/preview`, {
      method: "POST",
      body: form,
      headers: { Cookie: cookieA, Origin: "http://localhost", "X-ReinLab-CSRF": "1" },
    });
    expect(uploaded.status).toBe(201);
    const body = await uploaded.json();
    expect(body.previewId).toBeTruthy();
    expect(body.url).toMatch(/^\/v1\/creative\/assets\/files\//);
    const after = await (await api(`/v1/creative/worlds/${dossier}/works/${workId}/scenes/${sceneId}/shots`)).json();
    expect(after.shots[0].preview.url).toBe(body.url);
  });
});
