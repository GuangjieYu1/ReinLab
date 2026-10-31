/**
 * 探索台第二版 B1：现场记录、修订快照、离线包（10-explore-v2-contract.md §2.1–2.2）。
 *
 * 只测这一批真会出错的地方：离线队列重发/更正/点被删的语义、修订留档不被覆盖、
 * 清单与代取白名单和上限。上游瓦片用注入的通道，其余都走真实数据库与接口。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { KernelAuth } from "../src/kernel/auth";
import { subscribe } from "../src/dossier/service";
import { mapConfigFrom } from "../src/explore/map-config";
import { localExploreStorage } from "../src/explore/storage";
import type { OfflineFetch } from "../src/explore/offline";

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
const now = () => Math.floor(Date.now() / 1000);
const A = randomUUID();
const B = randomUUID();
const dossierA = randomUUID();
const DAY = "2026-11-08";
let app: Awaited<ReturnType<typeof createApp>>;
let cookieA = "";
let cookieB = "";
let storageRoot = "";

/** 上游取数：瓦片/字形给假字节，TileJSON 给 maxzoom=14（和 OpenFreeMap 一样）。 */
const upstream: string[] = [];
const offlineFetch: OfflineFetch = async (url) => {
  upstream.push(url);
  if (url.endsWith("/planet"))
    return {
      ok: true,
      status: 200,
      body: Buffer.from(
        JSON.stringify({
          tiles: ["https://tiles.example/planet/2026/{z}/{x}/{y}.pbf"],
          minzoom: 0,
          maxzoom: 14,
          attribution: "© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap",
        }),
      ),
    };
  if (url.includes("/fonts/")) return { ok: true, status: 200, body: Buffer.from("glyph:" + url) };
  return { ok: true, status: 200, body: Buffer.from("tile:" + url) };
};

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

const readPlan = async () => (await app.request(`/v1/explore/plans/${dossierA}`, { headers: headers() })).json();

/** 抽样会先取每级首尾两张：测试要挑一张「没被抽样过」的瓦片才看得到真实代取。 */
function middleTile<T extends { z: number }>(tiles: T[]): T {
  const byZoom = new Map<number, T[]>();
  for (const tile of tiles) byZoom.set(tile.z, [...(byZoom.get(tile.z) ?? []), tile]);
  for (const list of byZoom.values()) if (list.length >= 3) return list[Math.floor(list.length / 2)];
  return tiles[Math.floor(tiles.length / 2)];
}

const stopOp = (name: string, coordinates: [number, number], day = DAY) => ({
  op: "stop.add",
  stop: {
    kind: "spot",
    name,
    geometry: { type: "Point", coordinates },
    day,
    window: { start: `${day}T07:10:00+08:00`, end: `${day}T07:50:00+08:00` },
    reason: "清晨逆光",
  },
});

const postEvents = async (events: unknown[], key = randomUUID()) =>
  app.request(`/v1/explore/plans/${dossierA}/field-events`, {
    method: "POST",
    headers: headers(cookieA, key),
    body: JSON.stringify({ events }),
  });

const getEvents = async (cookie = cookieA) =>
  (await app.request(`/v1/explore/plans/${dossierA}/field-events`, { headers: headers(cookie) })).json();

const fieldEvent = (input: Record<string, unknown>) => ({
  clientId: randomUUID(),
  kind: "arrived",
  stopId: null,
  stopName: null,
  planRevision: 1,
  at: `${DAY}T17:42:00+08:00`,
  tz: "Asia/Shanghai",
  ...input,
});

const offlinePack = async (day = DAY, detail?: "low", cookie = cookieA) =>
  app.request(`/v1/explore/plans/${dossierA}/offline-packs`, {
    method: "POST",
    headers: headers(cookie, randomUUID()),
    body: JSON.stringify({ day, ...(detail ? { detail } : {}) }),
  });

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name) values($1,'A'),($2,'B')", [A, B]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration',$3,$4)",
    [dossierA, A, "呼伦贝尔秋日", "/data/dossiers/" + dossierA],
  );
  cookieA = await issueSession(A);
  cookieB = await issueSession(B);
  storageRoot = await mkdtemp(join(tmpdir(), "reinlab-explore-b1-"));
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    mapConfig: () =>
      mapConfigFrom({
        MAP_VECTOR_TILEJSON: "https://tiles.example/planet",
        MAP_VECTOR_GLYPHS: "https://tiles.example/fonts/{fontstack}/{range}.pbf",
      }),
    exploreStorage: localExploreStorage(storageRoot),
    offlineFetch,
  });
  // 两个相邻机位（都在拍摄日、都是候选）：现场记录、修订快照、离线包都从这两点起步。
  for (const [name, coordinates] of [
    ["一号机位", [119.77, 49.22]],
    ["二号机位", [119.7712, 49.2208]],
  ] as [string, [number, number]][]) {
    const revision = (await readPlan()).plan.revision;
    const response = await ops({ baseRevision: revision, ops: [stopOp(name, coordinates)] });
    expect(response.status).toBe(200);
  }
}, 40_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe("现场记录", () => {
  it("离线新增的记录按 clientId 幂等入库，重复上传只存一份并推 explore.field", async () => {
    const seen: any[] = [];
    const stop = subscribe(A, "exploration", (event) => seen.push(event));
    try {
      const arrived = fieldEvent({ kind: "arrived", at: `${DAY}T17:40:00+08:00` });
      const note = fieldEvent({ kind: "note", text: "风大，三脚架压了石头" });
      const first = await postEvents([arrived, note]);
      expect(first.status).toBe(200);
      const body = await first.json();
      expect(body.planRevision).toBe((await readPlan()).plan.revision);
      expect(body.results.map((row: any) => row.status)).toEqual(["ok", "ok"]);
      expect(body.results[0].serverId).toMatch(/^[0-9a-f-]{36}$/);

      // 网络超时后整批重发：同一份内容只存一份。
      const again = await (await postEvents([arrived, note])).json();
      expect(again.results.map((row: any) => row.status)).toEqual(["duplicate", "duplicate"]);
      const listed = await getEvents();
      expect(listed.items).toHaveLength(2);
      // 设备记的现场时间带偏移，接收时间另存，不顶替现场时间。
      expect(listed.items[0].at).toBe(`${DAY}T17:40:00+08:00`);
      expect(listed.items[0].receivedAt).toMatch(/Z$/);
      expect(seen.filter((event) => event.type === "explore.field")).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("同一条记录内容变了就报冲突，不覆盖服务端；页面据此二选一", async () => {
    const clientId = randomUUID();
    await postEvents([fieldEvent({ clientId, kind: "note", text: "先记一句" })]);
    const conflict = await (
      await postEvents([fieldEvent({ clientId, kind: "note", text: "本地又改了" })])
    ).json();
    expect(conflict.results[0].status).toBe("conflict");
    expect(conflict.results[0].server.text).toBe("先记一句");
    const listed = await getEvents();
    expect(listed.items.find((row: any) => row.clientId === clientId).text).toBe("先记一句");
  });

  it("更正是一条新记录：改文字、撤销、撤销那次撤销都能还原", async () => {
    const clientId = randomUUID();
    await postEvents([fieldEvent({ clientId, kind: "note", text: "17:40 到了" })]);
    const edit = fieldEvent({ kind: "correction", refersTo: clientId, correction: { action: "edit", text: "17:52 才到" }, at: `${DAY}T17:55:00+08:00` });
    const edited = await (await postEvents([edit])).json();
    expect(edited.results[0].status).toBe("ok");
    let listed = await getEvents();
    let row = listed.items.find((item: any) => item.clientId === clientId);
    // 原文字不改，叠加后的有效内容与状态另给。
    expect(row.text).toBe("17:40 到了");
    expect(row.effectiveText).toBe("17:52 才到");

    const undoEdit = fieldEvent({ kind: "correction", refersTo: edit.clientId, correction: { action: "retract" }, at: `${DAY}T18:05:00+08:00` });
    await postEvents([undoEdit]);
    listed = await getEvents();
    row = listed.items.find((item: any) => item.clientId === clientId);
    expect(row.effectiveText).toBe("17:40 到了");

    const retract = fieldEvent({ kind: "correction", refersTo: clientId, correction: { action: "retract" }, at: `${DAY}T18:10:00+08:00` });
    await postEvents([retract]);
    listed = await getEvents();
    row = listed.items.find((item: any) => item.clientId === clientId);
    expect(row.status).toBe("retracted");
  });

  it("点被删后记录不丢：保留当时的名称、标 orphan，重新关联后回到 ok", async () => {
    const plan = await readPlan();
    const stopId = plan.plan.stops[0].id as string;
    await ops({ baseRevision: plan.plan.revision, ops: [{ op: "stop.remove", id: stopId }] });
    const clientId = randomUUID();
    const uploaded = await (
      await postEvents([fieldEvent({ clientId, kind: "shot", stopId, stopName: "白川旁的石桥" })])
    ).json();
    expect(uploaded.results[0].status).toBe("orphan");
    let listed = await getEvents();
    let row = listed.items.find((item: any) => item.clientId === clientId);
    expect(row.status).toBe("orphan");
    expect(row.stopName).toBe("白川旁的石桥");

    const current = await readPlan();
    const alive = current.plan.stops.find((stop: any) => stop.id !== stopId);
    await postEvents([
      fieldEvent({ kind: "correction", refersTo: clientId, correction: { action: "relink", stopId: alive.id }, at: `${DAY}T18:30:00+08:00` }),
    ]);
    listed = await getEvents();
    row = listed.items.find((item: any) => item.clientId === clientId);
    expect(row.status).toBe("ok");
    expect(row.stopId).toBe(alive.id);
    // 服务端不会因为旧记录把停留点恢复回来。
    expect((await readPlan()).plan.stops.some((stop: any) => stop.id === stopId)).toBe(false);
  });

  it("LAN 反代下来的写请求按页面看到的源校验（https origin + X-Forwarded-*）", async () => {
    const lanHeaders = {
      Cookie: cookieA,
      Origin: "https://reinlab.local:8443",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "reinlab.local:8443",
      "X-ReinLab-CSRF": "1",
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    };
    const accepted = await app.request(`/v1/explore/plans/${dossierA}/field-events`, {
      method: "POST",
      headers: lanHeaders,
      body: JSON.stringify({ events: [fieldEvent({ kind: "note", text: "回来再补一句" })] }),
    });
    expect(accepted.status).toBe(200);

    // 换个源就不认：跨站表单拿不走这份记录。
    const rejected = await app.request(`/v1/explore/plans/${dossierA}/field-events`, {
      method: "POST",
      headers: { ...lanHeaders, Origin: "https://evil.example" },
      body: JSON.stringify({ events: [fieldEvent({ kind: "note", text: "伪造" })] }),
    });
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).code).toBe("AUTH_ORIGIN_DENIED");
  });

  it("情况变了的事件也入库（B2 的调整只是把它发进对话）", async () => {
    const clientId = randomUUID();
    await postEvents([
      fieldEvent({ clientId, kind: "situation", situation: "rain", text: "下大雨了，先躲一下" }),
    ]);
    const listed = await getEvents();
    const row = listed.items.find((item: any) => item.clientId === clientId);
    expect(row.situation).toBe("rain");
    expect(row.text).toBe("下大雨了，先躲一下");
  });
});

describe("修订快照", () => {
  it("每次生效的修改都留一份，旧修订不会被覆盖", async () => {
    const before = (await readPlan()).plan;
    const added = await (
      await ops({ baseRevision: before.revision, ops: [stopOp("三号机位", [119.7734, 49.2216])] })
    ).json();
    const revision = added.revision as number;

    const current = await (
      await app.request(`/v1/explore/plans/${dossierA}/revisions/${revision}`, { headers: headers() })
    ).json();
    expect(current.plan.revision).toBe(revision);
    expect(current.plan.stops.map((stop: any) => stop.name)).toContain("三号机位");
    // 形状和 GET 计划一致：离线包直接拿它当出发那一版。
    expect(Array.isArray(current.canvas)).toBe(true);
    expect(current.basemap).toBe("vector");

    const older = await app.request(`/v1/explore/plans/${dossierA}/revisions/${revision - 1}`, {
      headers: headers(),
    });
    expect(older.status).toBe(200);
    const past = await older.json();
    expect(past.plan.stops.map((stop: any) => stop.name)).not.toContain("三号机位");
  });

  it("别的账户拿不到这份修订", async () => {
    const denied = await app.request(`/v1/explore/plans/${dossierA}/revisions/1`, {
      headers: headers(cookieB),
    });
    expect([403, 404]).toContain(denied.status);
  });
});

describe("离线包", () => {
  it("没有停留点的日子不生成清单，如实说没点", async () => {
    const response = await offlinePack("2027-01-01");
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("OFFLINE_NO_STOPS");
  });

  it("清单固定修订、给出瓦片/字形模板和范围，大小按抽样估并如实标未知", async () => {
    const response = await offlinePack();
    expect(response.status).toBe(201);
    const { pack } = await response.json();
    const plan = (await readPlan()).plan;
    expect(pack.planRevision).toBe(plan.revision);
    expect(pack.day).toBe(DAY);
    expect(pack.area.corridorM).toBe(500);
    expect(pack.area.stopRadiusM).toBe(1000);
    expect(pack.tiles.length).toBeGreaterThan(0);
    expect(pack.tiles.every((tile: any) => tile.url.startsWith(`/v1/explore/offline-tiles/${pack.packId}/`))).toBe(true);
    expect(pack.tileTemplate).toBe(`/v1/explore/offline-tiles/${pack.packId}/{z}/{x}/{y}`);
    // 源 maxzoom=14：不请求不存在的级别。
    expect(pack.tileZoom.max).toBeLessThanOrEqual(14);
    expect(pack.glyphTemplate).toBe("/v1/explore/offline-glyphs/{fontstack}/{range}.pbf");
    expect(pack.glyphs.map((glyph: any) => glyph.url)).toContain(
      "/v1/explore/offline-glyphs/Noto%20Sans%20Regular/0-255.pbf",
    );
    expect(pack.limit.maxTiles).toBe(3000);
    expect(pack.limit.maxBytes).toBe(52428800);
    expect(pack.limit.withinLimit).toBe(true);
    expect(pack.plan).toBe(`/v1/explore/plans/${dossierA}/revisions/${plan.revision}`);
    // 没取到的见光按未知写出来，不假装算过。
    expect(pack.unknowns.some((line: string) => line.includes("地形见光"))).toBe(true);
  });

  it("detail=low 只带低级别，瓦片数不比全量多", async () => {
    const full = (await (await offlinePack()).json()).pack;
    const low = (await (await offlinePack(DAY, "low")).json()).pack;
    expect(low.tileZoom.max).toBeLessThanOrEqual(13);
    expect(low.tiles.length).toBeLessThanOrEqual(full.tiles.length);
  });

  it("按清单代取瓦片：清单外的不取，取过的重取不再请求上游", async () => {
    const { pack } = await (await offlinePack()).json();
    const listed = middleTile(pack.tiles);
    const path = `/v1/explore/offline-tiles/${pack.packId}/${listed.z}/${listed.x}/${listed.y}`;
    const before = upstream.length;
    const first = await app.request(path, { headers: headers() });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/vnd.mapbox-vector-tile");
    expect(Buffer.from(await first.arrayBuffer()).toString()).toContain("/planet/");
    expect(upstream.length).toBeGreaterThan(before);

    const second = await app.request(path, { headers: headers() });
    expect(second.status).toBe(200);
    expect(upstream.length).toBe(before + 1);

    const notListed = await app.request(`/v1/explore/offline-tiles/${pack.packId}/14/0/0`, {
      headers: headers(),
    });
    expect(notListed.status).toBe(404);
    expect((await notListed.json()).code).toBe("OFFLINE_TILE_NOT_LISTED");
  });

  it("清单里的 tileBytes 是真实取到的字节；准备页能重取清单查完整性", async () => {
    const { pack } = await (await offlinePack()).json();
    const listed = middleTile(pack.tiles);
    await app.request(`/v1/explore/offline-tiles/${pack.packId}/${listed.z}/${listed.x}/${listed.y}`, {
      headers: headers(),
    });
    const reread = await (
      await app.request(`/v1/explore/plans/${dossierA}/offline-packs/${pack.packId}`, { headers: headers() })
    ).json();
    expect(reread.tileBytes).toBeGreaterThan(pack.tileBytes);
    expect(reread.limit.note).toContain("服务端已代取");
  });

  it("离线源 TileJSON 把瓦片地址改成这个包的代取路由", async () => {
    const { pack } = await (await offlinePack()).json();
    const response = await app.request(`/v1/explore/offline-packs/${pack.packId}/tilejson`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tiles).toEqual([`http://localhost/v1/explore/offline-tiles/${pack.packId}/{z}/{x}/{y}`]);
    expect(body.maxzoom).toBe(pack.tileZoom.max);
  });

  it("字形只给拉丁/标点区段，中文区段明确拒绝", async () => {
    const latin = await app.request("/v1/explore/offline-glyphs/Noto%20Sans%20Regular/0-255.pbf", {
      headers: headers(),
    });
    expect(latin.status).toBe(200);
    expect(Buffer.from(await latin.arrayBuffer()).toString()).toContain("/fonts/");
    const cjk = await app.request("/v1/explore/offline-glyphs/Noto%20Sans%20Regular/19968-20223.pbf", {
      headers: headers(),
    });
    expect(cjk.status).toBe(404);
  });

  it("别的账户拿不到清单和瓦片", async () => {
    const { pack } = await (await offlinePack()).json();
    const denied = await app.request(`/v1/explore/plans/${dossierA}/offline-packs/${pack.packId}`, {
      headers: headers(cookieB),
    });
    expect([403, 404]).toContain(denied.status);
    const tile = await app.request(`/v1/explore/offline-tiles/${pack.packId}/10/0/0`, {
      headers: headers(cookieB),
    });
    expect([403, 404]).toContain(tile.status);
  });
});
