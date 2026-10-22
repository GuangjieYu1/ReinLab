import {
  bootstrapMcp,
  accountFiles,
  cleanupMcp,
  removeMcp,
} from "../../services/account-runtime/mcp/store.mjs";
import { umask, getuid, setgroups, setgid, setuid } from "node:process";
import { mkdir, writeFile, chmod, lstat, chown } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { prepareAccountRole } from "../../services/control/src/bridge/openscience/role-project.ts";
export function accountGlobalConfiguration({
  pluginUrl,
  model = "deepseek/deepseek-v4-flash",
}) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/.test(model))
    throw Error("ACCOUNT_MODEL_INVALID");
  return {
    autoupdate: false,
    plugin: [pluginUrl],
    model,
    small_model: model,
    enabled_providers: [model.split("/")[0]],
    agent: { title: { disable: true } },
  };
}
export async function startAccount({
  root = "/data",
  executable = "/opt/os/node_modules/.bin/openscience",
  pluginUrl = "file:///opt/reinlab/plugin/index.js",
  environment = process.env,
} = {}) {
  const fail = (code) => {
    console.error(JSON.stringify({ code }));
    process.exit(1);
  };
  const env = environment,
    token = env.OPENSCIENCE_AUTH_TOKEN;
  if (
    env.REINLAB_ACCOUNT_DRIVER !== undefined &&
    !["fly", "docker"].includes(env.REINLAB_ACCOUNT_DRIVER)
  )
    fail("ACCOUNT_CONFIG_MISSING");
  if (
    !token ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !/^[A-Za-z0-9_-]{43}$/.test(env.REINLAB_CONTAINER_SECRET ?? "") ||
    !/^[a-f0-9-]{36}$/.test(env.REINLAB_ACCOUNT_ID ?? "")
  )
    fail("ACCOUNT_CONFIG_MISSING");
  umask(0o077);
  // A fresh Fly volume is root-owned; initialize only managed directories, then drop all privilege.
  if (getuid?.() === 0) {
    for (const dir of [
      root,
      root + "/dossiers",
      root + "/os-data",
      root + "/os-config",
      root + "/mcp-state",
    ]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!(await lstat(dir)).isDirectory()) fail("ACCOUNT_PATH_UNSAFE");
      await chown(dir, 1000, 1000);
      await chmod(dir, 0o700);
    }
    setgroups([]);
    setgid(1000);
    setuid(1000);
  }
  for (const dir of [
    root + "/dossiers",
    root + "/os-data",
    root + "/os-config",
    root + "/mcp-state",
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await lstat(dir)).isDirectory()) fail("ACCOUNT_PATH_UNSAFE");
    await chmod(dir, 0o700);
  }
  await writeFile(
    root + "/os-config/openscience.json",
    JSON.stringify(
      accountGlobalConfiguration({
        pluginUrl,
        model: env.OPENSCIENCE_DEFAULT_MODEL,
      }),
    ),
    { mode: 0o600 },
  );
  // Upstream remains loopback-only. Our IPv6 listener cannot collide with its IPv4 listener.
  const child = spawn(
    executable,
    ["serve", "--port", "4096", "--format", "json"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root,
      detached: true,
      env: {
        ...env,
        OPENSCIENCE_DISABLE_AUTOUPDATE: "1",
        HOME: root,
        XDG_CACHE_HOME: root + "/cache",
        XDG_DATA_HOME: root,
        OPENSCIENCE_DATA_DIR: root + "/os-data",
        OPENSCIENCE_CONFIG_DIR: root + "/os-config",
      },
    },
  );
  let stopping = false,
    ready = false;
  const authorized = (value) => {
    const b = Buffer.from(value ?? ""),
      expected = Buffer.from("Bearer " + token);
    return b.length === expected.length && timingSafeEqual(b, expected);
  };
  const proxy = createServer((req, res) => {
    if (!ready) {
      res.writeHead(503).end();
      return;
    }
    if (
      req.headers.origin ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      !authorized(req.headers.authorization)
    ) {
      res.writeHead(403).end();
      return;
    }
    if (
      [
        "/reinlab/mcp/bootstrap",
        "/reinlab/mcp/files",
        "/reinlab/mcp/cleanup",
      ].includes(req.url)
    ) {
      if (
        req.method !== "POST" ||
        !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
      ) {
        res.writeHead(400).end();
        return;
      }
      void (async () => {
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 12 * 1024 * 1024) {
              res.writeHead(413).end();
              return;
            }
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const result =
            req.url === "/reinlab/mcp/bootstrap"
              ? await bootstrapMcp(root, body, env.REINLAB_CONTROL_URL)
              : req.url === "/reinlab/mcp/cleanup"
                ? await removeMcp(root, body.runId)
                : await accountFiles(root, body);
          res
            .writeHead(200, {
              "content-type": "application/json",
              "cache-control": "no-store",
            })
            .end(JSON.stringify(result));
        } catch {
          res.writeHead(403).end();
        }
      })();
      return;
    }
    if (req.url === "/reinlab/roles/prepare") {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
      ) {
        res.writeHead(415).end();
        return;
      }
      void (async () => {
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 1024 * 1024) {
              res.writeHead(413).end();
              return;
            }
            chunks.push(chunk);
          }
          const receipt = await prepareAccountRole(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
            { root, pluginUrl, accountId: env.REINLAB_ACCOUNT_ID },
          );
          res
            .writeHead(200, {
              "content-type": "application/json",
              "cache-control": "no-store",
            })
            .end(JSON.stringify(receipt));
        } catch {
          if (!res.headersSent)
            res
              .writeHead(403, { "content-type": "application/json" })
              .end(JSON.stringify({ code: "SCOPE_DENIED" }));
          else res.destroy();
        }
      })();
      return;
    }
    if (req.url === "/reinlab/backup") {
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/x-tar",
        "cache-control": "no-store",
      });
      const archive = spawn(
        "tar",
        ["--one-file-system", "-cf", "-", "-C", root, "dossiers", "mcp-state"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      archive.stdout.pipe(res, { end: false });
      res.on("close", () => archive.kill("SIGTERM"));
      archive.on("error", () => res.destroy());
      archive.on("close", (code) => {
        if (code === 0) res.end();
        else res.destroy();
      });
      return;
    }
    const headers = { ...req.headers, host: "127.0.0.1:4096" };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = request(
      {
        host: "127.0.0.1",
        port: 4096,
        path: req.url,
        method: req.method,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  const signalChild = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    proxy.close();
    signalChild("SIGTERM");
    setTimeout(() => {
      signalChild("SIGKILL");
      process.exit(1);
    }, 10000).unref();
  };
  const mcpCleanup = setInterval(() => {
    void cleanupMcp(root);
  }, 30000);
  mcpCleanup.unref();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
  child.stderr.resume(); // No upstream logs: prompts, errors and credentials must never reach platform logs.
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.length > 4096) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value.type !== "server.ready") return;
    if (
      value.schemaVersion !== 1 ||
      value.version !== "2.0.150" ||
      !["http://127.0.0.1:4096", "http://localhost:4096"].includes(value.url)
    ) {
      console.error(JSON.stringify({ code: "ACCOUNT_READY_INVALID" }));
      stop();
      return;
    }
    const health = request(
      {
        host: "127.0.0.1",
        port: 4096,
        path: "/global/health",
        headers: { authorization: "Bearer " + token },
      },
      (res) => {
        res.resume();
        if (res.statusCode !== 200) {
          console.error(JSON.stringify({ code: "ACCOUNT_LOOPBACK_UNHEALTHY" }));
          stop();
          return;
        }
        ready = true;
        proxy.listen(
          env.REINLAB_ACCOUNT_DRIVER === "docker"
            ? { host: "0.0.0.0", port: 4097 }
            : { host: "::", port: 4096, ipv6Only: true },
          () =>
            console.log(
              JSON.stringify({
                type: "account.ready",
                schemaVersion: 1,
                version: "2.0.150",
              }),
            ),
        );
      },
    );
    health.on("error", () => {
      console.error(JSON.stringify({ code: "ACCOUNT_LOOPBACK_FAILED" }));
      stop();
    });
    health.setTimeout(5000, () => {
      health.destroy();
      stop();
    });
    health.end();
  });
  proxy.on("upgrade", (_req, socket) =>
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"),
  );
  proxy.on("error", () => {
    console.error(JSON.stringify({ code: "ACCOUNT_PROXY_ERROR" }));
    stop();
  });
  child.on("error", () => fail("ACCOUNT_RUNTIME_START_FAILED"));
  child.on("exit", (code) => {
    signalChild("SIGTERM");
    proxy.close();
    process.exit(stopping ? 0 : code || 1);
  });
  setTimeout(() => {
    if (!ready) {
      console.error(JSON.stringify({ code: "ACCOUNT_START_TIMEOUT" }));
      stop();
    }
  }, 120000).unref();
}
if (
  process.argv[1] &&
  import.meta.url === new URL("file://" + process.argv[1]).href
)
  await startAccount();
