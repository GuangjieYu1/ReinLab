import type { Hono } from "hono";
import type { KernelAuth } from "../kernel/auth";

/** Normalized per-request provider usage; `null` means the provider omitted it. */
export type NormalizedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** 最后一条消息里有没有图片块（这一轮是不是刚把图送进去）。 */
function lastMessageHasImage(body: unknown): boolean {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || !messages.length) return false;
  const last = messages[messages.length - 1] as { content?: unknown };
  const content = last?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => (block as { type?: unknown })?.type === "image");
}

export type RecordedUsage = {
  account: string;
  dossier: string;
  run: string;
  /** 这一请求的用途：带图就是读图，否则按计划编排。 */
  purpose?: "planning" | "vision" | "weather_judge" | "weather_adjust" | null;
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
  /** 有的网关（opencodego）要求带会话 id 才路由。 */
  providerSession?: string;
};

export const tokenOf = (request: Request) => {
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
    if (process.env.REINLAB_DEBUG_MODEL_HEADERS === "1")
      console.error(
        JSON.stringify({
          code: "MODEL_HEADERS",
          headers: Object.fromEntries(
            [...c.req.raw.headers.entries()]
              .filter(([name]) => !["cookie", "authorization", "x-api-key"].includes(name))
              .map(([name, value]) => [name, value.slice(0, 80)]),
          ),
        }),
      );
    const rawBody = await c.req.text();
    let parsed: { model?: unknown; stream?: unknown };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "MESSAGES_BODY_INVALID" }, 400);
    }
    // 只转发 Anthropic Messages 认的字段：DSH 会带自己的私有字段（比如 dsh_plugin_packages），
    // 官方网关可能无视，但 opencodego 会直接 400（requires a native Anthropic Messages target）。
    const ALLOWED_FIELDS = new Set([
      "model",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "max_tokens",
      "temperature",
      "top_p",
      "top_k",
      "stop_sequences",
      "stream",
      "metadata",
      "thinking",
      "betas",
      "service_tier",
    ]);
    const dropped = Object.keys(parsed as Record<string, unknown>).filter(
      (key) => !ALLOWED_FIELDS.has(key),
    );
    const body = dropped.length
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter(([key]) =>
              ALLOWED_FIELDS.has(key),
            ),
          ),
        )
      : rawBody;
    if (dropped.length)
      console.error(
        JSON.stringify({ code: "MODEL_BODY_FIELDS_DROPPED", fields: dropped.slice(0, 8) }),
      );
    const model = typeof parsed.model === "string" ? parsed.model : "";
    // 只把「真正在首次读这几张图」的那一笔算读图：请求里**最后一条消息**带图片内容块才算。
    // 后续步骤会把历史里的图一起回传，那些只是在延续思考，按编排记。
    const purpose = lastMessageHasImage(parsed) ? ("vision" as const) : ("planning" as const);
    // 网关的 base 有两种写法：官方 DeepSeek 是 .../anthropic（要补 /v1/messages），
    // opencodego 是 .../v1（只要补 /messages）。按结尾判断，别拼出 /v1/v1。
    const base = dependencies.providerBaseUrl.replace(/\/+$/, "");
    const target = new URL(base.endsWith("/v1") ? base + "/messages" : base + "/v1/messages");
    const upstream = new Request(target, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "accept": c.req.header("accept") ?? "text/event-stream",
        "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
        "x-api-key": dependencies.providerKey,
        ...(dependencies.providerSession
          ? { "x-opencode-session": dependencies.providerSession }
          : {}),
      },
      signal: c.req.raw.signal,
    });
    // 网络抖动先重试：转发层偶发 fetch failed / 上游 5xx 时，这一次请求还没拿到
    // 任何内容（也没记用量），重发同一条请求是安全的；三次都失败才把失败交上去。
    const forwardWithRetry = async (): Promise<Response> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await dependencies.forward(upstream.clone());
          if (response.status < 500 && response.status !== 429) return response;
          lastError = new Error(`MODEL_UPSTREAM_${response.status}`);
          await response.body?.cancel().catch(() => undefined);
        } catch (error) {
          lastError = error;
        }
        if (attempt < 2)
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 400 : 1200));
      }
      throw lastError;
    };
    let response: Response;
    try {
      response = await forwardWithRetry();
    } catch (error) {
      // 重试也失败：给 DSH 一个明确的、可重试的上游不可用，而不是 500 内部错误。
      console.error(
        JSON.stringify({
          code: "MODEL_UPSTREAM_UNAVAILABLE",
          message: String((error as Error)?.message ?? error).slice(0, 200),
        }),
      );
      return c.json(
        {
          error: "MODEL_UPSTREAM_UNAVAILABLE",
          message: "模型服务暂时连不上（网络或上游 5xx），这次请求没有拿到任何内容。",
        },
        503,
      );
    }
    const streamed = typeof parsed.stream === "boolean" ? parsed.stream : false;
    const headers = new Headers();
    headers.set("content-type", response.headers.get("content-type") ?? (streamed ? "text/event-stream" : "application/json"));
    headers.set("cache-control", "no-store");
    if (!response.body) return new Response(null, { status: response.status, headers });
    if (!streamed) {
      const text = await response.text();
      const usage = extractUsage(text);
      await recordUsage(dependencies, claims, model, usage, purpose);
      return new Response(text, { status: response.status, headers });
    }
    // Relays frames as they arrive and captures usage from the same bytes.
    //
    // 上游中途断开（用户网络或 DeepSeek 侧 ECONNRESET / ETIMEDOUT）时，别让这条
    // 响应「硬断」：DSH 运行时的 undici 会抛 TypeError: terminated，整个运行时以
    // 255 退出（现场见过三次）。这里改成发一个 SSE error 事件再正常收尾，
    // 运行时按「模型这次失败」处理（它的重试策略会接手），进程不会崩。
    const decoder = new TextDecoder();
    let captured = "";
    const encoder = new TextEncoder();
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        captured += decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      },
      async flush() {
        captured += decoder.decode();
        await recordUsage(dependencies, claims, model, extractUsage(captured), purpose);
      },
    });
    const relayed = response.body.pipeThrough(transform).pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
        flush(controller) {
          // 上游正常结束：什么也不补。
          void controller;
        },
      }),
    );
    // 上游中途断开时给运行时一个「干净的结束」（SSE error 帧 + close），
    // 而不是把连接硬断。控制器可能已经被对端关掉，所以每一步都要容错。
    const guarded = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = relayed.getReader();
        let open = true;
        const finish = () => {
          if (!open) return;
          open = false;
          try {
            controller.close();
          } catch {
            /* 已经关了 */
          }
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!open) break;
            try {
              controller.enqueue(value);
            } catch {
              open = false;
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
          finish();
        } catch (error) {
          console.error(
            JSON.stringify({
              code: "MODEL_UPSTREAM_STREAM_BROKEN",
              message: String((error as Error)?.message ?? error).slice(0, 200),
            }),
          );
          if (open) {
            try {
              controller.enqueue(
                encoder.encode(
                  `\n\nevent: error\ndata: ${JSON.stringify({
                    type: "error",
                    error: { type: "upstream_unavailable", message: "模型服务中途断开" },
                  })}\n\n`,
                ),
              );
            } catch {
              /* 对端已经关了：只收尾 */
            }
          }
          finish();
        }
      },
      cancel() {
        /* 对端主动取消：不用再补任何东西 */
      },
    });
    return new Response(guarded, {
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
  purpose: "planning" | "vision" | null = null,
) {
  await dependencies.record({
    account: claims.account,
    dossier: claims.dossier,
    run: claims.run,
    purpose,
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
