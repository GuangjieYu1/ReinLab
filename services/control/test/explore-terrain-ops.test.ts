import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { configureGeoProviders } from "../src/explore/providers";
import { AZIMUTH_STEP_DEG, DISTANCE_KM, configureTerrainTransport } from "../src/explore/terrain";

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
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','地形冒烟',$3)",
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
  configureTerrainTransport(undefined);
  await pool.end();
  await admin.end();
});

describe("停留点写入时带上真实地形见光", () => {
  it("新建一个东侧有山的机位：计划里直接有地平线曲线与见光时段", async () => {
    // 真实性之外的可测性：注入一份「东侧 300 米山脊」的高程。
    configureGeoProviders({ amapKey: null, orsKey: null });
    configureTerrainTransport(async () => {
      const azimuths: number[] = [];
      for (let azimuth = 0; azimuth < 360; azimuth += AZIMUTH_STEP_DEG) azimuths.push(azimuth);
      const elevation: number[] = [50];
      for (const azimuth of azimuths)
        for (const _distance of DISTANCE_KM)
          elevation.push(azimuth >= 60 && azimuth <= 120 ? 320 : 55);
      return { ok: true, status: 200, json: async () => ({ elevation }) };
    });

    const plan = await planOf();
    const created = await ops({
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "plan.set",
          patch: {
            destination: { name: "京都 · 东山", center: [135.7681, 35.0116], timezone: "Asia/Tokyo" },
            days: ["2026-11-15"],
          },
        },
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "白川桥",
            geometry: { type: "Point", coordinates: [135.7681, 35.0116] },
            day: "2026-11-15",
            window: { start: "2026-11-15T07:00:00+09:00", end: "2026-11-15T07:40:00+09:00" },
            state: "confirmed",
          },
        },
      ],
    });
    expect(created.status).toBe(200);

    const after = await planOf();
    const stop = after.plan.stops[0];
    expect(stop.light).toBeTruthy();
    expect(stop.light.horizon.length).toBeGreaterThan(20);
    expect(stop.light.basis).toMatchObject({ radiusKm: 6, resolutionM: 90 });
    const east = stop.light.horizon.find((row: any) => row.azimuth === 90);
    expect(east.elevation).toBeGreaterThan(5);
    // 见光比日出晚（东侧山挡着）。
    expect(stop.light.lit.length).toBeGreaterThan(0);
    expect(stop.light.lit[0].start > "2026-11-15T06:32:00+09:00").toBe(true);
  });

  it("取不到高程时不留假数据：light 保持未知", async () => {
    configureTerrainTransport(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const plan = await planOf();
    const created = await ops({
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "没有地形的点",
            geometry: { type: "Point", coordinates: [135.80, 35.02] },
            day: "2026-11-15",
            state: "confirmed",
          },
        },
      ],
    });
    expect(created.status).toBe(200);
    const added = (await planOf()).plan.stops.find((row: any) => row.name === "没有地形的点");
    expect(added.light).toBeUndefined();
  });
});
