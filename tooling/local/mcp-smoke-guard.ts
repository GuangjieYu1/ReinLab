import { getuid } from 'node:process';
import { constants } from "node:fs";
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { open, lstat, realpath } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { readSmokeBody } from "./one-shot-smoke-guard";
/** One authorized workflow, at most six distinct sequential model rounds. No restart/resubmission. */
export async function startMcpSmokeGuard(options: {
  incomingToken: string;
  upstreamKey: string;
  markerPath: string;
  testOnlyTransport?: typeof fetch;
}) {
  if (
    (options.testOnlyTransport && process.env.NODE_ENV !== "test") ||
    !/^[A-Za-z0-9_-]{43}$/.test(options.incomingToken) ||
    !options.upstreamKey ||
    /[\r\n]/.test(options.upstreamKey)
  )
    throw Error("MCP_SMOKE_CONFIGURATION_INVALID");
  const marker = resolve(options.markerPath),
    parent = dirname(marker),
    info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(parent)) !== parent
  )
    throw Error("MCP_SMOKE_CONFIGURATION_INVALID");
  let spent = false;
  try {
    await lstat(marker);
    spent = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error("MCP_SMOKE_CONFIGURATION_INVALID");
  }
  let markerIdentity: { dev: number; ino: number } | undefined;
  let count = 0,
    active = false,
    closed = false,
    unknown = false;
  const hashes = new Set<string>(),
    controllers = new Set<AbortController>();
  const transport = options.testOnlyTransport ?? fetch,
    expected = Buffer.from(options.incomingToken);
  const reflectsCredential = (value: unknown) => {
    const pending: unknown[] = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "string") {
        if (
          item.includes(options.upstreamKey) ||
          item.includes(options.incomingToken)
        ) return true;
        // Tool-call arguments are JSON inside a JSON string and the SDK parses them again.
        if (/^\s*[\[{\"]/.test(item)) {
          try {
            pending.push(JSON.parse(item));
          } catch {
            // Ordinary model text can start with punctuation without being nested JSON.
          }
        }
      } else if (item && typeof item === "object") {
        for (const [key, child] of Object.entries(item)) pending.push(key, child);
      }
    }
    return false;
  };
  const server = createServer(async (req, res) => {
    let forwarded = false,
      owns = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reject = (status: number) => {
      throw Object.assign(Error("MCP_SMOKE_REJECTED"), { status });
    };
    try {
      const auth = req.headers.authorization ?? "",
        candidate = Buffer.from(
          auth.startsWith("Bearer ") ? auth.slice(7) : ""
        );
      if (
        req.rawHeaders.filter(
          (_, i) =>
            i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "authorization"
        ).length !== 1 ||
        candidate.length !== expected.length ||
        !timingSafeEqual(candidate, expected)
      )
        reject(401);
      if (req.method !== "POST" || req.url !== "/v1/chat/completions")
        reject(404);
      if (spent || closed || unknown || count >= 6 || active) reject(409);
      active = true;
      owns = true;
      const body = await readSmokeBody(req),
        hash = createHash("sha256").update(body).digest("hex");
      if (hashes.has(hash)) reject(409);
      const data = JSON.parse(body.toString("utf8"));
      if (
        data.messages.some(
          (m: any) =>
            m.role === "tool" &&
            typeof m.content === "string" &&
            /^(?:Error:|\{"error":)/.test(m.content)
        )
      )
        reject(409);
      // Body <=65536B, 1024 output. Six rounds, even with 4096 input overhead each,
      // peak USD→CNY 7.2 bound: 6*((65536+4096)*0.30+1024*1.20)*7.2/1e6 = .95551488.
      const currentParent = await lstat(parent);
      if (
        !currentParent.isDirectory() ||
        currentParent.isSymbolicLink() ||
        currentParent.dev !== info.dev ||
        currentParent.ino !== info.ino ||
        currentParent.uid !== getuid?.() ||
        (currentParent.mode & 0o777) !== 0o700 ||
        (await realpath(parent)) !== parent
      )
        reject(409);
      const handle = await open(
        marker,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (count === 0 ? constants.O_CREAT | constants.O_EXCL : 0),
        0o600
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== getuid?.() ||
          (stat.mode & 0o777) !== 0o600 ||
          stat.size !== count * 65 ||
          (markerIdentity &&
            (stat.dev !== markerIdentity.dev ||
              stat.ino !== markerIdentity.ino))
        )
          reject(409);
        markerIdentity ??= { dev: stat.dev, ino: stat.ino };
        const directory = await open(
          parent,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
        try {
          const st = await directory.stat();
          if (st.dev !== info.dev || st.ino !== info.ino) reject(409);
          await handle.writeFile(hash + "\n");
          await handle.sync();
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await handle.close();
      }
      if (closed) reject(503);
      hashes.add(hash);
      count++;
      forwarded = true;
      controllers.add(controller);
      req.once("aborted", () => controller.abort());
      res.once("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      timer = setTimeout(() => controller.abort(), 90_000);
      const reply = await transport(
        "https://api.deepseek.com/chat/completions",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + options.upstreamKey,
            "content-type": "application/json",
          },
          body,
          redirect: "error",
          signal: controller.signal,
        }
      );
      if (!reply.ok) {
        unknown=true;await reply.body?.cancel();
        res.writeHead(reply.status,{'content-type':'application/json'}).end('{"code":"MCP_SMOKE_UPSTREAM_REJECTED"}');
        return;
      }
      res.statusCode = reply.status;
      const type = reply.headers.get("content-type")?.toLowerCase();
      if(!type || !/^(application\/json|text\/event-stream)(?:\s*;\s*charset=utf-8)?$/.test(type))throw Error('MCP_SMOKE_RESPONSE_TYPE');
      res.setHeader('content-type',type.startsWith('text/event-stream')?'text/event-stream; charset=utf-8':'application/json');
      const chunks: Uint8Array[] = [];
      let received = 0;
      if (reply.body) {
        const reader = reply.body.getReader();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            received += part.value.byteLength;
            if (received > 524288) {
              await reader.cancel();
              throw Error("MCP_SMOKE_RESPONSE_LIMIT");
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = Buffer.concat(chunks),
        text = bytes.toString("utf8");
      if(bytes.includes(Buffer.from(options.upstreamKey))||bytes.includes(expected))throw Error('MCP_SMOKE_RESPONSE_CREDENTIAL');
      try {
        if (type?.includes("text/event-stream")) {
          let finished = false,
            done = false;
          const streams = new Map<string, string>();
          const checkStream = (value: unknown) => {
            const pending = [{ path: "", value }];
            while (pending.length) {
              const { path, value: item } = pending.pop()!;
              if (typeof item === "string") {
                const combined = (streams.get(path) ?? "") + item;
                streams.set(path, combined);
                if (reflectsCredential(combined)) unknown = true;
              } else if (Array.isArray(item)) {
                // OpenAI choices and tool calls merge by their declared index, not array position.
                for (let position = item.length - 1; position >= 0; position--) {
                  const child = item[position];
                  const index = Number.isSafeInteger(child?.index) && child.index >= 0
                    ? child.index : position;
                  pending.push({ path: path + "/[" + index + "]", value: child });
                }
              } else if (item && typeof item === "object") {
                for (const [key, child] of Object.entries(item).reverse())
                  pending.push({ path: path + "/" + JSON.stringify(key), value: child });
              }
            }
          };
          for (const line of text.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              done = true;
              continue;
            }
            if (!data) continue;
            const value = JSON.parse(data);
            if (reflectsCredential(value)) unknown = true;
            checkStream(value);
            if (value.error) unknown = true;
            if (
              value.choices?.some((choice: any) =>
                ["stop", "tool_calls"].includes(choice.finish_reason)
              )
            )
              finished = true;
          }
          if (!done || !finished) unknown = true;
        } else {
          const value = JSON.parse(text);
          if (reflectsCredential(value)) unknown = true;
          if (
            value.error ||
            !value.choices?.some((choice: any) =>
              ["stop", "tool_calls"].includes(choice.finish_reason)
            )
          )
            unknown = true;
        }
      } catch {
        unknown = true;
      }
      if (unknown) throw Error("MCP_SMOKE_RESPONSE_UNKNOWN");
      res.end(bytes);
    } catch (e) {
      if (forwarded || (owns && count > 0)) unknown = true;
      const status = (e as any).status;
      if (!res.headersSent && !res.destroyed)
        res
          .writeHead(
            [400, 401, 404, 409, 413, 503].includes(status) ? status : 502,
            { "content-type": "application/json" }
          )
          .end('{"code":"MCP_SMOKE_REJECTED"}');
      else if (!res.writableFinished) res.destroy();
    } finally {
      if (timer) clearTimeout(timer);
      controllers.delete(controller);
      if (owns) active = false;
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 15000;
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    port: (server.address() as { port: number }).port,
    status: () => ({
      forwardCount: count,
      maxRounds: 6,
      unknown,
      spent,
      closed,
      boundCny: "0.955515",
    }),
    async close() {
      closed = true;
      for (const c of controllers) c.abort();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
