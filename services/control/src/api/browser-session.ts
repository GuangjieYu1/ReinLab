/**
 * 浏览器登录会话（地基第 5 项，design/prd/04-session-contract.md）。
 *
 * 浏览器只拿一个 HttpOnly Cookie `rl_session`，内容是不透明的随机标识；库里存它的
 * SHA-256，认会话时按哈希查。窗口里不再出现任何上游 token。
 *
 * 两个期限都由表里的两个时间推出来：`last_used_at` + 30 天空闲、`created_at` + 90 天
 * 绝对。只有登录、恢复会话和 touch 顺延 `last_used_at`；轮询、SSE 心跳不碰它。
 */
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import type pg from "pg";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ApiFailure } from "./errors";

export const SESSION_COOKIE = "rl_session";
/** 连续 30 天未使用就过期。 */
export const IDLE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;
/** 一次登录最长 90 天，期间怎么用都不延长。 */
export const ABSOLUTE_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;

/** 只有这三种状态：撤销优先于两个期限。 */
export type BrowserSessionState = "active" | "revoked" | "expired";

export type BrowserSessionRow = {
  account_id: string;
  display_name: string | null;
  created_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
};

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const at = (value: Date | string) => new Date(value).getTime();

/** 纯时钟判断（单测直接改时间，不用等 30/90 天）。 */
export function sessionState(row: BrowserSessionRow, now: number): BrowserSessionState {
  if (row.revoked_at) return "revoked";
  if (now - at(row.last_used_at) >= IDLE_LIMIT_MS) return "expired";
  if (now - at(row.created_at) >= ABSOLUTE_LIMIT_MS) return "expired";
  return "active";
}

/** 401 的三种 code：前端按它们区分「没登录 / 被撤销 / 已过期」。 */
export function sessionFailure(state: BrowserSessionState | "missing"): ApiFailure {
  if (state === "missing") return new ApiFailure("NO_SESSION", 401, "请先登录。");
  if (state === "revoked") return new ApiFailure("SESSION_REVOKED", 401, "这个登录已退出，请重新登录。");
  return new ApiFailure("SESSION_EXPIRED", 401, "登录已过期，请重新登录。");
}

export type SessionView = {
  accountId: string;
  displayName?: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
};

export function sessionView(row: BrowserSessionRow): SessionView {
  return {
    accountId: row.account_id,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    idleExpiresAt: new Date(at(row.last_used_at) + IDLE_LIMIT_MS).toISOString(),
    absoluteExpiresAt: new Date(at(row.created_at) + ABSOLUTE_LIMIT_MS).toISOString(),
  };
}

/** HTTPS 下加 Secure；本地开发走 http，不加（否则 Cookie 根本存不下来）。 */
export function isSecureRequest(url: string, forwardedProto?: string | null): boolean {
  if (/^https$/i.test(String(forwardedProto ?? "").split(",")[0].trim())) return true;
  return new URL(url).protocol === "https:";
}

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Strict",
    secure,
    maxAge: Math.floor(ABSOLUTE_LIMIT_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "Strict", secure });
}

export function sessionTokenOf(c: Context): string | null {
  const token = getCookie(c, SESSION_COOKIE);
  return token && token.length >= 32 && token.length <= 128 ? token : null;
}

/**
 * 会话存储：认 Cookie 时还没有账户上下文，读写都走 definer 函数
 * （见 202611010002_browser_session.sql），表本身对应用角色不开放。
 */
export class BrowserSessions {
  constructor(private readonly pool: pg.Pool) {}

  /** 登录成功后建一条会话，返回 Cookie 里要放的标识。 */
  async open(accountId: string): Promise<{ token: string; row: BrowserSessionRow }> {
    const token = randomBytes(32).toString("base64url");
    const result = await this.pool
      .query(
        "select account_id,display_name,created_at,last_used_at from reinlab_session_open($1,$2)",
        [accountId, digest(token)],
      )
      .catch((error) => {
        // 上游认证过了、但本机还没有这个账户：照实说账户未就绪，不建半条会话。
        if ((error as { code?: string })?.code === "23503")
          throw new ApiFailure("ACCOUNT_NOT_READY", 404, "账户尚未完成初始化。");
        throw error;
      });
    const row = result.rows[0] as BrowserSessionRow | undefined;
    if (!row) throw new ApiFailure("ACCOUNT_NOT_READY", 404, "账户尚未完成初始化。");
    return { token, row: { ...row, revoked_at: null } };
  }

  async read(token: string): Promise<BrowserSessionRow | null> {
    const result = await this.pool.query(
      "select account_id,display_name,created_at,last_used_at,revoked_at from reinlab_session_read($1)",
      [digest(token)],
    );
    return (result.rows[0] as BrowserSessionRow | undefined) ?? null;
  }

  /** 顺延空闲起点（只给登录、恢复会话和 touch 用）。 */
  async touch(token: string): Promise<void> {
    await this.pool.query("select reinlab_session_touch($1)", [digest(token)]);
  }

  /** 撤销：幂等，重复锁定时什么也不做，仍是 204。 */
  async revoke(token: string): Promise<void> {
    await this.pool.query("select reinlab_session_revoke($1)", [digest(token)]);
  }
}

/**
 * 业务接口的会话校验：有效会话返回账户 id；没有、被撤销、过期分别给
 * NO_SESSION / SESSION_REVOKED / SESSION_EXPIRED。这里**不**顺延空闲期限。
 */
export async function requireAccount(c: Context, sessions: BrowserSessions): Promise<string> {
  const token = sessionTokenOf(c);
  if (!token) throw sessionFailure("missing");
  const row = await sessions.read(token);
  if (!row) throw sessionFailure("missing");
  const state = sessionState(row, Date.now());
  if (state !== "active") throw sessionFailure(state);
  return row.account_id;
}

/**
 * 写操作防伪造：Origin 必须是同一个源，并带 `X-ReinLab-CSRF: 1`。
 * 只看 Origin 对 Cookie 认证不够（浏览器会替跨站表单带上 Cookie）。
 */
export function assertSameOriginWrite(c: Context): void {
  const url = new URL(c.req.url);
  const origin = c.req.header("Origin");
  if (!origin || origin !== url.origin)
    throw new ApiFailure("AUTH_ORIGIN_DENIED", 403, "请求来源无效。");
  if (c.req.header("X-ReinLab-CSRF") !== "1")
    throw new ApiFailure("CSRF_REQUIRED", 403, "缺少防伪造请求头。");
}
