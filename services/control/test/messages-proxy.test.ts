import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync } from "node:crypto";
import { KernelAuth } from "../src/kernel/auth";
import { extractUsage, registerMessagesProxy } from "../src/model/messages-proxy";

const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
const now = 1_800_000_000;
const ids = {
  account: "10000000-0000-4000-8000-000000000001",
  dossier: "20000000-0000-4000-8000-000000000002",
  run: "30000000-0000-4000-8000-000000000003",
};
const token = auth.issue(ids, now);

const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const started = sse({
  type: "message_start",
  message: { usage: { input_tokens: 120, cache_read_input_tokens: 30 } },
});
const delta = sse({
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 45 },
});
const done = sse({ type: "message_stop" });

function app(options: {
  upstream?: () => Response;
  record?: (usage: unknown) => Promise<void>;
}) {
  const forward = vi.fn(async (_request: Request) =>
    options.upstream ? options.upstream() : new Response("{}", { status: 200 }),
  );
  const record = vi.fn(options.record ?? (async () => {}));
  const hono = new Hono();
  registerMessagesProxy(hono, {
    auth,
    forward,
    record,
    now: () => now + 10,
    providerBaseUrl: "https://provider.invalid/anthropic",
    providerKey: "real-provider-key",
  });
  return { hono, forward, record };
}

const post = (hono: Hono, init: { token?: string | null; body?: unknown } = {}) =>
  hono.request("/llm/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token === null
        ? {}
        : { "x-api-key": init.token ?? token }),
    },
    body: JSON.stringify(init.body ?? { model: "deepseek-v4-flash", stream: true, max_tokens: 4096, messages: [{ role: "user", content: "hi" }] }),
  });

describe("messages proxy", () => {
  it("rejects a missing or foreign token without touching the provider", async () => {
    const { hono, forward, record } = app({});
    expect((await post(hono, { token: null })).status).toBe(401);
    expect((await post(hono, { token: "not-a-token" })).status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("relays the provider stream byte-for-byte and forwards the body unchanged", async () => {
    let seen: string | undefined;
    const upstreamBody = started + delta + done;
    const { hono, forward } = app({
      upstream: () => new Response(upstreamBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
      record: async () => {},
    });
    forward.mockImplementationOnce(async (request: Request) => {
      seen = await request.text();
      return new Response(upstreamBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const response = await post(hono);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamBody);
    expect(JSON.parse(seen!)).toMatchObject({ stream: true, max_tokens: 4096 });
  });

  it("records exactly one usage row per provider request", async () => {
    const rows: unknown[] = [];
    const { hono } = app({
      upstream: () => new Response(started + delta + done, { status: 200, headers: { "content-type": "text/event-stream" } }),
      record: async (usage) => void rows.push(usage),
    });
    const response = await post(hono);
    await response.text();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account: ids.account,
      dossier: ids.dossier,
      run: ids.run,
      known: true,
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 30,
    });
  });

  it("records unknown usage rather than zero when the provider omits it", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const { hono } = app({
      upstream: () => new Response(sse({ type: "message_stop" }), { status: 200 }),
      record: async (usage) => void rows.push(usage as Record<string, unknown>),
    });
    const response = await post(hono);
    await response.text();
    expect(rows).toHaveLength(1);
    expect(rows[0].known).toBe(false);
    expect(rows[0].inputTokens).toBeNull();
    expect(rows[0].outputTokens).toBeNull();
    expect(rows[0].costCny).toBeNull();
  });

  it("extracts cumulative usage from message_start plus message_delta", () => {
    expect(extractUsage(started + delta)).toMatchObject({ inputTokens: 120, outputTokens: 45, cacheReadTokens: 30 });
    expect(extractUsage(sse({ type: "message_stop" }))).toBeUndefined();
    expect(extractUsage(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 6 } }))).toMatchObject({ inputTokens: 5, outputTokens: 6 });
  });
});
