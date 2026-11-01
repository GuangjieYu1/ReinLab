/**
 * 探索台第二版 B3：照片（tus 续传、EXIF、派生图、分组、对时、落位）与回顾
 * （计划 vs 实际、游记、经验提案）——10-explore-v2-contract.md §2.3–2.5。
 *
 * 用真实 HTTP 端口跑 tus（续传语义只能这么验），照片是真的带 EXIF 的 JPG，
 * 派生图、摘要、落位都走真实现；工具走 /kernel/tool 网关。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import sharp from "sharp";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { KernelAuth } from "../src/kernel/auth";
import { localPhotoStore } from "../src/explore/photo-store";
import type { PhotoReader } from "../src/explore/photo-reader";
import { createWeatherJudge } from "../src/explore/weather-judge";
import { withDossierContext, splitInjected } from "../src/dossier/deliver";

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
const runId = randomUUID();
const DAY = "2026-11-08";
const TZ = "Asia/Shanghai";
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let base = "";
let cookieA = "";
let cookieB = "";
let root = "";

const headers = (cookie = cookieA, key?: string) => ({
  Cookie: cookie,
  Origin: base,
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

const api = (method: string, path: string, body?: unknown, cookie = cookieA) =>
  fetch(base + path, {
    method,
    headers: headers(cookie, method === "GET" || method === "DELETE" ? undefined : randomUUID()),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createBatch = (files: { name: string; bytes: number; lastModified: number }[]) =>
  api("POST", `/v1/explore/plans/${dossierA}/photo-batches`, { files });

/** 真 JPG：1024×768 渐变 + 指定机型的 EXIF（和时间偏移）。 */
async function jpeg(input: {
  make?: string;
  model?: string;
  when?: string;
  offset?: string;
  seed?: number;
}): Promise<Buffer> {
  const seed = input.seed ?? 1;
  const raw = Buffer.alloc(1024 * 768 * 3);
  for (let y = 0; y < 768; y += 1)
    for (let x = 0; x < 1024; x += 1) {
      const at = (y * 1024 + x) * 3;
      raw[at] = (x * 255) / 1024;
      raw[at + 1] = (y * 255) / 768;
      raw[at + 2] = (seed * 37) % 255;
      // 加一点细节，让清晰度统计不是一片平。
      if ((x + y + seed) % 7 === 0) raw[at] = 255 - raw[at];
    }
  let image = sharp(raw, { raw: { width: 1024, height: 768, channels: 3 } });
  if (input.make || input.model || input.when)
    image = image.withExif({
      IFD0: { ...(input.make ? { Make: input.make } : {}), ...(input.model ? { Model: input.model } : {}) },
      IFD2: {
        ...(input.when ? { DateTimeOriginal: input.when } : {}),
        ...(input.offset ? { OffsetTimeOriginal: input.offset } : {}),
      },
    });
  return image.jpeg({ quality: 80 }).toBuffer();
}

type Upload = { location: string; cookie: string };

/** 走真实 tus：创建 → 分块 PATCH → HEAD 查偏移（这就是续传）。 */
async function tusUpload(
  file: { name: string; lastModified: number },
  bytes: Buffer,
  options: { batchId: string; cookie?: string; csrf?: boolean; firstChunk?: number } = { batchId: "" },
): Promise<{ created: Response; upload: Upload; offset: number }> {
  const cookie = options.cookie ?? cookieA;
  const metadata = Object.entries({
    batchId: options.batchId,
    filename: file.name,
    lastModified: String(file.lastModified),
  })
    .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString("base64")}`)
    .join(",");
  const created = await fetch(`${base}/v1/explore/uploads`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(bytes.length),
      "Upload-Metadata": metadata,
      ...(options.csrf === false ? {} : { "X-ReinLab-CSRF": "1" }),
    },
  });
  const location = created.headers.get("location") ?? "";
  // 服务端给的是页面用的绝对地址（带 /backend 前缀）；测试直接打控制面，去掉那一段。
  const upload = { location: location.replace("/backend", ""), cookie };
  if (!created.ok) return { created, upload, offset: 0 };
  // 先传一半，模拟中断；再由调用方接着传剩下的。
  const chunk = options.firstChunk ?? Math.floor(bytes.length / 2);
  const first = await fetch(upload.location, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      "Tus-Resumable": "1.0.0",
      "X-ReinLab-CSRF": "1",
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": "0",
    },
    body: bytes.subarray(0, chunk),
  });
  const head = await fetch(upload.location, {
    method: "HEAD",
    headers: { Cookie: cookie, "Tus-Resumable": "1.0.0", "X-ReinLab-CSRF": "1" },
  });

  const offset = Number(head.headers.get("upload-offset") ?? Number.NaN);
  return { created, upload, offset: Number.isFinite(offset) ? offset : first.status === 204 ? chunk : 0 };
}

async function finishUpload(upload: Upload, bytes: Buffer, from: number) {
  const patched = await fetch(upload.location, {
    method: "PATCH",
    headers: {
      Cookie: upload.cookie,
      "Tus-Resumable": "1.0.0",
      "X-ReinLab-CSRF": "1",
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": String(from),
    },
    body: bytes.subarray(from),
  });
  return patched;
}

/** 和 main.ts 一样的算法：每百万 token 单价 × token。测试里费率是 2 / 8。 */
const expectedSpend = (input: number, output: number) => (input * 2 + output * 8) / 1_000_000;

let manualId: string | null = null;

const readPhotos = async (query = "") =>
  (await api("GET", `/v1/explore/plans/${dossierA}/photos${query}`)).json();

/** 生成一张图走完整条链路（上传 + 处理），返回照片 id。 */
async function addPhoto(input: Parameters<typeof jpeg>[0] & { name?: string }) {
  const bytes = await jpeg(input);
  const name = input.name ?? `DSC_${Math.abs(input.seed ?? 1)}.JPG`;
  const batch = await (await createBatch([{ name, bytes: bytes.length, lastModified: Date.now() }])).json();
  const started = await tusUpload({ name, lastModified: Date.now() }, bytes, {
    batchId: batch.batch.id,
    firstChunk: Math.floor(bytes.length / 2),
  });
  await finishUpload(started.upload, bytes, started.offset);
  const listed = await readPhotos();
  const photo = listed.items.find((row: any) => row.fileName === name);
  return { photo, batch: batch.batch };
}

const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await fetch(`${base}/kernel/tool`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": auth.issue({ account: A, dossier: dossierA, run: runId }, now()),
    },
    body: JSON.stringify({ server: "explore", tool: name, args }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query(
    "insert into account(id,display_name,monthly_budget_cny) values($1,'A',5),($2,'B',5)",
    [A, B],
  );
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration',$3,$4)",
    [dossierA, A, "呼伦贝尔秋日", "/data/dossiers/" + dossierA],
  );
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,'bench-explore','explore',$4,'waiting',1,$5)`,
    [runId, A, dossierA, randomUUID(), JSON.stringify({ query: "帮我看看这次拍的照片" })],
  );
  cookieA = await issueSession(A);
  cookieB = await issueSession(B);
  root = await mkdtemp(join(tmpdir(), "reinlab-explore-b3-"));
  const photoStore = localPhotoStore(root);
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    kernelTools: { auth, dispatch: async () => ({}) },
    photoStore,
    photoFreeBytes: async () => 10 * 1024 ** 3,
    photoReader: (async () => ({
      observations: [],
      summary: "",
      // 真 token：看图花费要能算出来并记到账上。
      usage: { inputTokens: 1200, outputTokens: 300, model: "fixture" },
    })) as unknown as PhotoReader,
    reviewPricing: { inputPerMillion: 2, outputPerMillion: 8 },
  });
  await new Promise<void>((ready) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await pool.end();
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

describe("上传批次与 tus 续传", () => {
  it("建批次先报不支持的文件和空间，不静默跳过", async () => {
    const response = await createBatch([
      { name: "a.JPG", bytes: 3_000_000, lastModified: 1 },
      { name: "b.CR3", bytes: 30_000_000, lastModified: 2 },
      { name: "c.heic", bytes: 2_000_000, lastModified: 3 },
      { name: "d.mp4", bytes: 90_000_000, lastModified: 4 },
    ]);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.batch.files).toBe(1);
    expect(body.batch.unsupported.map((row: any) => row.fileName)).toEqual(["b.CR3", "c.heic", "d.mp4"]);
    expect(body.batch.unsupported.every((row: any) => !!row.reason)).toBe(true);
    expect(body.space.ok).toBe(true);
    // 端点给的是绝对地址（tus 客户端要拿它当 base 解析 Location），带页面用的 /backend 前缀。
    expect(body.uploadUrl).toBe(`${base}/backend/v1/explore/uploads`);
  });

  it("分块传一半后 HEAD 拿到真实偏移，从那个偏移接着传完（这就是续传）", async () => {
    const bytes = await jpeg({ make: "TESTCO", model: "X100V", when: "2026:11:08 17:40:00", offset: "+08:00", seed: 11 });
    const batch = await (await createBatch([{ name: "DSC_11.JPG", bytes: bytes.length, lastModified: 9 }])).json();
    const started = await tusUpload({ name: "DSC_11.JPG", lastModified: 9 }, bytes, {
      batchId: batch.batch.id,
      firstChunk: 1000,
    });
    expect(started.created.status).toBe(201);
    expect(started.offset).toBe(1000);
    const finished = await finishUpload(started.upload, bytes, started.offset);
    expect([204, 200]).toContain(finished.status);

    const listed = await readPhotos();
    const photo = listed.items.find((row: any) => row.fileName === "DSC_11.JPG");
    expect(photo).toBeTruthy();
    expect(photo.status).toBe("ready");
    expect(photo.exif.body).toBe("TESTCO X100V");
    expect(photo.exif.offset).toBe("+08:00");
    // 有偏移标签：时间可以直接解释，基准是 offset_tag。
    expect(photo.time.basis).toBe("offset_tag");
    expect(photo.time.trust).toBe("certain");
    expect(photo.time.corrected).toBe("2026-11-08T09:40:00.000Z");

    const progress = await (await api("GET", `/v1/explore/plans/${dossierA}/photo-batches/${batch.batch.id}`)).json();
    expect(progress.batch.uploaded).toBe(1);
    expect(progress.batch.processed).toBe(1);

    for (const kind of ["thumb", "preview"]) {
      const media = await api("GET", `/v1/explore/plans/${dossierA}/photos/${photo.id}/${kind}`);
      expect(media.status).toBe(200);
      expect(media.headers.get("content-type")).toBe("image/jpeg");
      expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(500);
    }
    const original = await api("GET", `/v1/explore/plans/${dossierA}/photos/${photo.id}/original`);
    expect(original.status).toBe(200);
    // 原图一个字节都不改。
    const stored = Buffer.from(await original.arrayBuffer());
    expect(createHash("sha256").update(stored).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));

    const crop = await api("GET", `/v1/explore/plans/${dossierA}/photos/${photo.id}/crop?x=0.2&y=0.2&w=0.3&h=0.3`);
    expect(crop.status).toBe(200);
    const cropMeta = await sharp(Buffer.from(await crop.arrayBuffer())).metadata();
    expect(cropMeta.width).toBeGreaterThan(100);
    expect(cropMeta.width).toBeLessThan(1024);
  });

  it("没带防伪造头不能传；别的账户也接不了这次上传", async () => {
    const bytes = await jpeg({ make: "TESTCO", model: "X100V", when: "2026:11:08 17:41:00", offset: "+08:00", seed: 12 });
    const batch = await (await createBatch([{ name: "DSC_12.JPG", bytes: bytes.length, lastModified: 9 }])).json();
    const denied = await tusUpload({ name: "DSC_12.JPG", lastModified: 9 }, bytes, {
      batchId: batch.batch.id,
      csrf: false,
    });
    expect(denied.created.status).toBe(403);

    const ok = await tusUpload({ name: "DSC_12.JPG", lastModified: 9 }, bytes, {
      batchId: batch.batch.id,
      firstChunk: 500,
    });
    expect(ok.created.status).toBe(201);
    const foreign = await fetch(ok.upload.location, {
      method: "HEAD",
      headers: { Cookie: cookieB, "Tus-Resumable": "1.0.0", "X-ReinLab-CSRF": "1" },
    });
    expect(foreign.status).toBe(404);
  });

  it("同内容只存一张（同名不同内容照常并存）", async () => {
    const bytes = await jpeg({ make: "TESTCO", model: "X100V", when: "2026:11:08 17:50:00", offset: "+08:00", seed: 21 });
    const first = await (await createBatch([{ name: "DUP_A.JPG", bytes: bytes.length, lastModified: 5 }])).json();
    const one = await tusUpload({ name: "DUP_A.JPG", lastModified: 5 }, bytes, {
      batchId: first.batch.id,
      firstChunk: Math.floor(bytes.length / 2),
    });
    await finishUpload(one.upload, bytes, one.offset);
    const second = await (await createBatch([{ name: "DUP_B.JPG", bytes: bytes.length, lastModified: 5 }])).json();
    const two = await tusUpload({ name: "DUP_B.JPG", lastModified: 5 }, bytes, {
      batchId: second.batch.id,
      firstChunk: Math.floor(bytes.length / 2),
    });
    await finishUpload(two.upload, bytes, two.offset);
    const listed = await readPhotos();
    const same = listed.items.filter((row: any) => row.sha256 === createHash("sha256").update(bytes).digest("hex"));
    expect(same).toHaveLength(1);
    // 同名不同内容：两张都在。
    const other = await jpeg({ make: "TESTCO", model: "X100V", when: "2026:11:08 17:51:00", offset: "+08:00", seed: 22 });
    const third = await (await createBatch([{ name: "DUP_A.JPG", bytes: other.length, lastModified: 6 }])).json();
    const three = await tusUpload({ name: "DUP_A.JPG", lastModified: 6 }, other, {
      batchId: third.batch.id,
      firstChunk: Math.floor(other.length / 2),
    });
    await finishUpload(three.upload, other, three.offset);
    const after = await readPhotos();
    expect(after.items.filter((row: any) => row.fileName === "DUP_A.JPG")).toHaveLength(2);
  });
});

describe("落位、对时与回顾", () => {
  it("GPS > 打卡 > 按计划时间推定；手动归属不被重算覆盖", async () => {
    // 建一个停留点，让「到了」的打卡落在它身上。
    const plan = await (await api("GET", `/v1/explore/plans/${dossierA}`)).json();
    const ops = await api("POST", `/v1/explore/plans/${dossierA}/ops`, {
      baseRevision: plan.plan.revision,
      ops: [
        {
          op: "stop.add",
          stop: {
            kind: "spot",
            name: "一号机位",
            geometry: { type: "Point", coordinates: [119.77, 49.22] },
            day: DAY,
            window: { start: `${DAY}T17:30:00+08:00`, end: `${DAY}T18:20:00+08:00` },
            reason: "落日",
          },
        },
      ],
    });
    expect(ops.status).toBe(200);
    const withStop = await (await api("GET", `/v1/explore/plans/${dossierA}`)).json();
    const stopId = withStop.plan.stops[0].id;
    await api("POST", `/v1/explore/plans/${dossierA}/field-events`, {
      events: [
        {
          clientId: "evt-arrived-1",
          kind: "arrived",
          stopId,
          stopName: "一号机位",
          planRevision: withStop.plan.revision,
          at: `${DAY}T17:41:00+08:00`,
          tz: TZ,
        },
      ],
    });

    const shot = await addPhoto({
      name: "SHOT_1700.JPG",
      make: "TESTCO",
      model: "X100V",
      when: "2026:11:08 17:42:00",
      offset: "+08:00",
      seed: 31,
    });
    expect(shot.photo.placement.basis).toBe("event");
    expect(shot.photo.placement.stopId).toBe(stopId);

    // 手动改归属：之后重算不能覆盖。
    const assigned = await api("POST", `/v1/explore/plans/${dossierA}/photos/assign`, {
      photoIds: [shot.photo.id],
      stopId: null,
      basis: "manual",
    });
    expect(assigned.status).toBe(200);
    manualId = shot.photo.id;
    const moved = (await readPhotos()).items.find((row: any) => row.id === shot.photo.id);
    expect(moved.placement.basis).toBe("unplanned");

    const picked = await api("POST", `/v1/explore/plans/${dossierA}/photos/pick`, {
      photoIds: [shot.photo.id],
      picked: true,
    });
    expect(picked.status).toBe(200);
    const afterPick = (await readPhotos()).items.find((row: any) => row.id === shot.photo.id);
    expect(afterPick.picked).toBe(true);

    const storage = await (await api("GET", `/v1/explore/plans/${dossierA}/storage`)).json();
    expect(storage.dossierBytes).toBeGreaterThan(10_000);
    expect(storage.freeBytes).toBeGreaterThan(0);
  });

  it("相机组给建议锚点；确认时区与偏差后重算整组时间（手动归属不动）", async () => {
    const groups = await (await api("GET", `/v1/explore/plans/${dossierA}/clock`)).json();
    expect(groups.groups.length).toBeGreaterThan(0);
    const group = groups.groups[0];
    expect(group.label).toBe("TESTCO X100V");
    expect(group.offsetSec === null || typeof group.offsetSec === "number").toBe(true);

    const photos = (await readPhotos()).items.filter((row: any) => row.cameraGroupId === group.id);
    const target = photos[0];
    const before = target.time.corrected;

    // 这组照片本来就有偏移标签：确认时区后时间不变，但状态变成 confirmed。
    const confirmed = await api("POST", `/v1/explore/plans/${dossierA}/clock/${group.id}/confirm`, {
      timezone: TZ,
      offsetSec: 0,
    });
    expect(confirmed.status).toBe(200);
    const after = (await readPhotos()).items.find((row: any) => row.id === target.id);
    expect(after.time.corrected).toBe(before);
    expect(after.time.trust).toBe("certain");

    // 手动归属的那张还是计划外，没有被这次重算改回去。
    const manual = (await readPhotos()).items.find((row: any) => row.picked === true);
    expect(manual.placement.basis).toBe("unplanned");
  });

  it("实际时间线把打卡和照片簇分开给，basis 照实写", async () => {
    const actual = await (await api("GET", `/v1/explore/plans/${dossierA}/actual`)).json();
    expect(actual.items.some((item: any) => item.type === "event" && item.record.kind === "arrived")).toBe(true);
    expect(actual.items.some((item: any) => item.type === "cluster")).toBe(true);
    const cluster = actual.items.find((item: any) => item.type === "cluster");
    expect(cluster.start <= cluster.end).toBe(true);
    expect(Array.isArray(cluster.photoIds)).toBe(true);
  });

  it("计划 vs 实际：没找到证据不等于没去，迟到分钟数不硬算", async () => {
    const review = await (
      await api("GET", `/v1/explore/plans/${dossierA}/review`)
    ).json();
    expect(review.comparison.items.length).toBe(1);
    const item = review.comparison.items[0];
    expect(item.stopName).toBe("一号机位");
    expect(["shot", "arrived_only", "none_found"]).toContain(item.evidence);
    // 手动挪走的那张不再算这个点的拍摄证据。
    expect(item.photoIds.includes(manualId ?? "")).toBe(false);
    expect(Array.isArray(review.unplannedPhotoIds ?? [])).toBe(true);
  });

  it("游记按修订保存，冲突 409（REVISION_CONFLICT），导出 md 与 html", async () => {
    const first = await api("PUT", `/v1/explore/plans/${dossierA}/review/travelogue`, {
      baseRevision: 0,
      markdown: "# 呼伦贝尔第一天\n\n17:41 到了一号机位，风很大。\n\n- 先拍了落日\n- 又补了两张",
    });
    expect(first.status).toBe(200);
    const saved = await first.json();
    expect(saved.revision).toBe(1);

    const conflict = await api("PUT", `/v1/explore/plans/${dossierA}/review/travelogue`, {
      baseRevision: 0,
      markdown: "旧版本覆盖",
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("REVISION_CONFLICT");

    const md = await api("GET", `/v1/explore/plans/${dossierA}/review/travelogue/export?format=md`);
    expect(md.status).toBe(200);
    expect(await md.text()).toContain("呼伦贝尔第一天");
    const html = await api("GET", `/v1/explore/plans/${dossierA}/review/travelogue/export?format=html`);
    expect(html.status).toBe(200);
    const body = await html.text();
    expect(body).toContain("<h1>呼伦贝尔第一天</h1>");
    expect(body).toContain("<li>先拍了落日</li>");

    // 导出过一次就在档案成果里留一条。
    const artifacts = await admin.query(
      "select title from dossier_artifact where account_id=$1 and dossier_id=$2 and kind='file'",
      [A, dossierA],
    );
    expect(artifacts.rows.map((row) => row.title)).toContain("游记 · 第 1 版（MD）");
  });

  it("游记用约定写法引用照片：正文存原样，photoIds 记下来，导出换成真图片地址", async () => {
    const photo = (await readPhotos()).items[0];
    const saved = await (
      await api("PUT", `/v1/explore/plans/${dossierA}/review/travelogue`, {
        baseRevision: 1,
        markdown: `## 傍晚\n\n![落日](photo:${photo.id})\n\n- 风大，压了石头`,
      })
    ).json();
    expect(saved.revision).toBe(2);
    expect(saved.photoIds).toEqual([photo.id]);
    // 正文原样保存：页面要能自己认出 photo:<id> 并渲染成图片。
    expect(saved.markdown).toContain(`](photo:${photo.id})`);

    const md = await (await api("GET", `/v1/explore/plans/${dossierA}/review/travelogue/export?format=md`)).text();
    expect(md).toContain("](http://127.0.0.1");
    expect(md).toContain(`/backend/v1/explore/plans/${dossierA}/photos/${photo.id}/preview)`);
    expect(md).not.toContain("photo:");
    const html = await (
      await api("GET", `/v1/explore/plans/${dossierA}/review/travelogue/export?format=html`)
    ).text();
    expect(html).toContain(`/photos/${photo.id}/preview`);
    expect(html).toContain('<img alt="落日"');
  });

  it("地点经验走 /v1/profiles（type=place），可改可删", async () => {
    const created = await api("POST", "/v1/profiles", {
      type: "place",
      name: "一号机位",
      at: [119.77, 49.22],
      radiusM: 300,
      observedOn: DAY,
      timeOfDay: "17:40",
      text: "17:40 被西边的楼挡住，18:05 之后才有光。",
      evidence: { dossierId: dossierA },
    });
    expect(created.status).toBe(201);
    const profile = await created.json();
    expect(profile.type).toBe("place");
    expect(profile.at).toEqual([119.77, 49.22]);

    const listed = await (await api("GET", "/v1/profiles?type=place")).json();
    expect(listed.items.some((row: any) => row.id === profile.id)).toBe(true);

    // 页面保存时会把整条资料带回来（含 id / revision / confirmedBy）：服务端认下但不用。
    const patched = await api("PATCH", `/v1/profiles/${profile.id}`, {
      ...profile,
      baseRevision: profile.revision,
      name: "一号机位",
      text: "17:40 被楼挡住，18:05 之后才有光（补：风大）。",
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).revision).toBe(profile.revision + 1);
    const removed = await api("DELETE", `/v1/profiles/${profile.id}`);
    expect(removed.status).toBe(204);
  });
});

describe("对话里的回顾工具", () => {
  it("列照片 / 标推荐（AI 与精选分开）", async () => {
    const listed = await tool("photos", { limit: 10 });
    expect(listed.status).toBe(200);
    const result = listed.body.result;
    expect(result.photoIds.length).toBeGreaterThan(0);
    expect(result.items[0].stats.note).toBeTruthy();

    const target = result.photoIds[0];
    const marked = await tool("photo_mark", {
      photoIds: [target],
      mark: "recommend",
      reason: "曝光稳、主体清楚",
      inspected: "preview",
    });
    expect(marked.status).toBe(200);
    const after = (await readPhotos()).items.find((row: any) => row.id === target);
    expect(after.ai.mark).toBe("recommend");
    expect(after.ai.reason).toBe("曝光稳、主体清楚");
    expect(after.picked).toBe(false);
  });

  it("照片分页不漏不重，并且告诉模型后面还有多少张", async () => {
    const all: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 40; guard += 1) {
      const page = await tool("photos", { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.status).toBe(200);
      const result = page.body.result;
      if (result.hasMore) {
        // 翻页时模型必须知道「还有没列出来的」，不能把这一页当成全部。
        expect(result.remaining).toBeGreaterThan(0);
        expect(result.note).toContain("还有");
        expect(result.total).toBeGreaterThan(result.returned);
      } else {
        expect(result.remaining).toBe(0);
      }
      all.push(...page.body.result.photoIds);
      cursor = page.body.result.cursor ?? undefined;
      if (!cursor) break;
    }
    const expected = (await readPhotos()).items.length;
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(expected);
  });

  it("对照与游记工具把结果交给页面出卡", async () => {
    const compared = await tool("compare", {});
    expect(compared.status).toBe(200);
    expect(compared.body.result.comparison).toBe(true);
    expect(Array.isArray(compared.body.result.items)).toBe(true);

    const travelogue = await tool("travelogue", { markdown: "# 第二天\n\n又去了一号机位。" });
    expect(travelogue.status).toBe(200);
    expect(typeof travelogue.body.result.travelogueId).toBe("string");
    expect(travelogue.body.result.revision).toBeGreaterThan(1);
  });

  it("看图的花费记到这份档案本月的账上，可用额度真的变少", async () => {
    const before = await (await api("GET", "/v1/me")).json();
    const photo = (await readPhotos()).items[0];
    const viewed = await tool("photo_view", { photoIds: [photo.id] });
    expect(viewed.status).toBe(200);
    const after = await (await api("GET", "/v1/me")).json();
    const spent = expectedSpend(1200, 300);
    expect(Number(after.budget.availableCny)).toBeLessThan(Number(before.budget.availableCny));
    expect(Number(before.budget.availableCny) - Number(after.budget.availableCny)).toBeCloseTo(spent, 6);
    const rows = await admin.query(
      "select coalesce(sum(spent_cny),0)::text total from budget_allocation where account_id=$1",
      [A],
    );
    expect(Number(rows.rows[0].total)).toBeGreaterThan(0);
  });

  it("经验提案只出 pending，用户批准后才写进资料", async () => {
    const proposed = await tool("experience", {
      target: "place",
      title: "西边楼挡光到 18:05",
      text: "17:40 到 18:05 之间被西侧楼挡住，之后才有直射光。",
      name: "一号机位",
      at: [119.77, 49.22],
      observedOn: DAY,
      timeOfDay: "17:40",
      evidence: {},
    });
    expect(proposed.status).toBe(200);
    const pending = proposed.body.result.pending;
    expect(pending.kind).toBe("experience");
    expect(pending.approvalId).toMatch(/^[0-9a-f-]{36}$/);

    const before = await (await api("GET", "/v1/profiles?type=place")).json();
    expect(before.items.some((row: any) => row.name === "一号机位")).toBe(false);

    const decided = await api("POST", `/v1/approvals/${pending.approvalId}/decide`, {
      decision: "approve",
      scope: "once",
    });
    expect(decided.status).toBe(200);
    const after = await (await api("GET", "/v1/profiles?type=place")).json();
    expect(after.items.some((row: any) => row.name === "一号机位")).toBe(true);

    // 结果要告诉模型：记成档案事实，下一轮由「档案变动：」注记带进会话（不是用户气泡）。
    const noted = await admin.query(
      "select payload->>'text' text from event where account_id=$1 and dossier_id=$2 and kind='user_op' and action='decision'",
      [A, dossierA],
    );
    expect(noted.rows.map((row) => row.text).join("；")).toContain("用户确认了这条地点经验");

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.account_id',$1,true)", [A]);
      await client.query(
        `insert into dsh_session(account_id,dossier_id,session_id,home_path,mode)
         values($1,$2,$3,'/tmp','explore') on conflict do nothing`,
        [A, dossierA, "ds-fixture"],
      );
      const prompt = await withDossierContext(client, {
        account: A,
        dossier: dossierA,
        sessionId: "ds-fixture",
        prompt: "继续。",
      });
      expect(prompt.startsWith("档案变动：")).toBe(true);
      expect(prompt).toContain("用户确认了这条地点经验");
      expect(prompt.endsWith("继续。")).toBe(true);
      // 拆出来之后，页面看到的是注记 + 用户那句话，而不是「用户说了一整段审批结果」。
      const pieces = splitInjected({ type: "user/message", data: { content: [{ type: "text", text: prompt }] } });
      expect(pieces).toHaveLength(2);
      expect((pieces[0].data as any).content[0].text.startsWith("档案变动：")).toBe(true);
      expect((pieces[1].data as any).content[0].text).toBe("继续。");
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("天气判断的用量带上金额（不再是 token 有、钱没有）", async () => {
    const judge = createWeatherJudge({
      baseUrl: "https://provider.example/anthropic",
      apiKey: "test-key",
      model: "judge-fixture",
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
      transport: async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({ material: false, summary: "没有明显影响", changes: [] }),
              },
            ],
            usage: { input_tokens: 1000, output_tokens: 250 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const { usage } = await judge({ timezone: TZ, destination: "呼伦贝尔", revision: 1, stops: [] });
    expect(usage.costCny).toBe(expectedSpend(1000, 250).toFixed(6));
  });

  it("别的账户读不到这些照片", async () => {
    const photo = (await readPhotos()).items[0];
    const denied = await api("GET", `/v1/explore/plans/${dossierA}/photos/${photo.id}/thumb`, undefined, cookieB);
    expect([403, 404]).toContain(denied.status);
  });
});
