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
it('read SSE keeps authentication in headers and cancels a previous-account response',async()=>{
 vi.resetModules();let finish!:(r:Response)=>void;const cancel=vi.fn();let streamInit:RequestInit|undefined;
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{if(url.endsWith('/auth/login'))return Response.json(session('account-a','a',3600));expect(url).toBe('/backend/v1/dossiers/fixture/events?view=read&after=7');streamInit=init;return new Promise<Response>(r=>finish=r);}));
 try{const live=await import('../../../src/data/research-live');await live.login('a@example.invalid','synthetic password');const abort=new AbortController();const pending=live.readEventStream('/v1/dossiers/fixture/events?view=read&after=7',abort.signal,7);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));const headers=new Headers(streamInit!.headers);expect(headers.get('authorization')).toBe('Bearer synthetic-access-a');expect(headers.get('Last-Event-ID')).toBe('7');expect(streamInit).toMatchObject({credentials:'omit',cache:'no-store',redirect:'error'});live.logout();finish(new Response(new ReadableStream({cancel})));await expect(pending).rejects.toThrow();expect(cancel).toHaveBeenCalledTimes(1);expect(live.loggedIn()).toBe(false);}finally{vi.unstubAllGlobals();}
});
it('read SSE 401 cancels the response and clears the memory session',async()=>{
 vi.resetModules();const cancel=vi.fn();vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/auth/login')?Response.json(session('account-a','a',3600)):new Response(new ReadableStream({cancel}),{status:401})));
 try{const live=await import('../../../src/data/research-live');await live.login('a@example.invalid','synthetic password');await expect(live.readEventStream('/v1/dossiers/fixture/events?view=read',new AbortController().signal,0)).rejects.toThrow();expect(cancel).toHaveBeenCalledTimes(1);expect(live.loggedIn()).toBe(false);}finally{vi.unstubAllGlobals();}
});
