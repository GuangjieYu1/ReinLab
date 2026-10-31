/**
 * 手机/iPad 能真正打开的前提（design/prd/09-explore-v2.md §3.2、契约 §0）。
 *
 * `pnpm local:up22 --lan` 做三件事：
 * 1. 固定主机名（默认 reinlab.local，用 mDNS 广播到局域网）+ 固定端口（默认 8443），
 *    离线缓存认 origin，所以选一个之后不再改；换了对手机就是另一个站点。
 * 2. 本机 CA 签的证书：手机装一次 ca.pem 并信任，之后不靠忽略证书警告。
 * 3. 同源反代：https 上先服务构建后的前端（含 Service Worker），/backend 转给控制面，
 *    并带上 X-Forwarded-Proto/Host，让 Cookie 与同源校验按页面看到的源来。
 *
 * 开发模式（`pnpm dev`）不注册 Service Worker；这里服务的是构建产物，热更新不会来捣乱。
 */
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { quietCommand } from "./process";

const openSsl = promisify(execFile);

export const LAN_DEFAULT_HOST = "reinlab.local";
export const LAN_DEFAULT_PORT = 8443;

export type LanSite = {
  host: string;
  port: number;
  /** 局域网里的 IPv4；证书 SAN 里有它，mDNS 广播也指向它。 */
  address: string;
  ca: string;
  cert: string;
  key: string;
  dist: string;
  /** 沿用上次固定主机名时提示一句：origin 没变，离线包还能用。 */
  note: string;
};

/** 局域网 IPv4：优先 en0/en1，取第一个非内网回环地址。 */
export function lanAddress(interfaces = networkInterfaces()): string | null {
  const preferred = ["en0", "en1", "bridge0"];
  const entries = Object.entries(interfaces).flatMap(([name, list]) =>
    (list ?? []).filter((item) => !item.internal && item.family === "IPv4").map((item) => ({ name, address: item.address })),
  );
  const ordered = [
    ...entries.filter((entry) => preferred.includes(entry.name)),
    ...entries.filter((entry) => !preferred.includes(entry.name)),
  ];
  return ordered[0]?.address ?? null;
}

/** macOS 自己广播的 Bonjour 名（<LocalHostName>.local 在局域网里本来就能解析）。 */
export async function localHostName(): Promise<string | null> {
  try {
    const { stdout } = await openSsl("scutil", ["--get", "LocalHostName"], { timeout: 3000 });
    const name = stdout.trim();
    if (/^[A-Za-z0-9-]{1,63}$/.test(name)) return `${name}.local`;
  } catch {
    /* 不是 macOS 或 scutil 不可用：换主机名兜底 */
  }
  return null;
}

// ── 固定主机名与端口 ──────────────────────────────────────

type Pinned = { host: string; port: number };

function siteFile(state: string) {
  return join(state, "lan-site.json");
}

export async function readPinnedSite(state: string): Promise<Pinned | null> {
  try {
    const raw = JSON.parse(await readFile(siteFile(state), "utf8")) as Partial<Pinned>;
    if (typeof raw.host === "string" && !/[\r\n]/.test(raw.host) && Number.isInteger(raw.port))
      return { host: raw.host, port: Number(raw.port) };
  } catch {
    /* 没有或读不了：当没固定过 */
  }
  return null;
}

async function pinSite(state: string, site: Pinned) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(siteFile(state), JSON.stringify(site) + "\n", { mode: 0o600 });
}

// ── 本机 CA 与证书 ────────────────────────────────────────

const CA_CONFIG = `[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;

export type CertificateFiles = { ca: string; cert: string; key: string; directory: string };

/**
 * CA 只生成一次（手机装一次就够）；站点证书按主机名/IP 清单重签：
 * 家里换了局域网 IP 不用重新信任，但如果主机名变了 origin 就变了，离线包要重做。
 */
export async function ensureCertificates(
  directory: string,
  input: { host: string; names: string[]; ips: string[] },
): Promise<CertificateFiles> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ca = join(directory, "ca.pem");
  const caKey = join(directory, "ca.key.pem");
  const cert = join(directory, "site.pem");
  const key = join(directory, "site.key.pem");
  const stamp = join(directory, "site.json");
  const names = [...new Set([input.host, ...input.names, "localhost"])];
  const ips = [...new Set(input.ips)];
  if (!(await exists(ca))) {
    await writeFile(join(directory, "ca.cnf"), CA_CONFIG, { mode: 0o600 });
    await openSsl(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
        "-keyout", caKey, "-out", ca, "-subj", "/CN=ReinLab Local CA",
        "-config", join(directory, "ca.cnf"),
      ],
      { timeout: 30_000 },
    );
  }
  const wanted = JSON.stringify({ names, ips });
  const current = await readFile(stamp, "utf8").catch(() => "");
  if (current !== wanted || !(await exists(cert)) || !(await exists(key))) {
    const csr = join(directory, "site.csr");
    const ext = join(directory, "site.ext");
    await writeFile(
      ext,
      [
        "basicConstraints=CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=${[...names.map((name) => `DNS:${name}`), ...ips.map((ip) => `IP:${ip}`)].join(",")}`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    await openSsl(
      "openssl",
      ["req", "-new", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${input.host}`],
      { timeout: 30_000 },
    );
    await openSsl(
      "openssl",
      [
        "x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial",
        "-out", cert, "-days", "825", "-sha256", "-extfile", ext,
      ],
      { timeout: 30_000 },
    );
    await writeFile(stamp, wanted, { mode: 0o600 });
  }
  return { ca, cert, key, directory };
}

const exists = (file: string) => stat(file).then(() => true).catch(() => false);

// ── 构建后的前端 ─────────────────────────────────────────

/** 构建产物是否落后于源码：落后就重建（否则手机上打开的是旧页面）。 */
export async function frontendNeedsBuild(root: string): Promise<boolean> {
  const dist = join(root, "dist");
  const index = await stat(join(dist, "index.html")).catch(() => null);
  if (!index) return true;
  const newest = await newestMtime([join(root, "src"), join(root, "index.html"), join(root, "vite.config.ts")]);
  return newest > index.mtimeMs;
}

async function newestMtime(paths: string[]): Promise<number> {
  let newest = 0;
  const walk = async (target: string) => {
    const info = await stat(target).catch(() => null);
    if (!info) return;
    if (info.isDirectory()) {
      for (const name of await readdir(target)) await walk(join(target, name));
      return;
    }
    newest = Math.max(newest, info.mtimeMs);
  };
  for (const target of paths) await walk(target);
  return newest;
}

export async function buildFrontend(input: { root: string; node: string }): Promise<void> {
  const vite = join(input.root, "node_modules/vite/bin/vite.js");
  await quietCommand(
    input.node,
    ["--import", "tsx", vite, "build"],
    { cwd: input.root, env: { ...process.env, VITE_BACKEND: "live" }, timeoutMs: 600_000 },
  );
}

// ── mDNS 广播 ────────────────────────────────────────────

/**
 * 用 dns-sd 把 `reinlab.local` 指到本机局域网 IP（macOS 自带 Bonjour）。
 * 路由器的 mDNS 被挡掉时手机上解析不了，那就退回证书里也带着的局域网 IP。
 */
export function advertise(host: string, port: number, address: string): ChildProcess | null {
  if (!host.endsWith(".local")) return null;
  const label = host.slice(0, -".local".length);
  try {
    const child = execFile(
      "dns-sd",
      ["-P", label, "_https._tcp", "local", String(port), host, address],
      { timeout: 0 },
    );
    child.on("error", () => {});
    child.unref();
    return child;
  } catch {
    return null;
  }
}

// ── HTTPS 同源服务 ───────────────────────────────────────

const MIME: Record<string, string> = {
  html: "text/html; charset=UTF-8",
  js: "text/javascript; charset=UTF-8",
  mjs: "text/javascript; charset=UTF-8",
  css: "text/css; charset=UTF-8",
  json: "application/json; charset=UTF-8",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  map: "application/json; charset=UTF-8",
  txt: "text/plain; charset=UTF-8",
};

export type LanServerOptions = {
  host: string;
  port: number;
  controlPort: number;
  dist: string;
  cert: string;
  key: string;
};

export async function startLanServer(options: LanServerOptions) {
  const [cert, key] = await Promise.all([readFile(options.cert), readFile(options.key)]);
  const server = createHttpsServer({ cert, key }, (request, response) => {
    // 单个请求出错不能把整个入口带下去：按 500 回一句，服务继续跑。
    void handle(request, response, options).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=UTF-8" });
      response.end(JSON.stringify({ code: "LAN_INTERNAL_ERROR", message: "这个请求没处理完。" }));
    });
  });
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(options.port, "0.0.0.0", () => {
      server.off("error", failed);
      ready();
    });
  });
  return server;
}

async function handle(request: IncomingMessage, response: ServerResponse, options: LanServerOptions) {
  const authority = request.headers.host ?? `${options.host}:${options.port}`;
  const url = new URL(request.url ?? "/", `https://${authority}`);
  const method = request.method ?? "GET";
  if (url.pathname === "/backend" || url.pathname.startsWith("/backend/")) {
    proxy(request, response, options, url.pathname.replace(/^\/backend/, "") + url.search);
    return;
  }
  // 资源地址服务端给 /v1/...、页面补 /backend；这里也认直接 /v1，省得两套地址打架。
  if (url.pathname.startsWith("/v1/") || url.pathname === "/health") {
    proxy(request, response, options, url.pathname + url.search);
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { "content-type": "application/json; charset=UTF-8" });
    response.end(JSON.stringify({ code: "METHOD_NOT_ALLOWED", message: "这里只服务前端静态文件。" }));
    return;
  }
  await serveStatic(response, url.pathname, options.dist);
}

async function serveStatic(response: ServerResponse, pathname: string, dist: string) {
  const root = resolve(dist);
  const file = resolve(root, "." + normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(root + sep) && file !== root) {
    response.writeHead(404);
    response.end();
    return;
  }
  const info = file === root ? null : await stat(file).catch(() => null);
  if (!info || !info.isFile()) {
    // 单页应用：未知路径回 index.html；接口路径上面已经转走了。
    const index = await readFile(join(root, "index.html")).catch(() => null);
    response.writeHead(index ? 200 : 404, {
      ...(index ? { "content-type": "text/html; charset=UTF-8" } : {}),
      "cache-control": "no-store",
    });
    response.end(index ?? "");
    return;
  }
  const bytes = await readFile(file);
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  // 构建产物带内容哈希，可以长缓存；页面壳和 Service Worker 一律不缓存。
  const immutable = pathname.startsWith("/assets/");
  response.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": String(bytes.length),
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    ...(pathname === "/sw.js" ? { "service-worker-allowed": "/" } : {}),
  });
  response.end(bytes);
}

function proxy(request: IncomingMessage, response: ServerResponse, options: LanServerOptions, path: string) {
  const forwardedHost = (request.headers.host ?? "").trim();
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: options.controlPort,
      method: request.method,
      path,
      headers: {
        ...request.headers,
        host: `127.0.0.1:${options.controlPort}`,
        "x-forwarded-proto": "https",
        "x-forwarded-host": forwardedHost,
        "x-forwarded-for": request.socket.remoteAddress ?? "",
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      // SSE 与 tus 都是流式：原样转，不攒整包。
      response.socket?.setNoDelay(true);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (response.headersSent) {
      response.end();
      return;
    }
    response.writeHead(502, { "content-type": "application/json; charset=UTF-8" });
    response.end(JSON.stringify({ code: "LAN_UPSTREAM_UNAVAILABLE", message: "控制面没在跑，先起 local:up22。" }));
  });
  request.pipe(upstream);
}

// ── 一次准备：固定主机名、证书、构建后的前端 ───────────────

export async function prepareLan(input: {
  root: string;
  state: string;
  node: string;
  host?: string;
  port?: number;
}): Promise<LanSite> {
  const pinned = await readPinnedSite(input.state);
  const host = input.host ?? pinned?.host ?? LAN_DEFAULT_HOST;
  const port = input.port ?? pinned?.port ?? LAN_DEFAULT_PORT;
  const address = lanAddress();
  if (!address) throw Error("LOCAL_LAN_ADDRESS_REQUIRED");
  const note = pinned
    ? pinned.host === host && pinned.port === port
      ? `沿用 ${host}:${port}（origin 不变，已准备的离线包还能用）`
      : `origin 从 ${pinned.host}:${pinned.port} 变成 ${host}:${port}：手机上已准备的离线包会失效，需要重新准备`
    : `固定为 ${host}:${port}；以后改用 IP/端口，手机上的离线缓存会丢`;
  await pinSite(input.state, { host, port });
  const bonjour = await localHostName();
  const certificates = await ensureCertificates(join(input.state, "lan"), {
    host,
    names: bonjour ? [bonjour] : [],
    ips: [address, "127.0.0.1"],
  });
  if (await frontendNeedsBuild(input.root)) await buildFrontend({ root: input.root, node: input.node });
  return {
    host,
    port,
    address,
    ca: certificates.ca,
    cert: certificates.cert,
    key: certificates.key,
    dist: join(input.root, "dist"),
    note,
  };
}
