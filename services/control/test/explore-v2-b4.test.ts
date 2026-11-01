/**
 * B4 后端：建筑场景接口、双位置受光重算、示意字段的校验、离线包带场景。
 *
 * 外部取数全部注入：Overpass 给一份含「东边一堵墙」的固定数据，高程给平地。
 * 验的是接线与语义（改了位置自动重算、参数对得上器材、未知不编），不是真连外网。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { Database } from "../src/db/database";
import { KernelAuth } from "../src/kernel/auth";
import { localSceneStore, type OverpassTransport } from "../src/explore/scene";
import { localExploreStorage } from "../src/explore/storage";
import { configureLightJobs } from "../src/explore/light-job";
import type { ElevationTransport } from "../src/explore/terrain";
import { subscribe } from "../src/dossier/service";

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
const A = randomUUID();
const dossier = randomUUID();
const DAY = "2026-11-08";
const TZ = "Asia/Shanghai";
let app: Awaited<ReturnType<typeof createApp>>;
let cookieA = "";
let root = "";
let overpassCalls = 0;

/** 停留点东边 30–60 m 一堵 40 m 高的墙：早晨会被它挡住。 */
const eastWall = {
  elements: [
    {
      type: "way",
      id: 9,
      tags: { building: "yes", height: "40" },
      geometry: [
        { lat: 39.8995, lon: 116.4003 },
        { lat: 39.8995, lon: 116.401 },
        { lat: 39.9005, lon: 116.401 },
        { lat: 39.9005, lon: 116.4003 },
        { lat: 39.8995, lon: 116.4003 },
      ],
    },
  ],
};

const overpass: OverpassTransport = async () => {
  overpassCalls += 1;
  return { ok: true, status: 200, text: async () => JSON.stringify(eastWall) };
};
/** 平地：地平线全 0，山不挡。 */
const elevation: ElevationTransport = async (url: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    elevation: new Array((new URL(url).searchParams.get("latitude") ?? "").split(",").length).fill(0),
  }),
});

const headers = (key?: string) => ({
  Cookie: cookieA,
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

const ops = (body: unknown) =>
  app.request(`/v1/explore/plans/${dossier}/ops`, {
    method: "POST",
    headers: headers(randomUUID()),
    body: JSON.stringify(body),
  });

const readPlan = async () => (await app.request(`/v1/explore/plans/${dossier}`, { headers: headers() })).json();

/** 等一条探索事件（自动重算是后台跑的）。 */
function waitFor(type: string, timeoutMs = 8000) {
  return new Promise<any>((done) => {
    const timer = setTimeout(() => {
      stop();
      done(null);
    }, timeoutMs);
    const stop = subscribe(A, "exploration", (event: any) => {
      if (event?.type !== type) return;
      clearTimeout(timer);
      stop();
      done(event);
    });
  });
}

let stopId = "";

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name) values($1,'A')", [A]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','白模测试',$3)",
    [dossier, A, "/data/dossiers/" + dossier],
  );
  cookieA = await issueSession(A);
  root = await mkdtemp(join(tmpdir(), "reinlab-b4-"));
  const sceneStore = localSceneStore(root);
  const database = new Database(pool);
  configureLightJobs({
    db: database,
    sceneStore,
    overpass,
    elevation,
    publish: (account, event) => {
      // 和 main.ts 一样推给页面
      void import("../src/dossier/service").then(({ publishAccountEvent }) =>
        publishAccountEvent(account, "exploration", event as never),
      );
    },
  });
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    sceneStore,
    exploreStorage: localExploreStorage(root),
    overpass,
    elevation,
    // 离线包要矢量底图的 TileJSON：这里给一份假的，不联外网。
    offlineFetch: async (url: string) =>
      url.endsWith("/planet")
        ? {
            ok: true,
            status: 200,
            body: Buffer.from(
              JSON.stringify({ tiles: ["https://tiles.example/planet/{z}/{x}/{y}.pbf"], minzoom: 0, maxzoom: 14 }),
            ),
          }
        : { ok: true, status: 200, body: Buffer.from("tile") },
  });
  // 计划：北京、指定时区、一个已确认机位（窗口在早晨，方便看楼挡）
  const plan = await readPlan();
  const created = await ops({
    baseRevision: plan.plan.revision,
    ops: [
      {
        op: "plan.set",
        patch: { destination: { name: "北京", center: [116.4, 39.9], timezone: TZ }, days: [DAY] },
      },
      {
        op: "stop.add",
        stop: {
          kind: "spot",
          name: "东边那面楼",
          geometry: { type: "Point", coordinates: [116.4, 39.9] },
          day: DAY,
          window: { start: `${DAY}T08:00:00+08:00`, end: `${DAY}T09:00:00+08:00` },
          state: "confirmed",
        },
      },
    ],
  });
  const body = await created.json();
  stopId = body.applied.find((entry: any) => entry.result?.stop)?.result.stop.id;
  expect(stopId).toBeTruthy();
  // 第一次自动重算（stop.add 之后排队）：等它落库
  await waitFor("explore.light");
}, 60_000);

afterAll(async () => {
  configureLightJobs(null);
  await pool.end();
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

describe("建筑场景接口", () => {
  it("按停留点取场景：真实轮廓、楼高来源、覆盖状态都有", async () => {
    const response = await app.request(`/v1/explore/plans/${dossier}/scene?stopId=${stopId}`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const scene = await response.json();
    expect(scene.id).toMatch(/^[a-f0-9]{16}$/);
    expect(scene.version).toBeGreaterThanOrEqual(1);
    expect(scene.radiusM).toBe(1000);
    expect(scene.origin[0]).toBeCloseTo(116.4, 2);
    expect(scene.buildings).toHaveLength(1);
    expect(scene.buildings[0].heightM).toBe(40);
    expect(scene.buildings[0].heightSource).toBe("tag");
    expect(scene.buildings[0].footprint[0]).toEqual(scene.buildings[0].footprint.at(-1));
    expect(scene.coverage.note).toContain("Copernicus GLO-90");
    expect(scene.source).toContain("OpenStreetMap");
    expect(overpassCalls).toBe(1);
  });

  it("同一个位置再取走缓存，不打第二次 Overpass", async () => {
    await app.request(`/v1/explore/plans/${dossier}/scene?stopId=${stopId}`, { headers: headers() });
    expect(overpassCalls).toBe(1);
  });

  it("没有停留点时明确说没有，不返回空场景冒充", async () => {
    const other = randomUUID();
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','空计划',$3)",
      [other, A, "/data/dossiers/" + other],
    );
    const response = await app.request(`/v1/explore/plans/${other}/scene`, { headers: headers() });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("STOP_NOT_FOUND");
  });
});

describe("双位置受光", () => {
  it("stop.add 之后自动算出 light2，并按版本推送", async () => {
    const plan = await readPlan();
    const stop = plan.plan.stops.find((row: any) => row.id === stopId);
    expect(stop.light2).toBeTruthy();
    expect(stop.light2.sceneId).toBeTruthy();
    expect(stop.light2.version).toBeGreaterThanOrEqual(1);
    expect(stop.light2.camera.segments.length).toBeGreaterThan(1);
    expect(stop.light2.camera.heightAssumed).toBe(true);
    // 东边的墙：早晨有一段时间是楼挡，并指出是哪栋
    const blocked = stop.light2.camera.segments.find((segment: any) => segment.state === "building");
    expect(blocked?.cause?.buildingIds).toContain("way/9");
    // 90 m 高程的精度限制写在计算依据里，不假装是精确值
    expect(stop.light2.dem).toContain("GLO-90");
  });

  it("手动重算：版本 +1，接口给场景状态", async () => {
    const before = await readPlan();
    const version = before.plan.stops.find((row: any) => row.id === stopId).light2.version;
    const response = await app.request(`/v1/explore/plans/${dossier}/light/recompute`, {
      method: "POST",
      headers: headers(randomUUID()),
      body: JSON.stringify({ stopId }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.version).toBe(version + 1);
    expect(body.coverage.status).toBe("ok");
    const after = await readPlan();
    expect(after.plan.stops.find((row: any) => row.id === stopId).light2.version).toBe(version + 1);
  });

  it("改了模特点 / 高度会自动排队重算（不用手动点）", async () => {
    const before = await readPlan();
    const version = before.plan.stops.find((row: any) => row.id === stopId).light2.version;
    const event = waitFor("explore.light");
    const updated = await ops({
      baseRevision: before.plan.revision,
      ops: [
        {
          op: "stop.update",
          id: stopId,
          patch: { subjectPoint: [116.4001, 39.9], cameraHeightM: 2, subjectHeightM: 1.7 },
        },
      ],
    });
    expect(updated.status).toBe(200);
    const published = await event;
    expect(published?.stopId).toBe(stopId);
    const after = await readPlan();
    const stop = after.plan.stops.find((row: any) => row.id === stopId);
    expect(stop.light2.version).toBeGreaterThan(version);
    expect(stop.light2.subject?.point).toEqual([116.4001, 39.9]);
    expect(stop.light2.camera.heightM).toBe(2);
    expect(stop.light2.subject?.heightM).toBe(1.7);
  });

  it("light2 是服务端字段，patch 改不了它", async () => {
    const plan = await readPlan();
    const response = await ops({
      baseRevision: plan.plan.revision,
      ops: [{ op: "stop.update", id: stopId, patch: { light2: { version: 999 } } }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_INPUT");
  });
});

describe("示意字段", () => {
  it("引导词带姿势：十种之外的直接拒绝，null 表示只显示文字", async () => {
    const plan = await readPlan();
    const bad = await ops({
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "stop.update",
          id: stopId,
          patch: { detail: { guidance: [{ text: "回头笑一下", pose: "dance" }] } },
        },
      ],
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toContain("pose");

    const ok = await ops({
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "stop.update",
          id: stopId,
          patch: {
            detail: {
              guidance: [
                { id: "g1", text: "先走两步", pose: "walk" },
                { text: "撩一下头发", pose: null },
                "旧档案那种纯文字也行",
              ],
            },
          },
        },
      ],
    });
    expect(ok.status).toBe(200);
    const saved = (await readPlan()).plan.stops.find((row: any) => row.id === stopId);
    expect(saved.detail.guidance).toHaveLength(3);
    expect(saved.detail.guidance[0]).toMatchObject({ id: "g1", text: "先走两步", pose: "walk" });
    expect(saved.detail.guidance[1].pose).toBeNull();
    expect(saved.detail.guidance[1].id).toBeTruthy();
    expect(saved.detail.guidance[2]).toBe("旧档案那种纯文字也行");
  });

  it("构图框按 0–1 归一化；超出范围拒绝", async () => {
    const plan = await readPlan();
    const bad = await ops({
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "stop.update",
          id: stopId,
          patch: { detail: { frame: { orientation: "portrait", subject: null, horizon: 1.4 } } },
        },
      ],
    });
    expect(bad.status).toBe(400);

    const ok = await ops({
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "stop.update",
          id: stopId,
          patch: {
            detail: {
              frame: { orientation: "portrait", subject: { x: 0.5, y: 0.45, w: 0.4, h: 0.7 }, horizon: 0.6 },
            },
          },
        },
      ],
    });
    expect(ok.status).toBe(200);
    const frame = (await readPlan()).plan.stops.find((row: any) => row.id === stopId).detail.frame;
    expect(frame.orientation).toBe("portrait");
    expect(frame.subject).toEqual({ x: 0.5, y: 0.45, w: 0.4, h: 0.7 });
    expect(frame.horizon).toBe(0.6);
  });

  it("机身传感器：可写可读，镜头不带传感器", async () => {
    const body = await app.request("/v1/profiles", {
      headers: headers(randomUUID()),
      method: "POST",
      body: JSON.stringify({
        type: "gear",
        kind: "body",
        name: "X100V",
        sensor: { wMm: 23.5, hMm: 15.6 },
      }),
    });
    expect(body.status).toBe(201);
    const profile = await body.json();
    expect(profile.sensor).toEqual({ wMm: 23.5, hMm: 15.6 });
    const lens = await app.request("/v1/profiles", {
      headers: headers(randomUUID()),
      method: "POST",
      body: JSON.stringify({
        type: "gear",
        kind: "lens",
        name: "23mm F2",
        focal: [23, 23],
        aperture: 2,
        sensor: { wMm: 36, hMm: 24 },
      }),
    });
    expect(lens.status).toBe(201);
    expect((await lens.json()).sensor).toBeUndefined();
  });

  it("参数要在所选器材的范围内：焦段越界拒绝，范围内的照收", async () => {
    const profiles = await (await app.request("/v1/profiles?type=gear", { headers: headers() })).json();
    const lens = profiles.items.find((row: any) => row.kind === "lens" && row.focal?.[0] === 23);
    expect(lens).toBeTruthy();
    const plan = await readPlan();
    const selected = await ops({
      baseRevision: plan.plan.revision,
      ops: [{ op: "plan.select", gear: [lens.id] }],
    });
    expect(selected.status).toBe(200);

    const current = await readPlan();
    const outOfRange = await ops({
      baseRevision: current.plan.revision,
      ops: [
        {
          op: "stop.update",
          id: stopId,
          patch: {
            detail: { settings: { lensId: lens.id, focalMm: 85, aperture: 2, shutterS: 0.004, iso: 400 } },
          },
        },
      ],
    });
    expect(outOfRange.status).toBe(400);
    expect((await outOfRange.json()).message).toContain("mm");

    const okay = await ops({
      baseRevision: current.plan.revision,
      ops: [
        {
          op: "stop.update",
          id: stopId,
          patch: {
            detail: {
              settings: {
                lensId: lens.id,
                focalMm: 23,
                aperture: 2,
                shutterS: 1 / 250,
                iso: 400,
                snapshot: { lens: "23mm F2" },
              },
            },
          },
        },
      ],
    });
    expect(okay.status).toBe(200);
    const settings = (await readPlan()).plan.stops.find((row: any) => row.id === stopId).detail.settings;
    expect(settings.focalMm).toBe(23);
    expect(settings.iso).toBe(400);
    // 只给了资料 id：服务端写入时按计划所选器材补一份名称快照（PDF 不查库，只认这份）。
    expect(settings.snapshot?.lens).toBe("23mm F2");
  });
});

describe("离线包带场景与受光", () => {
  it("清单里列出已确认停留点的场景地址，未知项照实写", async () => {
    const plan = await readPlan();
    const pack = await (
      await app.request(`/v1/explore/plans/${dossier}/offline-packs`, {
        method: "POST",
        headers: headers(randomUUID()),
        body: JSON.stringify({ day: DAY }),
      })
    ).json();
    expect(pack.pack.scenes).toHaveLength(1);
    expect(pack.pack.scenes[0].stopId).toBe(stopId);
    expect(pack.pack.scenes[0].url).toBe(`/v1/explore/plans/${dossier}/scene?stopId=${stopId}`);
    void plan;
  });

  it("离线光线快照带 light2、场景 id 与计算范围", async () => {
    const light = await (
      await app.request(`/v1/explore/plans/${dossier}/offline-light?day=${DAY}`, { headers: headers() })
    ).json();
    const stop = light.stops.find((row: any) => row.stopId === stopId);
    expect(stop.light2).toBeTruthy();
    expect(stop.light2.sceneId).toBeTruthy();
    expect(stop.light2.radiusM).toBe(1000);
    expect(stop.cameraHeightM).toBe(2);
    expect(stop.light2.camera.segments.length).toBeGreaterThan(1);
  });
});
