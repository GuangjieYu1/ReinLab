import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { getuid } from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface OneShotSmokeGuardOptions {
  bindHost: string;
  port?: number;
  incomingToken: string;
  upstreamKey: string;
  markerPath: string;
  timeoutMs?: number;
  testOnlyTransport?: typeof fetch;
}
export interface SmokeGuardStatus {
  forwardCount: number;
  bytes: number;
  priceBound: "0.500000";
  status: "ready" | "spent" | "forwarding" | "completed" | "unknown" | "closed";
}
export interface OneShotSmokeGuard {
  port: number;
  status(): SmokeGuardStatus;
  close(): Promise<void>;
}
const ceiling = 65536,
  upstream = "https://api.deepseek.com/chat/completions";
const fail = (status: number) =>
  Object.assign(new Error("SMOKE_GUARD_REJECTED"), { status });
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function keys(
  value: unknown,
  allowed: string[],
): asserts value is Record<string, any> {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw fail(400);
}
const string = (value: unknown) => typeof value === "string";
function functionCall(value: unknown) {
  keys(value, ["name", "arguments"]);
  if (!string(value.name) || !string(value.arguments)) throw fail(400);
}
function validate(value: unknown) {
  keys(value, [
    "model",
    "messages",
    "max_tokens",
    "n",
    "stream",
    "stream_options",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "stop",
    "response_format",
    "thinking",
    "reasoning_effort",
  ]);
  if (
    !["deepseek-v4-flash", "deepseek-flash"].includes(value.model) ||
    !Number.isInteger(value.max_tokens) ||
    value.max_tokens < 1 ||
    value.max_tokens > 1024 ||
    (value.n !== undefined && value.n !== 1)
  )
    throw fail(400);
  if (
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > 32
  )
    throw fail(400);
  for (const message of value.messages) {
    keys(message, [
      "role",
      "content",
      "name",
      "tool_call_id",
      "tool_calls",
      "reasoning_content",
    ]);
    if (!["system", "user", "assistant", "tool"].includes(message.role))
      throw fail(400);
    if (
      !string(message.content) &&
      !(
        Array.isArray(message.content) &&
        message.content.every((part: unknown) => {
          keys(part, ["type", "text"]);
          return part.type === "text" && string(part.text);
        })
      )
    )
      throw fail(400);
    for (const field of ["name", "tool_call_id", "reasoning_content"])
      if (message[field] !== undefined && !string(message[field]))
        throw fail(400);
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 64)
        throw fail(400);
      for (const call of message.tool_calls) {
        keys(call, ["id", "type", "function"]);
        if (call.type !== "function" || !string(call.id)) throw fail(400);
        functionCall(call.function);
      }
    }
  }
  for (const field of ["stream", "parallel_tool_calls"])
    if (value[field] !== undefined && typeof value[field] !== "boolean")
      throw fail(400);
  if (value.stream_options !== undefined) {
    keys(value.stream_options, ["include_usage"]);
    if (
      value.stream !== true ||
      typeof value.stream_options.include_usage !== "boolean"
    )
      throw fail(400);
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || value.tools.length > 64) throw fail(400);
    for (const tool of value.tools) {
      keys(tool, ["type", "function"]);
      if (tool.type !== "function") throw fail(400);
      keys(tool.function, ["name", "description", "parameters", "strict"]);
      if (
        !string(tool.function.name) ||
        (tool.function.description !== undefined &&
          !string(tool.function.description)) ||
        (tool.function.parameters !== undefined &&
          !record(tool.function.parameters)) ||
        (tool.function.strict !== undefined &&
          typeof tool.function.strict !== "boolean")
      )
        throw fail(400);
    }
  }
  if (
    value.tool_choice !== undefined &&
    !["none", "auto", "required"].includes(value.tool_choice)
  ) {
    keys(value.tool_choice, ["type", "function"]);
    keys(value.tool_choice.function, ["name"]);
    if (
      value.tool_choice.type !== "function" ||
      !string(value.tool_choice.function.name)
    )
      throw fail(400);
  }
  for (const [field, min, max] of [
    ["temperature", 0, 2],
    ["top_p", 0, 1],
    ["frequency_penalty", -2, 2],
    ["presence_penalty", -2, 2],
  ] as const)
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "number" ||
        !Number.isFinite(value[field]) ||
        value[field] < min ||
        value[field] > max)
    )
      throw fail(400);
  if (value.seed !== undefined && !Number.isSafeInteger(value.seed))
    throw fail(400);
  if (
    value.stop !== undefined &&
    !string(value.stop) &&
    !(
      Array.isArray(value.stop) &&
      value.stop.length <= 16 &&
      value.stop.every(string)
    )
  )
    throw fail(400);
  if (value.response_format !== undefined) {
    keys(value.response_format, ["type"]);
    if (!["text", "json_object"].includes(value.response_format.type))
      throw fail(400);
  }
  if (value.thinking !== undefined) {
    keys(value.thinking, ["type"]);
    if (value.thinking.type !== "disabled") throw fail(400);
  }
  if (value.reasoning_effort !== undefined && value.reasoning_effort !== "none")
    throw fail(400);
  return value;
}
function privateHost(host: string) {
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split(".").map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
async function readBody(request: IncomingMessage) {
  if (
    request.headers["content-encoding"] !== undefined ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers["content-type"] ?? "",
    )
  )
    throw fail(400);
  const declared = request.headers["content-length"];
  if (
    declared !== undefined &&
    (!/^\d+$/.test(declared) || Number(declared) > ceiling)
  )
    throw fail(413);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > ceiling) throw fail(413);
    chunks.push(Buffer.from(chunk));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw fail(400);
  }
  const encoded = Buffer.from(JSON.stringify(validate(parsed)));
  if (encoded.length > ceiling) throw fail(413);
  return encoded;
}
/** Temporary CLI-only single-forward budget guard. Never a mock model or general proxy. */
export async function startOneShotSmokeGuard(
  options: OneShotSmokeGuardOptions,
): Promise<OneShotSmokeGuard> {
  options = Object.freeze({ ...options });
  if (
    (options.testOnlyTransport && process.env.NODE_ENV !== "test") ||
    !privateHost(options.bindHost) ||
    !/^[A-Za-z0-9_-]{43}$/.test(options.incomingToken) ||
    /^sk-/i.test(options.incomingToken) ||
    !options.upstreamKey ||
    /[\r\n]/.test(options.upstreamKey)
  )
    throw fail(400);
  const timeout = options.timeoutMs ?? 90000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000)
    throw fail(400);
  const marker = resolve(options.markerPath),
    directory = dirname(marker),
    info = await stat(directory);
  if (
    (await realpath(directory)) !== directory ||
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== getuid?.()
  )
    throw fail(400);
  let status: SmokeGuardStatus["status"] = "ready",
    forwardCount = 0,
    bytes = 0,
    closed = false;
  try {
    await lstat(marker);
    status = "spent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fail(400);
  }
  const transport = options.testOnlyTransport ?? fetch,
    expected = Buffer.from(options.incomingToken),
    controllers = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined,
      forwarded = false;
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableFinished) abort();
    });
    try {
      const auth = request.headers.authorization ?? "",
        candidate = Buffer.from(
          auth.startsWith("Bearer ") ? auth.slice(7) : "",
        );
      if (
        request.rawHeaders.filter(
          (_, index) =>
            index % 2 === 0 &&
            request.rawHeaders[index].toLowerCase() === "authorization",
        ).length !== 1 ||
        candidate.length !== expected.length ||
        !timingSafeEqual(candidate, expected)
      )
        throw fail(401);
      if (request.method !== "POST" || request.url !== "/v1/chat/completions")
        throw fail(404);
      const body = await readBody(request);
      if (controller.signal.aborted || closed) throw fail(503);
      let handle;
      try {
        handle = await open(marker, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          if (forwardCount === 0) status = "spent";
          throw fail(409);
        }
        throw fail(503);
      }
      status = "spent";
      try {
        await handle.writeFile("consumed-v1\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      status = "spent";
      bytes = body.length;
      if (controller.signal.aborted || closed) throw fail(503);
      timer = setTimeout(abort, timeout);
      status = "forwarding";
      forwardCount++;
      forwarded = true;
      const result = await transport(upstream, {
        method: "POST",
        headers: {
          authorization: "Bearer " + options.upstreamKey,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      response.statusCode = result.status;
      const contentType = result.headers.get("content-type");
      if (contentType) response.setHeader("content-type", contentType);
      if (result.body)
        await pipeline(
          Readable.fromWeb(
            result.body as Parameters<typeof Readable.fromWeb>[0],
          ),
          response,
        );
      else response.end();
      if (!closed) status = "completed";
    } catch (error) {
      const code = (error as { status?: number }).status;
      if (forwarded && !closed) status = "unknown";
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(
          code && [400, 401, 404, 409, 413, 503].includes(code) ? code : 502,
          { "content-type": "application/json" },
        );
        response.end(
          JSON.stringify({
            code:
              code === 409 ? "SMOKE_ALREADY_CONSUMED" : "SMOKE_GUARD_REJECTED",
          }),
        );
      } else if (!response.writableFinished) response.destroy();
    } finally {
      if (timer) clearTimeout(timer);
      controllers.delete(controller);
      request.removeListener("aborted", abort);
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.bindHost, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  return Object.freeze({
    port: (server.address() as { port: number }).port,
    status: () =>
      Object.freeze({
        forwardCount,
        bytes,
        priceBound: "0.500000" as const,
        status,
      }),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      status = "closed";
    },
  });
}
