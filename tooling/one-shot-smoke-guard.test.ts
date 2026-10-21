import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { startOneShotSmokeGuard } from "./local/one-shot-smoke-guard";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const body = () => ({
  model: "deepseek-v4-flash",
  max_tokens: 1024,
  messages: [{ role: "user", content: "local fixture" }],
});
async function fixture(
  transport: typeof fetch = vi.fn(
    async () =>
      new Response('{"fixture":true}', {
        headers: { "content-type": "application/json" },
      }),
  ),
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-smoke-guard-")),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const token = randomBytes(32).toString("base64url"),
    markerPath = join(root, "consumed");
  const options = {
    bindHost: "127.0.0.1",
    incomingToken: token,
    upstreamKey: "fixture_upstream_credential",
    markerPath,
    testOnlyTransport: transport,
    timeoutMs: 100,
  };
  const guard = await startOneShotSmokeGuard(options);
  cleanup.push(() => guard.close());
  const url = "http://127.0.0.1:" + guard.port;
  const post = (
    value: unknown = body(),
    path = "/v1/chat/completions",
    auth = token,
  ) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + auth,
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
    });
  return { root, token, markerPath, options, guard, url, post, transport };
}
it("forwards one real-shaped request to the fixed URL, preserves response and persists private marker", async () => {
  const transport = vi.fn(async (url, init) => {
    expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture_upstream_credential",
    );
    return new Response("fixture bytes", {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const f = await fixture(transport);
  const response = await f.post();
  expect(response.status).toBe(201);
  expect(await response.text()).toBe("fixture bytes");
  expect((await stat(f.markerPath)).mode & 0o777).toBe(0o600);
  expect(f.guard.status()).toMatchObject({
    forwardCount: 1,
    priceBound: "0.500000",
    status: "completed",
  });
  expect(Object.keys(f.guard.status()).sort()).toEqual([
    "bytes",
    "forwardCount",
    "priceBound",
    "status",
  ]);
  expect(JSON.stringify(f.guard.status())).not.toContain("credential");
  expect((await f.post()).status).toBe(409);
  expect(transport).toHaveBeenCalledTimes(1);
});
it("concurrent requests and a restarted guard share the same irreversible marker", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.post(), f.post(), f.post()]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  expect(f.transport).toHaveBeenCalledTimes(1);
  await f.guard.close();
  const next = await startOneShotSmokeGuard(f.options);
  cleanup.push(() => next.close());
  expect(next.status().status).toBe("spent");
  const response = await fetch(
    "http://127.0.0.1:" + next.port + "/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + f.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body()),
    },
  );
  expect(response.status).toBe(409);
  expect(f.transport).toHaveBeenCalledTimes(1);
});
it.each([
  { max_tokens: 0 },
  { max_tokens: 1025 },
  { max_tokens: 1.5 },
  { max_completion_tokens: 100 },
  { n: 2 },
  { model: "other" },
  { web_search: true },
  { tools: [{ type: "web_search" }] },
  {
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.invalid" } },
        ],
      },
    ],
  },
  {
    messages: Array.from({ length: 33 }, () => ({
      role: "user",
      content: "x",
    })),
  },
])(
  "rejects budget/feature override %j before any upstream call",
  async (extra) => {
    const f = await fixture();
    expect((await f.post({ ...body(), ...extra })).status).toBe(400);
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.guard.status().forwardCount).toBe(0);
  },
);
it("rejects auth/path/body limits and still permits the first valid request afterwards", async () => {
  const f = await fixture();
  expect((await f.post(body(), "/v1/chat/completions", "invalid")).status).toBe(
    401,
  );
  expect((await f.post(body(), "/v1/models")).status).toBe(404);
  expect(
    (
      await f.post({
        ...body(),
        messages: [{ role: "user", content: "x".repeat(65536) }],
      })
    ).status,
  ).toBe(413);
  expect(f.transport).not.toHaveBeenCalled();
  expect((await f.post()).status).toBe(200);
});
it("permits only text content and standard function schema with stream usage metadata", async () => {
  const f = await fixture();
  expect(
    (
      await f.post({
        ...body(),
        stream: true,
        stream_options: { include_usage: true },
        n: 1,
        messages: [
          { role: "user", content: [{ type: "text", text: "fixture" }] },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "fixture",
              description: "local",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      })
    ).status,
  ).toBe(200);
});
it("streams upstream SSE transparently and cancels upstream on client disconnect", async () => {
  let upstreamSignal: AbortSignal | undefined;
  const transport = vi.fn(async (_url, init) => {
    upstreamSignal = init?.signal as AbortSignal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: fixture\n\n"));
          upstreamSignal.addEventListener(
            "abort",
            () => controller.error(new Error("fixture abort")),
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const f = await fixture(transport);
  const controller = new AbortController();
  const response = await fetch(f.url + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + f.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body(), stream: true }),
    signal: controller.signal,
  });
  expect(
    new TextDecoder().decode((await response.body!.getReader().read()).value),
  ).toBe("data: fixture\n\n");
  controller.abort();
  await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
  expect((await f.post()).status).toBe(409);
  expect(transport).toHaveBeenCalledTimes(1);
});
it("unknown upstream outcome and timeout never permit a retry or expose raw errors", async () => {
  const transport = vi.fn(
    async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("fixture_private_failure")),
          { once: true },
        );
      }),
  ) as typeof fetch;
  const f = await fixture(transport);
  const response = await f.post();
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("fixture_private_failure");
  expect((await f.post()).status).toBe(409);
  expect(transport).toHaveBeenCalledTimes(1);
});
it("production refuses injected upstream transport before listening", async () => {
  vi.stubEnv("NODE_ENV", "production");
  await expect(
    startOneShotSmokeGuard({
      bindHost: "127.0.0.1",
      incomingToken: "x".repeat(43),
      upstreamKey: "fixture",
      markerPath: "/unused",
      testOnlyTransport: vi.fn() as typeof fetch,
    }),
  ).rejects.toThrow();
});
it("valid chunked Node input is adapted without early upstream forwarding, and over-limit chunks consume no slot", async () => {
  const f = await fixture();
  const send = (raw: string) =>
    new Promise<number>((resolveStatus) => {
      const req = request(
        f.url + "/v1/chat/completions",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + f.token,
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolveStatus(response.statusCode!));
        },
      );
      req.on("error", () => resolveStatus(0));
      req.write(raw.slice(0, 100));
      req.end(raw.slice(100));
    });
  expect([0, 413]).toContain(
    await send(
      JSON.stringify({
        ...body(),
        messages: [{ role: "user", content: "x".repeat(65536) }],
      }),
    ),
  );
  expect(f.transport).not.toHaveBeenCalled();
  expect(await send(JSON.stringify(body()))).toBe(200);
  expect(f.transport).toHaveBeenCalledTimes(1);
});
it("guard close aborts an active upstream stream and never removes its consumed marker", async () => {
  let active: AbortSignal | undefined;
  const transport = vi.fn(async (_url, init) => {
    active = init?.signal as AbortSignal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: fixture\n\n"));
          active!.addEventListener(
            "abort",
            () => controller.error(new Error("fixture stopped")),
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const f = await fixture(transport);
  const response = await f.post({ ...body(), stream: true });
  await response.body!.getReader().read();
  await f.guard.close();
  expect(active?.aborted).toBe(true);
  expect((await stat(f.markerPath)).isFile()).toBe(true);
  expect(f.guard.status().status).toBe("closed");
  expect(transport).toHaveBeenCalledTimes(1);
});
