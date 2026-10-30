import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/api/app";
import { applyMigrations } from "../src/db/migrate";
import { KernelAuth } from "../src/kernel/auth";
import { localExploreStorage } from "../src/explore/storage";
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
const now = () => Math.floor(Date.now() / 1000);
const A = randomUUID();
const B = randomUUID();
const dossier = randomUUID();
const runId = randomUUID();
let app: Awaited<ReturnType<typeof createApp>>;
let cookieA = "";
let cookieB = "";
let storageRoot = "";

/** 1×1 PNG：真图片文件，用来验证上传→读取→删除这条路径。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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

const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await app.request("/kernel/tool", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": auth.issue({ account: A, dossier, run: runId }, now()),
    },
    body: JSON.stringify({ server: "explore", tool: name, args }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const planOf = async () =>
  (await app.request(`/v1/explore/plans/${dossier}`, { headers: headers() })).json();

beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name) values($1,'A'),($2,'B')", [A, B]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','京都秋日旅拍',$3)",
    [dossier, A, "/data/dossiers/" + dossier],
  );
  await admin.query(
    `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
     values($1,$2,$3,'bench-explore','explore',$4,'waiting',1,$5)`,
    [runId, A, dossier, randomUUID(), JSON.stringify({ query: "帮我排一下京都秋天的旅拍" })],
  );
  cookieA = await issueSession(A);
  cookieB = await issueSession(B);
  storageRoot = await mkdtemp(join(tmpdir(), "reinlab-explore-"));
  app = await createApp({
    pool,
    auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
    kernelTools: { auth, dispatch: async () => ({}) },
    exploreStorage: localExploreStorage(storageRoot),
  });
}, 40_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

const createProfile = async (body: Record<string, unknown>, cookie = cookieA) => {
  const response = await app.request("/v1/profiles", {
    method: "POST",
    headers: headers(cookie, randomUUID()),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

describe("账户资料（模特与器材）", () => {
  it("新建模特与器材，列表按类型给", async () => {
    const model = await createProfile({ type: "model", name: "林屿", height: 168, style: "素人气质" });
    expect(model.status).toBe(201);
    expect(model.body).toMatchObject({ type: "model", name: "林屿", revision: 1 });
    const gear = await createProfile({
      type: "gear",
      name: "85mm F1.8",
      kind: "lens",
      focal: [85, 85],
      aperture: 1.8,
    });
    expect(gear.status).toBe(201);
    const list = await (await app.request("/v1/profiles?type=gear", { headers: headers() })).json();
    expect(list.items.map((item: any) => item.name)).toContain("85mm F1.8");
    expect(list.items.every((item: any) => item.type === "gear")).toBe(true);
    // 客户端塞服务端字段直接拒（和档案接口一致的严格入参）。
    const injected = await createProfile({ type: "model", name: "小满", id: randomUUID(), revision: 99, accountId: B });
    expect(injected.status).toBe(400);
  });

  it("改资料要带最新版本，改完修订加一", async () => {
    const list = await (await app.request("/v1/profiles?type=model", { headers: headers() })).json();
    const target = list.items[0];
    const stale = await app.request(`/v1/profiles/${target.id}`, {
      method: "PATCH",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ baseRevision: 99, style: "改一下" }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("VERSION_CONFLICT");
    const ok = await app.request(`/v1/profiles/${target.id}`, {
      method: "PATCH",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ baseRevision: target.revision, style: "沉稳一点" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).revision).toBe(target.revision + 1);
  });

  it("计划选资料存快照；资料后来改了，旧计划仍是当时那一版", async () => {
    const gearList = await (await app.request("/v1/profiles?type=gear", { headers: headers() })).json();
    const gear = gearList.items[0];
    const plan = await planOf();
    const selected = await app.request(`/v1/explore/plans/${dossier}/ops`, {
      method: "POST",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({
        baseRevision: plan.plan.revision,
        ops: [{ op: "plan.select", gear: [gear.id] }],
      }),
    });
    expect(selected.status).toBe(200);
    const body = await selected.json();
    const applied = body.applied as AppliedOp[];
    expect(applied[0].summary).toContain("85mm F1.8");
    const snap = (await planOf()).plan.gear[0];
    expect(snap).toMatchObject({ profileId: gear.id, revision: gear.revision });

    // 资料改了：计划里的快照不动，refresh 才采用最新修订。
    await app.request(`/v1/profiles/${gear.id}`, {
      method: "PATCH",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({ baseRevision: gear.revision, notes: "常用人像头" }),
    });
    const after = await planOf();
    expect(after.plan.gear[0].revision).toBe(gear.revision);
    const current = await planOf();
    await app.request(`/v1/explore/plans/${dossier}/ops`, {
      method: "POST",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({
        baseRevision: current.plan.revision,
        ops: [{ op: "plan.select", gear: [gear.id], refresh: true }],
      }),
    });
    expect((await planOf()).plan.gear[0].revision).toBe(gear.revision + 1);
  });

  it("资料删掉后旧计划快照还在，但不能再选它", async () => {
    const list = await (await app.request("/v1/profiles?type=gear", { headers: headers() })).json();
    const gear = list.items[0];
    const removed = await app.request(`/v1/profiles/${gear.id}`, {
      method: "DELETE",
      headers: headers(cookieA),
    });
    expect(removed.status).toBe(204);
    const after = await (await app.request("/v1/profiles?type=gear", { headers: headers() })).json();
    expect(after.items.map((item: any) => item.id)).not.toContain(gear.id);
    // 旧计划里的快照仍在（用户已确认该范围）。
    expect((await planOf()).plan.gear[0].profileId).toBe(gear.id);
    // 重新选它就选不上。
    const current = await planOf();
    const retry = await app.request(`/v1/explore/plans/${dossier}/ops`, {
      method: "POST",
      headers: headers(cookieA, randomUUID()),
      body: JSON.stringify({
        baseRevision: current.plan.revision,
        ops: [{ op: "plan.select", gear: [gear.id] }],
      }),
    });
    expect(retry.status).toBe(404);
    expect((await retry.json()).code).toBe("PROFILE_NOT_FOUND");
  });

  it("别的账户看不到、也改不了", async () => {
    const list = await (await app.request("/v1/profiles", { headers: headers(cookieB) })).json();
    expect(list.items).toEqual([]);
    const mine = await (await app.request("/v1/profiles?type=model", { headers: headers() })).json();
    const denied = await app.request(`/v1/profiles/${mine.items[0].id}`, {
      method: "PATCH",
      headers: headers(cookieB, randomUUID()),
      body: JSON.stringify({ baseRevision: mine.items[0].revision, style: "偷改" }),
    });
    expect(denied.status).toBe(404);
  });

  it("助手能读资料，但写资料要用户自己的话", async () => {
    const read = await tool("profiles");
    expect(read.status).toBe(200);
    expect(read.body.result.items.length).toBeGreaterThan(0);

    const cold = await tool("profile_write", {
      action: "add",
      type: "gear",
      name: "35mm F1.4",
      kind: "lens",
      focal: [35, 35],
      aperture: 1.4,
    });
    expect(cold.status).toBe(409);
    expect(cold.body.state).toBe("needs_user_confirmation");

    // 用户明说「记住我有 35mm F1.4」之后才写。
    await admin.query(
      `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
       values($1,$2,$3,'dsh','user/message',$4,$5)`,
      [
        A,
        dossier,
        runId,
        JSON.stringify({ id: "msg-gear", content: [{ type: "text", text: "记住我有 35mm F1.4 这支镜头" }] }),
        "test-msg-gear",
      ],
    );
    const warm = await tool("profile_write", {
      action: "add",
      type: "gear",
      name: "35mm F1.4",
      kind: "lens",
      focal: [35, 35],
      aperture: 1.4,
    });
    expect(warm.status).toBe(200);
    expect(warm.body.result.name).toBe("35mm F1.4");
  });
});

describe("档案参考图", () => {
  it("上传、在计划里看到、能打开、能移除", async () => {
    const form = new FormData();
    form.append("file", new File([PNG], "a.png", { type: "image/png" }));
    form.append("kind", "style");
    const uploaded = await app.request(`/v1/explore/plans/${dossier}/refs`, {
      method: "POST",
      headers: { Cookie: cookieA, Origin: "http://localhost", "X-ReinLab-CSRF": "1" },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const ref = await uploaded.json();
    expect(ref).toMatchObject({ origin: "upload", kind: "style" });
    expect(ref.image.src).toContain(`/refs/${ref.id}/image`);

    const plan = await planOf();
    expect(plan.refs.map((item: any) => item.id)).toContain(ref.id);

    const image = await app.request(ref.image.src, { headers: headers() });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);

    // 别的账户打不开。
    const denied = await app.request(ref.image.src, { headers: headers(cookieB) });
    expect([403, 404]).toContain(denied.status);

    const removed = await app.request(`/v1/explore/plans/${dossier}/refs/${ref.id}`, {
      method: "DELETE",
      headers: headers(cookieA),
    });
    expect(removed.status).toBe(204);
    expect((await planOf()).refs.map((item: any) => item.id)).not.toContain(ref.id);
    const gone = await app.request(ref.image.src, { headers: headers() });
    expect(gone.status).toBe(404);
  });

  it("不是图片就不收，且说明原因", async () => {
    const form = new FormData();
    form.append("file", new File([Buffer.from("not an image")], "a.txt", { type: "text/plain" }));
    form.append("kind", "style");
    const response = await app.request(`/v1/explore/plans/${dossier}/refs`, {
      method: "POST",
      headers: { Cookie: cookieA, Origin: "http://localhost", "X-ReinLab-CSRF": "1" },
      body: form,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("REF_TYPE_UNSUPPORTED");
  });
});

describe("每份计划的用量", () => {
  it("按用途、按模型、按次调用分开列，未知不记 0", async () => {
    const rows: [string, string, string | null, boolean, number | null, number | null, string | null][] = [
      ["planning", "deepseek-v4-flash", null, true, 900, 1800, null],
      ["weather_judge", "deepseek-v4-flash", null, true, 971, 774, null],
      ["weather_judge", "deepseek-v4-flash", null, false, null, null, null],
      ["deepseek", "tools-search", null, true, 0, 0, "0.005000"],
    ];
    for (const [provider, model, run, known, input, output, cost] of rows)
      await admin.query(
        `insert into usage_record(account_id,dossier_id,run_id,provider,model,known,input_tokens,output_tokens,cost_cny,purpose)
         values($1,$2,null,$3,$4,$5,$6,$7,$8,$9)`,
        [A, dossier, provider, model, known, input, output, cost, model.startsWith("tools-") ? null : provider],
      );
    const body = await (
      await app.request(`/v1/explore/plans/${dossier}/usage`, { headers: headers() })
    ).json();
    const planning = body.byPurpose.find((entry: any) => entry.purpose === "planning");
    expect(planning).toMatchObject({ calls: 1, input: 900, output: 1800 });
    const judge = body.byPurpose.find((entry: any) => entry.purpose === "weather_judge");
    expect(judge.calls).toBe(2);
    // 有一次没报用量：已知部分照实加，不记 0。
    expect(judge.input).toBe(971);
    expect(body.byModel[0]).toMatchObject({ model: "deepseek-v4-flash", input: 1871, output: 2574 });
    expect(body.tools[0]).toMatchObject({ name: "search", calls: 1, costCny: 0.005 });
    expect(body.unknownCalls).toBe(1);
  });

  it("别的地方查不到这份档案的用量", async () => {
    const denied = await app.request(`/v1/explore/plans/${dossier}/usage`, { headers: headers(cookieB) });
    expect([403, 404]).toContain(denied.status);
  });
});
