import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startOneShotSmokeGuard } from "./local/one-shot-smoke-guard";

// Independent review: loopback only; fake transport cannot reach DeepSeek.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const aliases = ["deepseek-v4-flash", "deepseek-flash"];
const request = (model: string) => ({
  model, max_tokens: 1024, thinking: { type: "disabled" },
  messages: [{ role: "user", content: "独立测试 / \"quoted\"\nline" }],
});
async function fixture(transport: typeof fetch) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reinlab-b7-review-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const markerPath = join(root, "paid-marker");
  const token = randomBytes(32).toString("base64url");
  const options = { bindHost: "127.0.0.1", markerPath, incomingToken: token,
    upstreamKey: "independent_fixture_only", testOnlyTransport: transport, timeoutMs: 1000 };
  const guard = await startOneShotSmokeGuard(options);
  cleanup.push(() => guard.close());
  const post = (body: unknown, port = guard.port) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { options, markerPath, guard, post };
}
const invalid = [
  ["missing", undefined], ["null", null], ["enabled", { type: "enabled" }],
  ["uppercase value", { type: "DISABLED" }], ["uppercase key", { Type: "disabled" }],
  ["pseudo nested", { thinking: { type: "disabled" } }],
  ["extra property", { type: "disabled", budget_tokens: 1 }],
  ["empty", {}], ["array", [{ type: "disabled" }]], ["string", "disabled"],
  ["boolean", false], ["number", 0], ["null type", { type: null }],
  ["prototype spelling", { __proto__: null, constructor: { type: "disabled" } }],
] as const;
for (const model of aliases) {
  it.each(invalid)(`B7 independent ${model}: rejects %s without spending marker, then permits exactly one valid call`, async (_name, thinking) => {
    const transport = vi.fn(async () => new Response("fixture"));
    const f = await fixture(transport as typeof fetch);
    const bad: Record<string, unknown> = { ...request(model) };
    if (thinking === undefined) delete bad.thinking;
    else bad.thinking = thinking;
    expect((await f.post(bad)).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
    expect(f.guard.status()).toMatchObject({ status: "ready", forwardCount: 0, bytes: 0 });
    await expect(stat(f.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    const good = request(model);
    expect((await f.post(good)).status).toBe(200);
    expect((await f.post(good)).status).toBe(409);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toEqual(good);
    expect(await readFile(f.markerPath, "utf8")).toBe("consumed-v1\n");
  });
}
it.each(aliases)("B7 independent %s: oversized requests cannot spend marker", async model => {
  const transport = vi.fn(async () => new Response("fixture"));
  const f = await fixture(transport as typeof fetch);
  expect((await f.post({ ...request(model), messages: [{ role: "user", content: "x".repeat(65536) }] })).status).toBe(413);
  expect((await f.post({ ...request(model), max_tokens: 1025 })).status).toBe(400);
  await expect(stat(f.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(transport).not.toHaveBeenCalled();
  expect((await f.post(request(model))).status).toBe(200);
  expect(transport).toHaveBeenCalledTimes(1);
});
it("B7 independent two guard instances and both aliases race for one persistent slot", async () => {
  const transport = vi.fn(async () => new Response("fixture"));
  const f = await fixture(transport as typeof fetch);
  const second = await startOneShotSmokeGuard(f.options);
  cleanup.push(() => second.close());
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.post(request(aliases[i % 2]), i % 2 ? second.port : f.guard.port)));
  expect(responses.map(r => r.status).sort()).toEqual([200, ...Array(11).fill(409)]);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(f.guard.status().forwardCount + second.status().forwardCount).toBe(1);
});
it.each(["transport rejection", "upstream HTTP 400"])("B7 independent %s cannot restore authorization after restart", async failure => {
  const transport = vi.fn(async () => {
    if (failure === "transport rejection") throw Error("fixture transport failed");
    return new Response("fixture rejected", { status: 400 });
  });
  const f = await fixture(transport as typeof fetch);
  expect((await f.post(request(aliases[0]))).status).toBe(failure === "transport rejection" ? 502 : 400);
  expect(f.guard.status().forwardCount).toBe(1);
  await f.guard.close();
  const restarted = await startOneShotSmokeGuard(f.options);
  cleanup.push(() => restarted.close());
  expect(restarted.status()).toMatchObject({ status: "spent", forwardCount: 0 });
  expect((await f.post(request(aliases[1]), restarted.port)).status).toBe(409);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await readFile(f.markerPath, "utf8")).toBe("consumed-v1\n");
});
