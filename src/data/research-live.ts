import type {
  BrowserSession,
  InboxApproval,
  InboxPromotion,
  PromotionDecision,
} from "../../packages/contracts/src/index";
export const liveBackend = import.meta.env.VITE_BACKEND === "live";
const listeners = new Set<() => void>();
export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const changed = () => { for (const listener of listeners) listener(); };
let session: BrowserSession | null = null,
  expiresAt = 0,
  generation = 0,
  refreshing: { generation: number; promise: Promise<void> } | undefined;
export function sessionGeneration() {
  return generation;
}
export function loggedIn() {
  return session !== null;
}
async function jsonRequest(path: string, init: RequestInit) {
  const r = await fetch("/backend" + path, {
    ...init,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!r.ok)
    throw Object.assign(Error(
      r.status === 401
        ? "登录已过期，请重新登录。"
        : "请求未完成，请刷新后重试。",
    ), { status: r.status });
  return r.json();
}
export async function login(email: string, password: string) {
  const expected = ++generation;
  session = null;
  expiresAt = 0;
  refreshing = undefined;
  intents.clear();
  changed();
  const value = (await jsonRequest("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })) as BrowserSession;
  if (expected !== generation) throw Error("会话已变化，请重试。");
  session = value;
  expiresAt = Date.now() + value.expiresIn * 1000;
  changed();
  return value.accountId;
}
export function logout() {
  generation++;
  session = null;
  expiresAt = 0;
  refreshing = undefined;
  intents.clear();
  changed();
}
async function access() {
  if (!session) throw Error("请先登录。");
  if (expiresAt - Date.now() < 60000) {
    const expected = generation,
      original = session;
    if (!refreshing || refreshing.generation !== expected) {
      const pending = { generation: expected, promise: Promise.resolve() };
      pending.promise = (async () => {
        try {
          const value = await jsonRequest("/auth/refresh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: original.refreshToken }),
          });
          if (generation !== expected || session !== original) throw Error();
          session = value;
          expiresAt = Date.now() + value.expiresIn * 1000;
        } catch {
          if (generation === expected && session === original) logout();
          throw Error("登录已过期，请重新登录。");
        } finally {
          if (refreshing === pending) refreshing = undefined;
        }
      })();
      refreshing = pending;
    }
    await refreshing.promise;
  }
  if (!session) throw Error("请先登录。");
  return session.accessToken;
}
export async function api(path: string, body?: unknown, key?: string) {
  const expected = generation,
    token = await access();
  if (expected !== generation) throw Error("会话已变化，请重试。");
  const result = await jsonRequest(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined
        ? {}
        : { "content-type": "application/json", "Idempotency-Key": key! }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (expected !== generation) throw Error("会话已变化，请重试。");
  return result;
}

export async function inbox() {
  // promotion 表随旧内核退役一起删掉了（202610280001_retire_openscience）；
  // 服务端不再有这个入口时，收件箱照常只列当前内核的审批，不因为一个 404 整块失败。
  const promotions = api("/v1/promotions?state=pending").catch((error: { status?: number }) => {
    if (error?.status === 404) return { items: [] as unknown[] };
    throw error;
  });
  const [promoted, approvals, unknown] = await Promise.all([
    promotions,
    api("/v1/approvals?state=pending"),
    api("/v1/approvals?state=indeterminate"),
  ]);
  return {
    promotions: promoted.items as InboxPromotion[],
    approvals: [...approvals.items, ...unknown.items] as InboxApproval[],
  };
}
/** Same-origin authenticated SSE; the token stays in memory and never enters a URL. */
export async function readEventStream(path: string, signal: AbortSignal, after: number) {
  const expected=generation, token=await access();
  if(expected!==generation)throw Error('会话已变化，请重试。');
  const response=await fetch('/backend'+path,{signal,headers:{authorization:'Bearer '+token,'Last-Event-ID':String(after)},credentials:'omit',cache:'no-store',redirect:'error'});
  if(expected!==generation){await response.body?.cancel();throw Error('会话已变化，请重试。');}
  if(response.status===401){await response.body?.cancel();logout();throw Error('登录已过期，请重新登录。');}
  return response;
}
// Keep one key per exact intent for the lifetime of the page, including a lost HTTP response.
const intents = new Map<string, string>();
export async function decide(
  kind: "promotion" | "approval",
  id: string,
  body:
    | PromotionDecision
    | { decision: "approve" | "reject"; scope: "once"; answers?: string[][] },
) {
  const signature = JSON.stringify([kind, id, body]);
  let key = intents.get(signature);
  if (!key) {
    key = crypto.randomUUID();
    intents.set(signature, key);
  }
  return api(
    "/v1/" +
      (kind === "promotion" ? "promotions" : "approvals") +
      "/" +
      id +
      "/decide",
    body,
    key,
  );
}
