import type { Hono } from "hono";
import type { KernelAuth } from "../kernel/auth";

/** Normalized per-request provider usage; `null` means the provider omitted it. */
export type NormalizedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type RecordedUsage = {
  account: string;
  dossier: string;
  run: string;
  provider: string;
  model: string;
  known: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costCny: string | null;
};

export type MessagesProxyDependencies = {
  auth: KernelAuth;
  /** Host-only transport: injects the real provider credential and streams back. */
  forward: (request: Request) => Promise<Response>;
  /** The single authoritative usage write. */
  record: (usage: RecordedUsage) => Promise<void>;
  now: () => number;
  providerBaseUrl: string;
  providerKey: string;
  provider?: string;
};

const tokenOf = (request: Request) => {
  const key = request.headers.get("x-api-key");
  if (key) return key.trim();
  const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  return bearer;
};

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Read provider usage from either a Messages SSE stream or its JSON body.
 * Returns undefined when the provider reported nothing usable: the caller must
 * record "unknown" instead of writing zero.
 */
export function extractUsage(text: string): NormalizedUsage | undefined {
  const usage: NormalizedUsage = {};
  let seen = false;
  const absorb = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const value = raw as RawUsage;
    const input = count(value.input_tokens),
      output = count(value.output_tokens),
      cacheRead = count(value.cache_read_input_tokens),
      cacheWrite = count(value.cache_creation_input_tokens);
    if (input !== undefined) (usage.inputTokens = input), (seen = true);
    if (output !== undefined) (usage.outputTokens = output), (seen = true);
    if (cacheRead !== undefined) (usage.cacheReadTokens = cacheRead), (seen = true);
    if (cacheWrite !== undefined) (usage.cacheWriteTokens = cacheWrite), (seen = true);
  };
  for (const line of text.split(/\r?\n/)) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!data || data === "[DONE]" || !data.startsWith("{")) continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.usage) absorb(event.usage);
    if (event.type === "message_start") absorb(event.message?.usage);
    if (event.type === "message_delta") absorb(event.usage);
  }
  return seen ? usage : undefined;
}

/**
 * Thin Messages API passthrough at `/llm/anthropic/v1/messages`.
 *
 * Authenticates a run token, forwards the request body unchanged to the
 * provider conversation endpoint with the host-held credential, relays the
 * response, and records provider usage exactly once. It adds no protocol
 * translation and no budget gate.
 */
export function registerMessagesProxy(
  app: Hono<any>,
  dependencies: MessagesProxyDependencies,
) {
  app.post("/llm/anthropic/v1/messages", async (c) => {
    const raw = tokenOf(c.req.raw);
    let claims: { account: string; dossier: string; run: string };
    try {
      claims = dependencies.auth.verify(raw, dependencies.now());
    } catch {
      return c.json({ error: "KERNEL_TOKEN_INVALID" }, 401);
    }
    const body = await c.req.text();
    let parsed: { model?: unknown; stream?: unknown };
    try {
      parsed = JSON.parse(body);
    } catch {
      return c.json({ error: "MESSAGES_BODY_INVALID" }, 400);
    }
    const model = typeof parsed.model === "string" ? parsed.model : "";
    const target = new URL(dependencies.providerBaseUrl.replace(/\/+$/, "") + "/v1/messages");
    const upstream = new Request(target, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "accept": c.req.header("accept") ?? "text/event-stream",
        "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
        "x-api-key": dependencies.providerKey,
      },
      signal: c.req.raw.signal,
    });
    const response = await dependencies.forward(upstream);
    const streamed = typeof parsed.stream === "boolean" ? parsed.stream : false;
    const headers = new Headers();
    headers.set("content-type", response.headers.get("content-type") ?? (streamed ? "text/event-stream" : "application/json"));
    headers.set("cache-control", "no-store");
    if (!response.body) return new Response(null, { status: response.status, headers });
    if (!streamed) {
      const text = await response.text();
      const usage = extractUsage(text);
      await recordUsage(dependencies, claims, model, usage);
      return new Response(text, { status: response.status, headers });
    }
    // Relays frames as they arrive and captures usage from the same bytes.
    const decoder = new TextDecoder();
    let captured = "";
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        captured += decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      },
      async flush() {
        captured += decoder.decode();
        await recordUsage(dependencies, claims, model, extractUsage(captured));
      },
    });
    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      headers,
    });
  });
}

async function recordUsage(
  dependencies: MessagesProxyDependencies,
  claims: { account: string; dossier: string; run: string },
  model: string,
  usage: NormalizedUsage | undefined,
) {
  await dependencies.record({
    account: claims.account,
    dossier: claims.dossier,
    run: claims.run,
    provider: dependencies.provider ?? "deepseek-official",
    model,
    known: usage !== undefined,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    costCny: null,
  });
}
