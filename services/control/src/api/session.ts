import { z } from "zod";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiEnv } from "./context";
import { ApiFailure } from "./errors";
import { LocalUsername, LocalLoginAlias } from "../local-login";
import {
  BrowserSessions,
  clearSessionCookie,
  isSecureRequest,
  sessionFailure,
  sessionState,
  sessionTokenOf,
  sessionView,
  setSessionCookie,
} from "./browser-session";

const Email = z.string().email().max(320);
const Login = z
  .object({
    email: z.union([Email, LocalUsername]),
    password: z.string().min(1).max(4096),
  })
  .strict();
const Session = z.object({
  access_token: z.string().min(16).max(16384),
  expires_in: z.number().int().positive().max(86400),
  user: z.object({ id: z.string().uuid() }),
});
export type SessionPort = {
  url: string;
  anonKey: string;
  transport?: typeof fetch;
  usernameAlias?: z.infer<typeof LocalLoginAlias>;
};

/**
 * 浏览器登录会话（design/prd/04-session-contract.md）。
 *
 * 密码仍由固定 Auth 端验证；验证通过后控制面自己建会话，浏览器只拿到一个
 * HttpOnly Cookie。上游 token 只在这一段请求里存在，不回给页面。
 */
export function registerSession(
  app: Hono<ApiEnv>,
  dependencies: {
    /** 密码校验的上游身份服务；没有配置时登录不可用，已有会话照常可恢复。 */
    identity?: SessionPort;
    sessions: BrowserSessions;
    now?: () => number;
  },
) {
  const { sessions, identity } = dependencies;
  const now = dependencies.now ?? (() => Date.now());
  const base = identity ? new URL(identity.url) : null;
  if (identity && base) {
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
  }
  const alias =
    identity?.usernameAlias && LocalLoginAlias.parse(identity.usernameAlias);
  if (alias && (base!.protocol !== "http:" || base!.hostname !== "127.0.0.1"))
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
    await next();
  });
  /** 登录、锁定、touch 会改变状态：只认同源发起的（浏览器会替跨站表单带 Cookie）。 */
  const sameOrigin = (c: any) => {
    const url = new URL(c.req.url);
    const origin = c.req.header("Origin");
    const site = c.req.header("Sec-Fetch-Site");
    if (
      !origin ||
      origin !== url.origin ||
      (c.req.header("Host") && c.req.header("Host") !== url.host) ||
      (site && site !== "same-origin")
    )
      throw new ApiFailure("AUTH_ORIGIN_DENIED", 403, "登录请求来源无效。");
  };
  /** 有效会话的那一行；没有、被撤销、过期分别给对应的 401 code。 */
  const liveRow = async (c: any) => {
    const token = sessionTokenOf(c);
    if (!token) throw sessionFailure("missing");
    const row = await sessions.read(token);
    if (!row) throw sessionFailure("missing");
    const state = sessionState(row, now());
    if (state !== "active") throw sessionFailure(state);
    return row;
  };

  app.post("/auth/login", async (c) => {
    sameOrigin(c);
    if (!/^application\/json(?:;|$)/i.test(c.req.header("Content-Type") ?? ""))
      throw new ApiFailure("AUTH_ORIGIN_DENIED", 403, "登录请求来源无效。");
    if (!identity?.anonKey || !base)
      throw new ApiFailure("LOGIN_UNAVAILABLE", 503, "登录服务尚未配置。");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiFailure("INVALID_INPUT", 400, "登录参数无效。");
    }
    const parsed = Login.safeParse(raw);
    if (!parsed.success)
      throw new ApiFailure("INVALID_INPUT", 400, "登录参数无效。");
    let accountId: string;
    try {
      const email = Email.safeParse(parsed.data.email).success
        ? parsed.data.email
        : alias?.username === parsed.data.email
          ? alias.email
          : undefined;
      if (!email) throw Error();
      const r = await (identity.transport ?? fetch)(
        new URL("/auth/v1/token?grant_type=password", base),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            apikey: identity.anonKey,
          },
          body: JSON.stringify({ email, password: parsed.data.password }),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!r.ok) {
        await r.body?.cancel();
        throw Error();
      }
      const text = await r.text();
      if (text.length > 65536) throw Error();
      const value = Session.parse(JSON.parse(text));
      // 本机用户名映射必须命中原账户，不能被上游换成别的账户。
      if (
        !Email.safeParse(parsed.data.email).success &&
        value.user.id !== alias?.accountId
      )
        throw Error();
      accountId = value.user.id;
    } catch {
      throw new ApiFailure(
        "INVALID_CREDENTIALS",
        401,
        "登录失败，请核对用户名或邮箱和密码。",
      );
    }
    // 登录本身算一次使用：会话从这一刻开始。
    const { token, row } = await sessions.open(accountId);
    setSessionCookie(
      c,
      token,
      isSecureRequest(c.req.url, c.req.header("x-forwarded-proto")),
    );
    return c.json(sessionView(row));
  });

  /** 打开页面时恢复登录；这次也算使用，会顺延空闲期限。 */
  app.get("/auth/session", async (c) => {
    const row = await liveRow(c);
    await sessions.touch(sessionTokenOf(c)!);
    return c.json(sessionView({ ...row, last_used_at: new Date(now()) }));
  });

  /** 用户真实操作时顺延空闲期限（前端最多每 10 分钟一次）。 */
  app.post("/auth/touch", async (c) => {
    sameOrigin(c);
    await liveRow(c);
    await sessions.touch(sessionTokenOf(c)!);
    return c.body(null, 204);
  });

  /** 锁定：撤销服务端会话并清 Cookie；重复调用、没有会话都仍是 204。 */
  app.post("/auth/lock", async (c) => {
    sameOrigin(c);
    const token = sessionTokenOf(c);
    if (token) await sessions.revoke(token);
    clearSessionCookie(
      c,
      isSecureRequest(c.req.url, c.req.header("x-forwarded-proto")),
    );
    return c.body(null, 204);
  });
}
