import { it, expect, vi } from "vitest";
const session = (accountId: string, label: string, expiresIn = 1) => ({ accountId, accessToken: "synthetic-access-" + label, refreshToken: "synthetic-refresh-" + label, expiresIn });

it("logout cannot be undone by an earlier in-flight refresh", async () => {
  vi.resetModules();
  let release!: (value: Response) => void, started!: () => void;
  const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/login")) return Response.json(session("account-a", "a"));
    if (url.endsWith("/auth/refresh")) { started(); return new Promise<Response>(resolve => { release = resolve; }); }
    return Response.json({ ok: true });
  }));
  try {
    const live = await import("../../../src/data/research-live");
    await live.login("a@example.invalid", "synthetic password");
    const pending = live.api("/v1/me").catch(() => undefined);
    await refreshStarted; live.logout(); release(Response.json(session("account-a", "a-refreshed", 3600))); await pending;
    expect(live.loggedIn()).toBe(false);
  } finally { vi.unstubAllGlobals(); }
});

it.each([true,false])("an earlier account refresh outcome (%s) cannot replace or clear a subsequent login", async successful => {
  vi.resetModules();
  let release!: (value: Response) => void, started!: () => void, loginCount = 0;
  const auth: unknown[] = [], refreshStarted = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/auth/login")) return Response.json(++loginCount === 1 ? session("account-a", "a") : session("account-b", "b", 3600));
    if (url.endsWith("/auth/refresh")) { started(); return new Promise<Response>(resolve => { release = resolve; }); }
    auth.push(new Headers(init.headers).get("authorization")); return Response.json({ ok: true });
  }));
  try {
    const live = await import("../../../src/data/research-live");
    await live.login("a@example.invalid", "synthetic password");
    const pending = live.api("/v1/me").catch(() => undefined); await refreshStarted;
    await live.login("b@example.invalid", "synthetic password"); release(Response.json(session("account-a", "a-refreshed", 3600), { status: successful ? 200 : 401 })); await pending;
    await live.api("/v1/me");
    expect(auth.at(-1) === "Bearer synthetic-access-b").toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

it("same-intent idempotency survives refresh and an ambiguous HTTP response", async () => {
  vi.resetModules(); const keys: Array<string | null> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/auth/login")) return Response.json(session("account-a", "a"));
    if (url.endsWith("/auth/refresh")) return Response.json(session("account-a", "a-refreshed", 3600));
    keys.push(new Headers(init.headers).get("idempotency-key"));
    if (keys.length === 1) throw Error("SYNTHETIC_REPLY_LOST");
    return Response.json({ ok: true });
  }));
  try {
    const live = await import("../../../src/data/research-live");
    await live.login("a@example.invalid", "synthetic password");
    await live.decide("approval", "synthetic-id", { decision: "approve", scope: "once" }).catch(() => undefined);
    await live.decide("approval", "synthetic-id", { decision: "approve", scope: "once" });
    expect(keys.length === 2 && keys[0] !== null && keys[0] === keys[1]).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
