import { expect, it, vi } from "vitest";

/**
 * 浏览器会话（地基第 5 项）：页面里只有 HttpOnly Cookie，任何请求都不再带
 * Authorization；写请求带防伪造头；401 按 code 退回登录。
 */
const session = (accountId: string) => ({ accountId, displayName: "synthetic", idleExpiresAt: "2026-12-01T00:00:00Z", absoluteExpiresAt: "2027-01-30T00:00:00Z" });

it("登录后业务请求只带 Cookie，不带 Authorization；写请求带防伪造头", async () => {
  vi.resetModules();
  const seen: Array<{ url: string; auth: string | null; csrf: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/auth/login")) return Response.json(session("account-a"));
    const headers = new Headers(init.headers);
    seen.push({ url, auth: headers.get("authorization"), csrf: headers.get("X-ReinLab-CSRF") });
    return Response.json({ ok: true });
  }));
  try {
    const live = await import("../../../src/data/research-live");
    await live.login("a@example.invalid", "synthetic password");
    await live.api("/v1/me");
    await live.api("/v1/dossiers", { title: "x" });
    expect(seen.map((r) => r.auth)).toEqual([null, null]);
    // 读请求不需要防伪造头；写请求必须带。
    expect(seen[0].csrf).toBeNull();
    expect(seen[1].csrf).toBe("1");
  } finally { vi.unstubAllGlobals(); }
});

it("读取 SSE 也用 Cookie：不带 Authorization，401 时清空登录态", async () => {
  vi.resetModules();
  let finish!: (r: Response) => void, streamInit: RequestInit | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/auth/login")) return Response.json(session("account-a"));
    streamInit = init;
    return new Promise<Response>((resolve) => { finish = resolve; });
  }));
  try {
    const live = await import("../../../src/data/research-live");
    await live.login("a@example.invalid", "synthetic password");
    const pending = live.readEventStream("/v1/stream?bench=research", new AbortController().signal, 0);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const headers = new Headers(streamInit!.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("Last-Event-ID")).toBe("0");
    expect(streamInit).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error" });
    finish(Response.json({ code: "SESSION_EXPIRED" }, { status: 401 }));
    await expect(pending).rejects.toThrow();
    expect(live.loggedIn()).toBe(false);
    expect(live.sessionState()).toBe("expired");
  } finally { vi.unstubAllGlobals(); }
});
