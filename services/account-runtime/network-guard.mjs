import { timingSafeEqual } from "node:crypto";
import { readAccountCredentials } from "./credentials.mjs";
const installed = new WeakSet();
const unexpected = () => Error("ACCOUNT_LISTENER_UNEXPECTED");
const serveKeys = new Set([
  "hostname",
  "port",
  "fetch",
  "idleTimeout",
  "websocket",
]);
const reloadKeys = new Set(["fetch", "websocket"]);
function checkedOptions(value, allowed, required = []) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw unexpected();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !allowed.has(key) ||
        !descriptor ||
        descriptor.get ||
        descriptor.set ||
        !descriptor.enumerable
      )
        throw unexpected();
    }
    if (required.some((key) => !Object.hasOwn(value, key))) throw unexpected();
    if (Object.hasOwn(value, "fetch") && typeof value.fetch !== "function")
      throw unexpected();
    return { ...value };
  } catch {
    throw unexpected();
  }
}

/** Deployment transport only. Never replaces App.fetch, internalFetch, SDK or upstream source. */
export function installAccountNetworkGuard(
  bun,
  { file, accountId, port = 4096, environment = process.env },
) {
  if (
    Object.keys(environment).some(
      (key) =>
        /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$|^DATABASE_URL(?:_|$)/.test(key) &&
        environment[key] !== undefined,
    )
  )
    throw Error("ACCOUNT_SECRET_ENV_FORBIDDEN");
  if (installed.has(bun) || typeof bun.serve !== "function") throw unexpected();
  const { auth } = readAccountCredentials(file, { accountId });
  const expected = Buffer.from("Bearer " + auth);
  const wrap = (dispatch) =>
    function (request, server) {
      const value = request.headers.get("authorization") ?? "";
      if (
        Buffer.byteLength(value) !== expected.length ||
        !timingSafeEqual(Buffer.from(value), expected)
      )
        return Response.json(
          { code: "ACCOUNT_AUTH_REQUIRED" },
          { status: 401, headers: { "cache-control": "no-store" } },
        );
      return Reflect.apply(dispatch, this, [request, server]);
    };
  const original = bun.serve;
  let attempted = false;
  bun.serve = function (options) {
    const checked = checkedOptions(options, serveKeys, [
      "hostname",
      "port",
      "fetch",
    ]);
    if (attempted || checked.hostname !== "127.0.0.1" || checked.port !== port)
      throw unexpected();
    attempted = true;
    // The guarded handler is supplied to the actual bind. No naked-listener/reload interval.
    const server = Reflect.apply(original, bun, [
      { ...checked, fetch: wrap(checked.fetch) },
    ]);
    if (typeof server.reload === "function") {
      const reload = server.reload;
      server.reload = function (next) {
        const checked = checkedOptions(next, reloadKeys);
        return Reflect.apply(reload, server, [
          {
            ...checked,
            ...(checked.fetch ? { fetch: wrap(checked.fetch) } : {}),
          },
        ]);
      };
    }
    return server;
  };
  installed.add(bun);
}
