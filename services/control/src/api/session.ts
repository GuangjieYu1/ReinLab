import { z } from "zod";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiEnv } from "./context";
import { ApiFailure } from "./errors";
import { LocalUsername, LocalLoginAlias } from "../local-login";
const Email = z.string().email().max(320);
const Login = z
  .object({
    email: z.union([Email, LocalUsername]),
    password: z.string().min(1).max(4096),
  })
  .strict();
const Refresh = z
  .object({
    refreshToken: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[!-~]+$/),
  })
  .strict();
const Session = z.object({
  access_token: z.string().min(16).max(16384),
  refresh_token: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[!-~]+$/),
  expires_in: z.number().int().positive().max(86400),
  user: z.object({ id: z.string().uuid() }),
});
export type SessionPort = {
  url: string;
  anonKey: string;
  transport?: typeof fetch;
  usernameAlias?: z.infer<typeof LocalLoginAlias>;
};
/** Same-origin browser login proxy. Credentials remain in request/process memory. No cookies or token storage. */
export function registerSession(app: Hono<ApiEnv>, config: SessionPort) {
  const base = new URL(config.url);
  if (
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && base.hostname === "127.0.0.1")) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw Error("SESSION_CONFIG_INVALID");
  const alias = config.usernameAlias && LocalLoginAlias.parse(config.usernameAlias);
  if (alias && (base.protocol !== 'http:' || base.hostname !== '127.0.0.1'))
    throw Error("SESSION_CONFIG_INVALID");
  app.use(
    "/auth/*",
    bodyLimit({
      maxSize: 24576,
      onError: (c) =>
        c.json({ code: "PAYLOAD_TOO_LARGE", message: "请求内容过大。" }, 413),
    }),
  );
  app.use("/auth/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const origin = c.req.header("Origin"),
      site = c.req.header("Sec-Fetch-Site"),
      url = new URL(c.req.url);
    if (
      !origin ||
      origin !== url.origin ||
      (c.req.header("Host") && c.req.header("Host") !== url.host) ||
      (site && site !== "same-origin") ||
      !/^application\/json(?:;|$)/i.test(c.req.header("Content-Type") ?? "")
    )
      throw new ApiFailure("AUTH_ORIGIN_DENIED", 403, "登录请求来源无效。");
    await next();
  });
  for (const action of ["login", "refresh"] as const)
    app.post("/auth/" + action, async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new ApiFailure("INVALID_INPUT", 400, "登录参数无效。");
      }
      const parsed = (action === "login" ? Login : Refresh).safeParse(raw);
      if (!parsed.success)
        throw new ApiFailure("INVALID_INPUT", 400, "登录参数无效。");
      try {
        const data = parsed.data;
        let body: { email: string; password: string } | { refresh_token: string };
        if ("email" in data) {
          const email = Email.safeParse(data.email).success ? data.email
            : alias?.username === data.email ? alias.email : undefined;
          if (!email) throw Error();
          body = { email, password: data.password };
        } else body = { refresh_token: data.refreshToken };
        const r = await (config.transport ?? fetch)(
          new URL(
            "/auth/v1/token?grant_type=" +
              (action === "login" ? "password" : "refresh_token"),
            base,
          ),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              apikey: config.anonKey,
            },
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!r.ok) {
          await r.body?.cancel();
          throw Error();
        }
        const length = Number(r.headers.get("Content-Length") ?? 0);
        if (length > 65536) {
          await r.body?.cancel();
          throw Error();
        }
        const text = await r.text();
        if (text.length > 65536) throw Error();
        const value = Session.parse(JSON.parse(text));
        if ("email" in data && !Email.safeParse(data.email).success && value.user.id !== alias?.accountId)
          throw Error();
        return c.json({
          accessToken: value.access_token,
          refreshToken: value.refresh_token,
          expiresIn: value.expires_in,
          accountId: value.user.id,
        });
      } catch {
        throw new ApiFailure(
          "LOGIN_FAILED",
          401,
          "登录失败或会话已过期，请核对用户名或邮箱和密码。",
        );
      }
    });
}
