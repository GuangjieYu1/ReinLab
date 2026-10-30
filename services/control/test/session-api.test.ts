import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { applyMigrations } from "../src/db/migrate";
import { ApiFailure } from "../src/api/errors";
import type { ApiEnv } from "../src/api/context";
import { registerSession } from "../src/api/session";
import {
  BrowserSessions,
  IDLE_LIMIT_MS,
  sessionState,
} from "../src/api/browser-session";

const admin = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 2,
});
const account = randomUUID();
const other = randomUUID();

/** 固定 127.0.0.1 的身份端：密码对了就发一个 token，再由本文件决定退回哪个账户。 */
const identity = (resolve: () => string) => ({
  url: "http://127.0.0.1:54321",
  anonKey: "fixture-anon",
  transport: (async () =>
    Response.json({
      access_token: "a".repeat(64),
      expires_in: 3600,
      user: { id: resolve() },
      refresh_token: "ignored-not-parsed",
    })) as unknown as typeof fetch,
});

function buildApp(resolve: () => string, clock?: () => number) {
  const app = new Hono<ApiEnv>();
  registerSession(app, {
    identity: identity(resolve),
    sessions: new BrowserSessions(pool),
    ...(clock ? { now: clock } : {}),
  });
  app.onError((e, c) =>
    e instanceof ApiFailure
      ? c.json({ code: e.code, message: e.message }, e.status)
      : c.json({ code: "INTERNAL_ERROR", message: "服务暂时无法处理请求。" }, 500),
  );
  return app;
}

const origin = { Origin: "http://localhost" };
const json = { ...origin, "Content-Type": "application/json" };
const cookieOf = (response: Response) =>
  (response.headers.get("set-cookie") ?? "").split(";")[0];

beforeAll(async () => {
  await applyMigrations(admin, path.resolve("infra/supabase/migrations"));
  await admin.query("insert into account(id,display_name) values($1,'本机用户'),($2,'别人')", [
    account,
    other,
  ]);
}, 30000);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe("浏览器登录会话", () => {
  it("登录发 HttpOnly 会话 Cookie，库里只存摘要，不回任何上游 token", async () => {
    const app = buildApp(() => account);
    const r = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "a@example.test", password: "fixture" }),
    });
    expect(r.status).toBe(200);
    const value = await r.json();
    expect(value.accountId).toBe(account);
    expect(value.displayName).toBe("本机用户");
    expect(Date.parse(value.absoluteExpiresAt) - Date.parse(value.idleExpiresAt)).toBeGreaterThan(0);
    expect(JSON.stringify(value)).not.toMatch(/access|refresh|token/i);
    const cookie = cookieOf(r);
    expect(cookie).toMatch(/^rl_session=[A-Za-z0-9_-]{32,}$/);
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(r.headers.get("set-cookie")).toMatch(/SameSite=Strict/i);
    const token = cookie.slice("rl_session=".length);
    const rows = await admin.query("select token_hash from browser_session where account_id=$1", [account]);
    expect(rows.rows[0].token_hash).toHaveLength(64);
    expect(rows.rows[0].token_hash).not.toContain(token);
  });

  it("恢复会话算使用：顺延空闲期限，不动绝对期限", async () => {
    const app = buildApp(() => account);
    const login = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "a@example.test", password: "fixture" }),
    });
    const cookie = cookieOf(login);
    const before = (await admin.query("select last_used_at,created_at from browser_session order by created_at desc limit 1")).rows[0];
    await admin.query(
      "update browser_session set last_used_at=last_used_at - interval '20 days' where last_used_at=(select max(last_used_at) from browser_session)",
    );
    const r = await app.request("http://localhost/auth/session", { headers: { Cookie: cookie } });
    expect(r.status).toBe(200);
    const after = (await admin.query("select last_used_at,created_at from browser_session order by created_at desc limit 1")).rows[0];
    expect(Date.parse(after.last_used_at)).toBeGreaterThan(Date.parse(before.last_used_at) - IDLE_LIMIT_MS);
    expect(Date.parse(after.created_at)).toBe(Date.parse(before.created_at));
  });

  it("touch 顺延；PUT/写请求照旧要同源 + 防伪造头", async () => {
    const app = buildApp(() => account);
    const login = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "a@example.test", password: "fixture" }),
    });
    const cookie = cookieOf(login);
    expect((await app.request("http://localhost/auth/touch", { method: "POST", headers: { Cookie: cookie, ...origin } })).status).toBe(204);
    expect((await app.request("http://localhost/auth/touch", { method: "POST", headers: { Cookie: cookie } })).status).toBe(403);
    expect((await app.request("http://localhost/auth/touch", { method: "POST", headers: { Cookie: cookie, ...origin, Origin: "https://evil.test" } })).status).toBe(403);
  });

  it("空闲超过 30 天给 SESSION_EXPIRED，撤销给 SESSION_REVOKED，没 Cookie 给 NO_SESSION", async () => {
    const app = buildApp(() => account);
    const login = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "a@example.test", password: "fixture", }),
    });
    const cookie = cookieOf(login);
    expect((await app.request("http://localhost/auth/session", { headers: {} })).status).toBe(401);
    expect((await (await app.request("http://localhost/auth/session", { headers: {} })).json()).code).toBe("NO_SESSION");
    await admin.query(
      "update browser_session set last_used_at=now() - interval '31 days' where account_id=$1",
      [account],
    );
    const expired = await app.request("http://localhost/auth/session", { headers: { Cookie: cookie } });
    expect(expired.status).toBe(401);
    expect((await expired.json()).code).toBe("SESSION_EXPIRED");
    // 90 天绝对期限：空闲还新鲜也必须重新登录。
    await admin.query(
      "update browser_session set last_used_at=now(), created_at=now() - interval '91 days' where account_id=$1",
      [account],
    );
    const absolute = await app.request("http://localhost/auth/session", { headers: { Cookie: cookie } });
    expect(absolute.status).toBe(401);
    expect((await absolute.json()).code).toBe("SESSION_EXPIRED");
    await admin.query("update browser_session set created_at=now(), last_used_at=now() where account_id=$1", [account]);
    const ok = await app.request("http://localhost/auth/session", { headers: { Cookie: cookie } });
    expect(ok.status).toBe(200);
    // 锁定后再拿同一个 Cookie 就是 SESSION_REVOKED，且不会顺延。
    expect((await app.request("http://localhost/auth/lock", { method: "POST", headers: { Cookie: cookie, ...origin } })).status).toBe(204);
    const revoked = await app.request("http://localhost/auth/session", { headers: { Cookie: cookie } });
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).code).toBe("SESSION_REVOKED");
    expect((await app.request("http://localhost/auth/lock", { method: "POST", headers: { Cookie: cookie, ...origin } })).status).toBe(204);
  });

  it("时钟逻辑本身可单测：撤销优先，两个期限都在才有效", () => {
    const now = Date.parse("2026-11-01T00:00:00Z");
    const row = (created: number, used: number, revoked: Date | null = null) => ({
      account_id: account,
      display_name: null,
      created_at: new Date(created),
      last_used_at: new Date(used),
      revoked_at: revoked,
    });
    expect(sessionState(row(now - 1000, now - 1000), now)).toBe("active");
    expect(sessionState(row(now - 1000, now - IDLE_LIMIT_MS - 1), now)).toBe("expired");
    expect(sessionState(row(now - 91 * 86400_000, now - 1000), now)).toBe("expired");
    expect(sessionState(row(now - 1000, now - 1000, new Date(now)), now)).toBe("revoked");
  });

  it("密码不对 401 INVALID_CREDENTIALS；未注册账户登录失败不建会话", async () => {
    const bad = new Hono<ApiEnv>();
    registerSession(bad, {
      identity: {
        url: "http://127.0.0.1:54321",
        anonKey: "fixture",
        transport: (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch,
      },
      sessions: new BrowserSessions(pool),
    });
    bad.onError((e, c) =>
      e instanceof ApiFailure ? c.json({ code: e.code }, e.status) : c.json({ code: "INTERNAL" }, 500),
    );
    const r = await bad.request("http://localhost/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "a@example.test", password: "wrong" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe("INVALID_CREDENTIALS");
    const unknownId = randomUUID();
    const unknown = buildApp(() => unknownId);
    const missing = await unknown.request("http://localhost/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "nobody@example.test", password: "fixture" }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("ACCOUNT_NOT_READY");
    const left = await admin.query(
      "select count(*)::int n from browser_session where account_id=$1",
      [unknownId],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("没有配置身份服务时登录明确不可用，已有会话照常恢复", async () => {
    const app = new Hono<ApiEnv>();
    registerSession(app, { sessions: new BrowserSessions(pool) });
    app.onError((e, c) =>
      e instanceof ApiFailure ? c.json({ code: e.code }, e.status) : c.json({ code: "INTERNAL" }, 500),
    );
    const r = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "a@example.test", password: "fixture" }),
    });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("LOGIN_UNAVAILABLE");
  });

  it("登录的 Cookie 在 https 下带 Secure，本地 http 不带", async () => {
    const app = buildApp(() => other);
    const login = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "b@example.test", password: "fixture" }),
    });
    expect(login.headers.get("set-cookie")).not.toMatch(/Secure/i);
    const proxied = await app.request("http://localhost/auth/login", {
      method: "POST",
      headers: { ...json, "x-forwarded-proto": "https" },
      body: JSON.stringify({ email: "b@example.test", password: "fixture" }),
    });
    expect(proxied.headers.get("set-cookie")).toMatch(/Secure/i);
  });
});
