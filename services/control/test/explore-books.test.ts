import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/api/app";
import { generateBook } from "../src/explore/book-job";
import { KernelAuth } from "../src/kernel/auth";
import { generateKeyPairSync } from "node:crypto";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { localExploreStorage } from "../src/explore/storage";
import { defaultFontFile } from "../src/explore/book-job";
import { pdfPages } from "../src/mcp/papers";
import { publishAccountEvent, subscribe } from "../src/dossier/service";

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
let storageRoot = "";
let kernelAuth: KernelAuth;
const runId = randomUUID();
let storage: ReturnType<typeof localExploreStorage>;

/** 1×1 PNG：真 PNG 头，够验证「只收 PNG」和图文排版。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

const planOf = async () =>
  (await app.request(`/v1/explore/plans/${dossier}`, { headers: headers() })).json();

const ops = async (body: unknown) =>
  app.request(`/v1/explore/plans/${dossier}/ops`, {
    method: "POST",
    headers: headers(randomUUID()),
    body: JSON.stringify(body),
  });

const uploadSnapshot = async (key: string, revision: number, bytes = PNG, basemap = "vector") => {
  const form = new FormData();
  form.append("file", new File([bytes], `${key}.png`, { type: "image/png" }));
  form.append("key", key);
  form.append("revision", String(revision));
  form.append("basemap", basemap);
  form.append("attribution", "© OpenStreetMap contributors · OpenFreeMap");
  return app.request(`/v1/explore/plans/${dossier}/snapshots`, {
    method: "POST",
    headers: { Cookie: cookieA, Origin: "http://localhost", "X-ReinLab-CSRF": "1" },
    body: form,
  });
};

/** 等 explore.book 的结果事件（生成是 202 之后异步做的）。 */
function waitForBook(timeoutMs = 8000) {
  return new Promise<any>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("等计划书事件超时"));
    }, timeoutMs);
    const stop = subscribe(A, "exploration", (event: any) => {
      if (event?.type !== "explore.book") return;
      clearTimeout(timer);
      stop();
      resolvePromise(event);
    });
  });
}

const requestBook = async (variant: "brief" | "full", revision: number) =>
  app.request(`/v1/explore/plans/${dossier}/books`, {
    method: "POST",
    headers: headers(randomUUID()),
    body: JSON.stringify({ variant, revision }),
  });

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name) values($1,'A')", [A]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','京都秋日旅拍',$3)",
    [dossier, A, "/data/dossiers/" + dossier],
  );
  cookieA = await issueSession(A);
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,'bench-explore','explore',$4,'waiting',1,'{}')`,
    [runId, A, dossier, randomUUID()],
  );
  storageRoot = await mkdtemp(join(tmpdir(), "reinlab-books-"));
  storage = localExploreStorage(storageRoot);
  kernelAuth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
  const database = new Database(pool);
  const bookEngine = (account: string, target: string, plan: any) => {
    void generateBook(
      {
        db: database,
        storage,
        fontFile: defaultFontFile(),
        // 和 main.ts 一样：生成完推 explore.book。
        publish: (target: string, event: Record<string, unknown>) =>
          publishAccountEvent(target, "exploration", event),
      },
      { account, dossier: target, plan },
    );
  };
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    kernelTools: { auth: kernelAuth, dispatch: async () => ({}), bookEngine },
    exploreStorage: storage,
    pdfFontFile: defaultFontFile(),
  });

  // 确认整份计划要先有账户时区（天气检查用它）。
  const settings = await app.request("/v1/account/settings", {
    method: "PUT",
    headers: headers(randomUUID()),
    body: JSON.stringify({ timezone: "Asia/Tokyo" }),
  });
  expect(settings.status).toBe(200);

  // 一份可出计划书的计划：地点 + 两个已确认停留点。
  const plan = await planOf();
  const built = await ops({
    baseRevision: plan.plan.revision,
    ops: [
      {
        op: "plan.set",
        patch: {
          destination: { name: "京都 · 东山", center: [135.7681, 35.0116], timezone: "Asia/Tokyo" },
          days: ["2026-11-15"],
          kinds: ["portrait"],
        },
      },
      {
        op: "stop.add",
        stop: {
          kind: "spot",
          name: "白川旁的石桥",
          geometry: { type: "Point", coordinates: [135.78, 35.01] },
          day: "2026-11-15",
          window: { start: "2026-11-15T07:10:00+09:00", end: "2026-11-15T07:50:00+09:00" },
          state: "confirmed",
          detail: { composition: "人放左三分线，右边留出逆光的枫树" },
        },
      },
      {
        op: "stop.add",
        stop: {
          kind: "spot",
          name: "哲学之道",
          geometry: { type: "Point", coordinates: [135.79, 35.02] },
          day: "2026-11-15",
          window: { start: "2026-11-15T08:10:00+09:00", end: "2026-11-15T08:50:00+09:00" },
          state: "confirmed",
        },
      },
    ],
  });
  expect(built.status).toBe(200);
  const created = await planOf();
  const confirmed = await ops({ baseRevision: created.plan.revision, ops: [{ op: "plan.confirm" }] });
  expect(confirmed.status).toBe(200);
}, 40_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

describe("地图快照与两版计划书", () => {
  it("快照只收本修订的 PNG；卫星底图不收", async () => {
    const plan = await planOf();
    const revision = plan.plan.revision;
    const ok = await uploadSnapshot("overview", revision);
    expect(ok.status).toBe(201);
    const stale = await uploadSnapshot("overview", revision - 1);
    expect(stale.status).toBe(409);
    const satellite = await uploadSnapshot("overview", revision, PNG, "satellite");
    expect(satellite.status).toBe(400);
    const notPng = await uploadSnapshot("overview", revision, Buffer.from("not a png"));
    expect(notPng.status).toBe(400);
    expect((await notPng.json()).code).toBe("SNAPSHOT_NOT_PNG");
    // 未确认的停留点不给局部图
    const unknownKey = await uploadSnapshot(randomUUID(), revision);
    expect(unknownKey.status).toBe(400);
  });

  it("缺图就说缺哪几张，不生成空白成果", async () => {
    const plan = await planOf();
    const pending = await requestBook("full", plan.plan.revision);
    expect(pending.status).toBe(409);
    const body = await pending.json();
    expect(body.code).toBe("NEEDS_MAP_SNAPSHOTS");
    // 上一条已经导过全程图：这里缺的是每个已确认停留点的局部图。
    expect(body.keys).not.toContain("overview");
    const confirmedIds = (await planOf()).plan.stops
      .filter((stop: any) => stop.state === "confirmed")
      .map((stop: any) => stop.id);
    expect([...body.keys].sort()).toEqual([...confirmedIds].sort());
  });

  it("精简版：一页 A4，202 之后作为档案成果出现，能打开下载", async () => {
    const plan = await planOf();
    const revision = plan.plan.revision;
    const waiting = waitForBook();
    const response = await requestBook("brief", revision);
    expect(response.status).toBe(202);
    const created = await response.json();
    expect(created.version).toBe(1);
    const event = await waiting;
    expect(event.state).toBe("done");
    expect(event.artifactId).toBe(created.jobId);

    const artifacts = (
      await app.request(`/v1/dossiers/${dossier}/artifacts?kind=file`, { headers: headers() })
    ).json();
    const items = (await artifacts).items;
    expect(items.map((item: any) => item.title)).toContain("精简 · 第 1 版");

    const file = await app.request(`/v1/explore/plans/${dossier}/books/${created.jobId}/file`, {
      headers: headers(),
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await pdfPages(bytes)).length).toBe(1);
  });

  it("详细版：总览 + 每个已确认停留点一页 + 末页", async () => {
    const plan = await planOf();
    const revision = plan.plan.revision;
    const stops = plan.plan.stops.filter((stop: any) => stop.state === "confirmed");
    for (const stop of stops) {
      const uploaded = await uploadSnapshot(stop.id, revision);
      expect(uploaded.status).toBe(201);
    }
    const waiting = waitForBook();
    const response = await requestBook("full", revision);
    expect(response.status).toBe(202);
    const created = await response.json();
    expect(created.version).toBe(2);
    expect((await waiting).state).toBe("done");
    const file = await app.request(`/v1/explore/plans/${dossier}/books/${created.jobId}/file`, {
      headers: headers(),
    });
    const bytes = Buffer.from(await file.arrayBuffer());
    const pages = await pdfPages(bytes);
    // 总览 1 + 停留点 2 + 末页 1
    expect(pages.length).toBe(4);
    expect(pages[0]).toContain("想要的感觉");
    expect(pages[1]).toContain("白川旁的石桥");
    expect(pages[3]).toContain("天气预案");
  });

  it("修订变了就拒绝，并按新修订重新导出", async () => {
    const plan = await planOf();
    const old = await requestBook("brief", plan.plan.revision - 1);
    expect(old.status).toBe(409);
    expect((await old.json()).code).toBe("REVISION_CONFLICT");
  });

  it("旧计划书不随计划改动变化，新生成的是下一版", async () => {
    const plan = await planOf();
    // 改一下计划：修订 +1。
    const edited = await ops({
      baseRevision: plan.plan.revision,
      ops: [{ op: "plan.set", patch: { kinds: ["portrait", "landscape"] } }],
    });
    expect(edited.status).toBe(200);
    const after = await planOf();
    const oldBooks = (
      await (await app.request(`/v1/dossiers/${dossier}/artifacts?kind=file`, { headers: headers() })).json()
    ).items;
    expect(oldBooks).toHaveLength(2);
    // 新修订还得重新导快照。
    const missing = await requestBook("brief", after.plan.revision);
    expect(missing.status).toBe(409);
    expect((await missing.json()).code).toBe("NEEDS_MAP_SNAPSHOTS");
    await uploadSnapshot("overview", after.plan.revision);
    const waiting = waitForBook();
    const response = await requestBook("brief", after.plan.revision);
    expect(response.status).toBe(202);
    const created = await response.json();
    expect(created.version).toBe(3);
    expect((await waiting).state).toBe("done");
    const books = (
      await (await app.request(`/v1/dossiers/${dossier}/artifacts?kind=file`, { headers: headers() })).json()
    ).items;
    expect(books.map((item: any) => item.title).sort()).toEqual(["精简 · 第 1 版", "精简 · 第 3 版", "详细 · 第 2 版"]);
  });
});

describe("助手发起生成计划书", () => {
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await app.request("/kernel/tool", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": kernelAuth.issue(
          { account: A, dossier, run: runId },
          Math.floor(Date.now() / 1000),
        ),
      },
      body: JSON.stringify({ server: "explore", tool: name, args }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  it("素材不齐：如实说缺图并让页面补，不假称已生成", async () => {
    const seen: any[] = [];
    const stop = subscribe(A, "exploration", (event) => seen.push(event));
    try {
      const { status, body } = await tool("book", { variant: "full" });
      expect(status).toBe(200);
      expect(body.result.state).toBe("needs_map_snapshot");
      expect(body.result.missing.length).toBeGreaterThan(0);
      const needed = seen.find((event) => event.type === "explore.snapshots_needed");
      expect(needed?.keys.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  it("素材齐了：开始生成，完成后作为档案成果出现", async () => {
    const plan = await planOf();
    for (const stop of plan.plan.stops.filter((row: any) => row.state === "confirmed"))
      await uploadSnapshot(stop.id, plan.plan.revision);
    const waiting = waitForBook();
    const { body } = await tool("book", { variant: "full" });
    expect(body.result.state).toBe("generating");
    const event = await waiting;
    expect(event.state).toBe("done");
    const file = await app.request(`/v1/explore/plans/${dossier}/books/${body.result.jobId}/file`, {
      headers: headers(),
    });
    expect(file.status).toBe(200);
  });
});
