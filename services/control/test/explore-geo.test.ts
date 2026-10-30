import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { gcj02ToWgs84, likelyMainlandChina, wgs84ToGcj02, straightDistanceMeters } from "../src/explore/geo";
import {
  conflictsOf,
  configureGeoProviders,
  providerFor,
  searchPlaces,
  walkLegs,
  walkingRoute,
  type GeoTransport,
} from "../src/explore/providers";
import type { RouteLeg, Stop } from "@reinlab/contracts";

const KYOTO: [number, number] = [135.7681, 35.0116];
const BEIJING: [number, number] = [116.3912, 39.9073];

/** 按 URL 回不同内容的假传输层：测试不连外网。 */
function fakeTransport(routes: Record<string, any>): GeoTransport {
  return async (url) => {
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  };
}

describe("坐标语义（只在走高德时纠偏）", () => {
  it("北京一带纠偏约 500 米，来回换误差在米级", () => {
    const gcj = wgs84ToGcj02(BEIJING);
    expect(straightDistanceMeters(BEIJING, gcj)).toBeGreaterThan(300);
    expect(straightDistanceMeters(BEIJING, gcj)).toBeLessThan(900);
    expect(straightDistanceMeters(BEIJING, gcj02ToWgs84(gcj))).toBeLessThan(1);
  });

  it("海外坐标不会被这套纠偏动到（走 ORS 就不转）", () => {
    expect(providerFor({ near: KYOTO })).toBe("ors");
    expect(providerFor({ timezone: "Asia/Tokyo" })).toBe("ors");
    expect(providerFor({ timezone: "Asia/Shanghai" })).toBe("amap");
    expect(providerFor({ timezone: "Asia/Tokyo", near: BEIJING })).toBe("amap");
    expect(providerFor({ provider: "ors", timezone: "Asia/Shanghai" })).toBe("ors");
    // 粗判断只用来挑服务商：京都明明也落在那套 bbox 外。
    expect(likelyMainlandChina(BEIJING)).toBe(true);
    expect(likelyMainlandChina(KYOTO)).toBe(false);
  });
});

describe("地点搜索与步行路线", () => {
  it("没配服务就说缺哪一项，不偷偷换来源", async () => {
    configureGeoProviders({ amapKey: null, orsKey: null });
    await expect(searchPlaces({ q: "白川", timezone: "Asia/Shanghai" })).rejects.toThrowError(/AMAP_KEY/);
    await expect(searchPlaces({ q: "Gion", timezone: "Asia/Tokyo" })).rejects.toThrowError(/ORS_KEY/);
    const walk = await walkingRoute({ from: BEIJING, to: [116.4, 39.91], timezone: "Asia/Shanghai" });
    expect(walk.state).toBe("unavailable");
    expect(walk.state === "unavailable" && walk.reason).toContain("AMAP_KEY");
  });

  it("高德：地点从 GCJ-02 转回 WGS84，路线顶点同样转", async () => {
    const gcj = wgs84ToGcj02(BEIJING);
    configureGeoProviders({
      amapKey: "test-amap",
      orsKey: null,
      transport: fakeTransport({
        "https://restapi.amap.com/v3/place/text": {
          status: "1",
          pois: [{ name: "白川桥", address: "某某路", location: `${gcj[0]},${gcj[1]}` }],
        },
        // 高德 v3 步行导航的真实形状（v4 对 Web 服务 key 返回 SERVICE_NOT_AVAILABLE）
        "https://restapi.amap.com/v3/direction/walking": {
          status: "1",
          info: "ok",
          route: {
            paths: [
              {
                distance: "1234",
                duration: "900",
                steps: [{ polyline: `${gcj[0]},${gcj[1]};${gcj[0] + 0.001},${gcj[1] + 0.001}` }],
              },
            ],
          },
        },
      }),
    });
    const places = await searchPlaces({ q: "白川桥", near: BEIJING });
    expect(places).toHaveLength(1);
    expect(places[0].source.name).toBe("高德");
    // 回到业务坐标：和原来的 WGS84 点差在 5 米内。
    expect(straightDistanceMeters(places[0].at, BEIJING)).toBeLessThan(5);

    const walk = await walkingRoute({ from: BEIJING, to: [116.4, 39.91], timezone: "Asia/Shanghai" });
    expect(walk.state).toBe("ok");
    if (walk.state === "ok") {
      expect(walk.distanceM).toBe(1234);
      expect(walk.durationS).toBe(900);
      expect(walk.geometry).toHaveLength(2);
      // 第一个顶点转回 WGS84 后应该贴着起点。
      expect(straightDistanceMeters(walk.geometry[0], BEIJING)).toBeLessThan(5);
    }
  });

  it("ORS：海外地点与路线原样用 WGS84", async () => {
    configureGeoProviders({
      amapKey: null,
      orsKey: "test-ors",
      needless: true as never,
      transport: fakeTransport({
        "https://api.openrouteservice.org/geocode/search": {
          features: [
            {
              geometry: { coordinates: KYOTO },
              properties: { name: "Gion", label: "Gion, Kyoto, Japan" },
            },
          ],
        },
        "https://api.openrouteservice.org/v2/directions/foot-walking/geojson": {
          features: [
            {
              geometry: { coordinates: [KYOTO, [135.77, 35.012]] },
              properties: { summary: { distance: 640.2, duration: 480.7 } },
            },
          ],
        },
      }),
    });
    const places = await searchPlaces({ q: "Gion", timezone: "Asia/Tokyo" });
    expect(places[0]).toMatchObject({ name: "Gion", address: "Gion, Kyoto, Japan" });
    expect(places[0].at).toEqual(KYOTO);
    expect(places[0].source.name).toBe("openrouteservice");

    const walk = await walkingRoute({ from: KYOTO, to: [135.77, 35.012], timezone: "Asia/Tokyo" });
    expect(walk.state).toBe("ok");
    if (walk.state === "ok") {
      expect(walk.distanceM).toBe(640);
      expect(walk.durationS).toBe(481);
      expect(walk.geometry[0]).toEqual(KYOTO);
    }
  });

  it("服务端说得清但它不走到就如实报错", async () => {
    configureGeoProviders({
      amapKey: "test-amap",
      orsKey: null,
      transport: async () => ({ ok: false, status: 429, json: async () => ({ info: "LIMIT" }) }),
    });
    await expect(searchPlaces({ q: "白川", timezone: "Asia/Shanghai" })).rejects.toThrowError(/429/);
    const walk = await walkingRoute({ from: BEIJING, to: [116.4, 39.91], timezone: "Asia/Shanghai" });
    expect(walk.state).toBe("unavailable");
  });
});

describe("赶不上拍摄窗口", () => {
  const stop = (id: string, start: string, end: string): Stop => ({
    id,
    kind: "spot",
    state: "confirmed",
    name: id,
    geometry: { type: "Point", coordinates: KYOTO },
    day: "2026-11-15",
    window: { start: `${start}+09:00`, end: `${end}+09:00` },
    refs: [],
    source: "user",
  });

  it("上一段结束加上步行时间赶不上下一段，就说明冲突", () => {
    const stops = [stop("a", "2026-11-15T07:00:00", "2026-11-15T07:40:00"), stop("b", "2026-11-15T08:00:00", "2026-11-15T08:30:00")];
    const legs: RouteLeg[] = [
      {
        from: "a",
        to: "b",
        geometry: { type: "LineString", coordinates: [KYOTO, KYOTO] },
        distanceM: 2000,
        durationS: 30 * 60,
        source: { name: "test" },
      },
    ];
    const conflicts = conflictsOf(stops, legs);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].stopId).toBe("b");
    expect(conflicts[0].text).toContain("08:10");
  });

  it("没有路线或没有时段就不猜冲突", () => {
    const stops = [stop("a", "2026-11-15T07:00:00", "2026-11-15T07:40:00"), stop("b", "2026-11-15T08:00:00", "2026-11-15T08:30:00")];
    expect(conflictsOf(stops, [])).toEqual([]);
  });
});

describe("页面接口：地点搜索与同批次重算路线", () => {
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
    max: 2,
  });
  const pool = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    max: 4,
  });
  const A = randomUUID();
  const dossier = randomUUID();
  let app: Awaited<ReturnType<typeof createApp>>;
  let cookieA = "";

  const headers = (key?: string) => ({
    Cookie: cookieA,
    Origin: "http://localhost",
    "X-ReinLab-CSRF": "1",
    "Content-Type": "application/json",
    ...(key ? { "Idempotency-Key": key } : {}),
  });

  const planOf = async () =>
    (await app.request(`/v1/explore/plans/${dossier}`, { headers: headers() })).json();
  const ops = async (body: unknown) =>
    app.request(`/v1/explore/plans/${dossier}/ops`, {
      method: "POST",
      headers: headers(randomUUID()),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    await applyMigrations(admin, resolve("infra/supabase/migrations"));
    await admin.query("insert into account(id,display_name) values($1,'A')", [A]);
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','京都秋日旅拍',$3)",
      [dossier, A, "/data/dossiers/" + dossier],
    );
    const token = randomBytes(32).toString("base64url");
    await admin.query("select reinlab_session_open($1,$2)", [
      A,
      createHash("sha256").update(token).digest("hex"),
    ]);
    cookieA = "rl_session=" + token;
    app = await createApp({
      pool,
      auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
      kernelTools: { auth: { verify: () => ({}) } as any, dispatch: async () => ({}) },
    });
  }, 40_000);

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("取路线超预算：如实标「这次取路线超时」，不干等也不说成没有路", async () => {
    configureGeoProviders({ amapKey: "test-key", orsKey: null });
    const stops = [
      { id: "s1", kind: "spot", name: "A", geometry: { type: "Point", coordinates: [120.14, 30.25] }, day: "2026-11-12", state: "confirmed" },
      { id: "s2", kind: "spot", name: "B", geometry: { type: "Point", coordinates: [120.15, 30.26] }, day: "2026-11-12", state: "confirmed" },
    ] as never;
    const legs = await walkLegs(stops, { timezone: "Asia/Shanghai", deadline: Date.now() - 1 });
    expect(legs).toHaveLength(1);
    expect(legs[0].geometry).toBeNull();
    expect((legs[0] as Record<string, unknown>).reason).toContain("超时");
  });

  it("没配置地点服务时，搜索框照实说缺哪项（结构化给出缺的键，页面不用猜）", async () => {
    configureGeoProviders({ amapKey: null, orsKey: null });
    const response = await app.request(`/v1/explore/places?q=白川&provider=amap`, { headers: headers() });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("PLACES_NOT_CONFIGURED");
    expect(body).toMatchObject({ provider: "amap", missing: ["AMAP_KEY"] });
    expect(body.message).toContain("高德");
    const overseas = await app.request(`/v1/explore/places?q=Gion&provider=ors`, { headers: headers() });
    expect(await overseas.json()).toMatchObject({ provider: "ors", missing: ["ORS_KEY"] });
  });

  it("配好之后返回真实来源的地点", async () => {
    configureGeoProviders({
      amapKey: null,
      orsKey: "test-ors",
      transport: fakeTransport({
        "https://api.openrouteservice.org/geocode/search": {
          features: [{ geometry: { coordinates: KYOTO }, properties: { name: "Gion", label: "Gion, Kyoto" } }],
        },
      }),
    });
    const body = await (
      await app.request(`/v1/explore/places?q=Gion&provider=ors`, { headers: headers() })
    ).json();
    expect(body.items[0].name).toBe("Gion");
    expect(body.items[0].source.name).toBe("openrouteservice");
  });

  it("确认停留点后，同一批次里就有真实步行路线；改点后重算", async () => {
    configureGeoProviders({
      amapKey: null,
      orsKey: "test-ors",
      transport: fakeTransport({
        "https://api.openrouteservice.org/v2/directions/foot-walking/geojson": {
          features: [
            {
              geometry: { coordinates: [KYOTO, [135.77, 35.012]] },
              properties: { summary: { distance: 800, duration: 700 } },
            },
          ],
        },
      }),
    });
    const plan = await planOf();
    const built = await ops({
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "plan.set",
          patch: {
            destination: { name: "京都 · 东山", center: KYOTO, timezone: "Asia/Tokyo" },
            days: ["2026-11-15"],
          },
        },
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "白川桥",
            geometry: { type: "Point", coordinates: KYOTO },
            day: "2026-11-15",
            window: { start: "2026-11-15T07:00:00+09:00", end: "2026-11-15T07:40:00+09:00" },
            state: "confirmed",
          },
        },
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "哲学之道",
            geometry: { type: "Point", coordinates: [135.79, 35.02] },
            day: "2026-11-15",
            window: { start: "2026-11-15T08:00:00+09:00", end: "2026-11-15T08:30:00+09:00" },
            state: "confirmed",
          },
        },
      ],
    });
    expect(built.status).toBe(200);
    const body = await built.json();
    const after = await planOf();
    expect(after.plan.routes).toHaveLength(1);
    expect(after.plan.routes[0]).toMatchObject({ distanceM: 800, durationS: 700 });
    expect(after.plan.routes[0].geometry.type).toBe("LineString");
    // 这条路线也随 applied 结果一起交给页面（不自己连线）。
    const applied = body.applied;
    expect(applied[applied.length - 1].result.routes).toHaveLength(1);

    // 改一下第二个点的时段：赶不上了，同批次给出冲突。
    const current = await planOf();
    const moved = await ops({
      baseRevision: current.plan.revision,
      ops: [
        {
          op: "stop.update",
          id: current.plan.stops[1].id,
          patch: { window: { start: "2026-11-15T07:45:00+09:00", end: "2026-11-15T08:10:00+09:00" } },
        },
      ],
    });
    expect(moved.status).toBe(200);
    const conflicted = await planOf();
    expect(conflicted.plan.conflicts.length).toBeGreaterThan(0);
    expect(conflicted.plan.conflicts[0].text).toContain("赶不上");
  });

  it("没配置路线服务：路线留空并写明原因，不让整批失败", async () => {
    configureGeoProviders({ amapKey: null, orsKey: null });
    const current = await planOf();
    const response = await ops({
      baseRevision: current.plan.revision,
      ops: [{ op: "plan.set", patch: { kinds: ["portrait"] } }],
    });
    expect(response.status).toBe(200);
    const after = await planOf();
    expect(after.plan.routes.every((leg: any) => leg.geometry === null)).toBe(true);
    expect(after.plan.routes[0]?.reason ?? "").toContain("ORS_KEY");
    expect(after.plan.conflicts).toEqual([]);
  });
});
