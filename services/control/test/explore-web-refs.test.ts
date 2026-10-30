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
import { fetchWebRef, type WeatherLikeTransport } from "../src/explore/refs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 按 URL 回不同内容的假传输层：测试不连外网。 */
function fakeTransport(routes: Record<string, { status?: number; type?: string; body: Buffer | string; length?: number }>): WeatherLikeTransport {
  return async (url) => {
    const route = routes[url];
    if (!route)
      return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? (route.type ?? "application/octet-stream")
            : name.toLowerCase() === "content-length"
              ? String(route.length ?? bytes.length)
              : null,
      },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  };
}

describe("网图入档：取图与出处", () => {
  it("直接是图片就存下来", async () => {
    const material = await fetchWebRef("https://img.example/a.png", {
      transport: fakeTransport({ "https://img.example/a.png": { type: "image/png", body: PNG } }),
    });
    expect(material.image?.mime).toBe("image/png");
    expect(material.image?.bytes.equals(PNG)).toBe(true);
    expect(material.warning).toBeUndefined();
  });

  it("给的是网页就读页面的分享图，并把原网页留下", async () => {
    const html = `<html><head><title>京都红叶机位</title>
      <meta property="og:image" content="https://cdn.example/cover.jpg"></head></html>`;
    const material = await fetchWebRef("https://blog.example/post/1", {
      transport: fakeTransport({
        "https://blog.example/post/1": { type: "text/html; charset=utf-8", body: html },
        "https://cdn.example/cover.jpg": { type: "image/jpeg", body: Buffer.from("jpegbytes") },
      }),
    });
    expect(material.image?.mime).toBe("image/jpeg");
    expect(material.page).toEqual({ url: "https://blog.example/post/1", title: "京都红叶机位" });
  });

  it("页面上没有图、拿不到、太大、不是图片：都只留来源并说明原因", async () => {
    const noImage = await fetchWebRef("https://blog.example/plain", {
      transport: fakeTransport({
        "https://blog.example/plain": { type: "text/html", body: "<html><title>无图</title></html>" },
      }),
    });
    expect(noImage.image).toBeNull();
    expect(noImage.page?.url).toBe("https://blog.example/plain");
    expect(noImage.warning).toContain("没找到");

    const broken = await fetchWebRef("https://img.example/gone.png", {
      transport: fakeTransport({ "https://img.example/gone.png": { status: 404, body: "" } }),
    });
    expect(broken.image).toBeNull();
    expect(broken.warning).toContain("404");

    const huge = await fetchWebRef("https://img.example/huge.png", {
      transport: fakeTransport({
        "https://img.example/huge.png": { type: "image/png", body: PNG, length: 9 * 1024 * 1024 },
      }),
    });
    expect(huge.image).toBeNull();
    expect(huge.warning).toContain("太大");

    const pdf = await fetchWebRef("https://files.example/x.pdf", {
      transport: fakeTransport({
        "https://files.example/x.pdf": { type: "application/pdf", body: "%PDF-1.7" },
      }),
    });
    expect(pdf.image).toBeNull();
    expect(pdf.warning).toBeTruthy();
  });

  it("本机和内网地址一律不去取", async () => {
    for (const url of [
      "http://127.0.0.1:3001/v1/me",
      "http://localhost/admin",
      "http://192.168.1.10/secret.png",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
      "ftp://example.com/a.png",
    ])
      await expect(fetchWebRef(url)).rejects.toThrowError(/不去取|http/);
  });
});

describe("助手把网图收进档案", () => {
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
  const B = randomUUID();
  const dossier = randomUUID();
  const runId = randomUUID();
  const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
  let app: Awaited<ReturnType<typeof createApp>>;
  let cookieA = "";
  let cookieB = "";
  let storageRoot = "";

  const refHeaders = (cookie = cookieA) => ({
    Cookie: cookie,
    Origin: "http://localhost",
    "X-ReinLab-CSRF": "1",
  });
  const tool = async (args: Record<string, unknown>) => {
    const response = await app.request("/kernel/tool", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.issue({ account: A, dossier, run: runId }, Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ server: "explore", tool: "ref_add", args }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  beforeAll(async () => {
    await applyMigrations(admin, resolve("infra/supabase/migrations"));
    await admin.query("insert into account(id,display_name) values($1,'A'),($2,'B')", [A, B]);
    await admin.query(
      "insert into dossier(id,account_id,bench,title,workspace_path) values($1::uuid,$2,'exploration','京都秋日旅拍',$3)",
      [dossier, A, "/data/dossiers/" + dossier],
    );
    await admin.query(
      `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
       values($1,$2,$3,'bench-explore','explore',$4,'waiting',1,'{}')`,
      [runId, A, dossier, randomUUID()],
    );
    const issue = async (account: string) => {
      const token = randomBytes(32).toString("base64url");
      await admin.query("select reinlab_session_open($1,$2)", [
        account,
        createHash("sha256").update(token).digest("hex"),
      ]);
      return "rl_session=" + token;
    };
    cookieA = await issue(A);
    cookieB = await issue(B);
    storageRoot = await mkdtemp(join(tmpdir(), "reinlab-webrefs-"));
    app = await createApp({
      pool,
      auth: { issuer: "http://127.0.0.1/reinlab/auth/v1", secret: randomBytes(48) },
      kernelTools: {
        auth,
        dispatch: async () => ({}),
        exploreStorage: localExploreStorage(storageRoot),
      },
      exploreStorage: localExploreStorage(storageRoot),
      // 注入假传输层：这条路径要验「存副本 + 出处」，不连外网。
      refTransport: fakeTransport({
        "https://blog.example/white-river": {
          type: "text/html; charset=utf-8",
          body: `<html><head><title>白川石桥实拍</title><meta property="og:image" content="https://cdn.example/white-river.jpg"></head></html>`,
        },
        "https://cdn.example/white-river.jpg": { type: "image/jpeg", body: Buffer.from("jpeg-bytes") },
      }),
    });
  }, 40_000);

  afterAll(async () => {
    await pool.end();
    await admin.end();
    await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("存下副本与出处，页面能打开这张图", async () => {
    // 注入假传输层：这个用例只验证「存副本 + 出处 + 能打开」。
    const html = `<html><head><title>白川石桥实拍</title>
      <meta property="og:image" content="https://cdn.example/white-river.jpg"></head></html>`;
    const { status, body } = await tool({
      url: "https://blog.example/white-river",
      kind: "same-spot",
      author: "某摄影师",
      platform: "小红书",
    });
    expect(status).toBe(200);
    const ref = body.result.ref;
    expect(ref.origin).toBe("web");
    expect(ref.kind).toBe("same-spot");
    expect(ref.page.url).toBe("https://blog.example/white-river");
    expect(ref.author).toBe("某摄影师");
    expect(ref.platform).toBe("小红书");
    // 页面里找到了分享图：副本已存，能打开，别人打不开。
    expect(ref.image.src).toContain(`/refs/${ref.id}/image`);
    const image = await app.request(ref.image.src, { headers: refHeaders() });
    expect(image.status).toBe(200);
    const denied = await app.request(ref.image.src, { headers: refHeaders(cookieB) });
    expect([403, 404]).toContain(denied.status);
    expect(body.result.warning).toBeUndefined();
  }, 30_000);

  it("拿不到图时只留来源，并说明原因", async () => {
    const { status, body } = await tool({
      url: "https://blog.example/no-picture",
      kind: "style",
      platform: "Pinterest",
    });
    expect(status).toBe(200);
    expect(body.result.ref.image).toBeNull();
    expect(body.result.imageUnavailable).toBe(true);
    expect(body.result.warning).toContain("404");
    expect(body.result.ref.page.url).toBe("https://blog.example/no-picture");
  });

  it("内网地址直接拒，不记进档案", async () => {
    const { status, body } = await tool({ url: "http://127.0.0.1:3001/v1/me", kind: "style" });
    expect(status).toBe(400);
    expect(body.code).toBe("REF_URL_FORBIDDEN");
  });
});
