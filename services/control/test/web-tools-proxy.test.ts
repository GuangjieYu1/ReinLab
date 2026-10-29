import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync } from "node:crypto";
import { KernelAuth } from "../src/kernel/auth";
import { registerWebToolsProxy } from "../src/model/web-tools-proxy";

const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
const now = 1_800_000_000;
const ids = {
  account: "10000000-0000-4000-8000-000000000001",
  dossier: "20000000-0000-4000-8000-000000000002",
  run: "30000000-0000-4000-8000-000000000003",
};
const token = auth.issue(ids, now);

function app(upstream: (request: Request) => Promise<Response>) {
  const forward = vi.fn(upstream);
  const record = vi.fn(async () => {});
  const hono = new Hono();
  registerWebToolsProxy(hono, {
    auth,
    now: () => now + 1,
    providerBaseUrl: "https://api.deepseek.com",
    providerKey: "host-key",
    feeCny: "0.005000",
    forward,
    record,
  });
  return { hono, forward, record };
}

const post = (hono: Hono, path: string, body: unknown, bearer: string | null = token) =>
  hono.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
    body: JSON.stringify(body),
  });

describe("DeepSeek Search / Fetch 代理", () => {
  it("用宿主密钥转发，只把结果交回内核，不暴露密钥", async () => {
    const { hono, forward } = app(async () =>
      new Response(JSON.stringify({ results: [{ title: "T", url: "https://example.com", snippet: "s" }] }), {
        status: 200,
      }),
    );
    const response = await post(hono, "/llm/deepseek/v1/tools/search", { query: "toolformer", count: 3 });
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ results: [{ url: "https://example.com" }] });
    const request = forward.mock.calls[0][0] as Request;
    expect(request.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(request.headers.get("authorization")).toBe("Bearer host-key");
    expect(await request.text()).toContain("toolformer");
  });

  it("成功的搜索按次数费入账，空结果不计费", async () => {
    const paid = app(async () => new Response(JSON.stringify({ results: [{ title: "T", url: "u", snippet: "s" }] }), { status: 200 }));
    await post(paid.hono, "/llm/deepseek/v1/tools/search", { query: "q" });
    expect(paid.record).toHaveBeenCalledWith({
      account: ids.account,
      dossier: ids.dossier,
      run: ids.run,
      provider: "deepseek",
      model: "tools-search",
      known: true,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costCny: "0.005000",
    });
    const empty = app(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    await post(empty.hono, "/llm/deepseek/v1/tools/search", { query: "q" });
    expect(empty.record).not.toHaveBeenCalled();
  });

  it("上游失败时把状态和原因交回，不冒充成功", async () => {
    const { hono, record } = app(async () =>
      new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 }),
    );
    const response = await post(hono, "/llm/deepseek/v1/tools/fetch", { url: "https://example.com" });
    expect(response.status).toBe(429);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: "WEB_PROVIDER_STATUS", message: expect.stringContaining("quota exceeded") },
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("没有运行令牌就不转发", async () => {
    const { hono, forward } = app(async () => new Response("{}", { status: 200 }));
    expect((await post(hono, "/llm/deepseek/v1/tools/search", { query: "q" }, null)).status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });
});
