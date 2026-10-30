import type {
  InboxApproval,
  InboxPromotion,
  PromotionDecision,
} from "../../packages/contracts/src/index";
export const liveBackend = import.meta.env.VITE_BACKEND === "live";

// 登录会话（地基第 5 项，design/prd/04-session-contract.md）：浏览器只靠 HttpOnly Cookie，
// 页面里不再拿任何 token。这里只记「现在是什么状态、是哪个账户」。
export type SessionState = "restoring" | "active" | "signedOut" | "expired" | "offline";
type Account = { accountId: string; displayName?: string };
const listeners = new Set<() => void>();
export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const changed = () => { for (const listener of listeners) listener(); };
let state: SessionState = liveBackend ? "restoring" : "signedOut",
  account: Account | null = null,
  generation = 0,
  // 断网时点了锁定：页面已经退出，服务端撤销还没成功，联网后补上
  lockPending = false;
export function sessionGeneration() {
  return generation;
}
export function sessionState() {
  return state;
}
export function lockIsPending() {
  return lockPending;
}
export function loggedIn() {
  return state === "active";
}
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("reinlab-session");

/** 401 带的 code → 前端状态。 */
const stateOf = (code?: string): SessionState => (code === "SESSION_EXPIRED" ? "expired" : "signedOut");
function become(next: SessionState, who: Account | null = null) {
  if ((account?.accountId ?? null) !== (who?.accountId ?? null)) generation++;
  account = who;
  state = next;
  if (next !== "active") intents.clear();
  changed();
}
const write = { "content-type": "application/json", "X-ReinLab-CSRF": "1" };
async function authFetch(path: string, init: RequestInit = {}) {
  return fetch("/backend" + path, { ...init, cache: "no-store", credentials: "same-origin", redirect: "error" });
}

/** 打开页面时恢复登录：Cookie 还有效就直接是已登录，不闪登录页；断网 / 5xx 是连接问题，不当成退出。 */
export async function restoreSession() {
  if (!liveBackend) return;
  if (state !== "restoring" && state !== "offline") return;
  try {
    const r = await authFetch("/auth/session");
    if (r.ok) { become("active", (await r.json()) as Account); lastTouch = Date.now(); return; }
    if (r.status === 401) { const v = await r.json().catch(() => null); become(stateOf(v?.code)); return; }
    become("offline");
  } catch {
    become("offline");
  }
}

export async function login(email: string, password: string) {
  const r = await authFetch("/auth/login", { method: "POST", headers: write, body: JSON.stringify({ email, password }) }).catch(() => null);
  if (!r) throw Error("连不上服务，请检查本地服务是否在运行。");
  const value = await r.json().catch(() => null);
  if (!r.ok) throw Error(r.status === 401 ? "账号或密码不对。" : value?.message ?? "登录没有完成，请稍后重试。");
  lockPending = false;
  become("active", value as Account);
  lastTouch = Date.now();
  channel?.postMessage({ type: "login" });
  return (value as Account).accountId;
}

/** 本页退出（收到 401 时）：只清本页，不调服务端。 */
export function logout(next: SessionState = "signedOut") {
  become(next);
}

/** 锁定：先清本页并通知其他标签，再撤销服务端会话；断网就挂着，联网后补上。 */
export function lock() {
  become("signedOut");
  channel?.postMessage({ type: "locked" });
  lockPending = true;
  changed();
  void finishLock();
}
async function finishLock() {
  if (!lockPending) return;
  try {
    const r = await authFetch("/auth/lock", { method: "POST", headers: write });
    if (r.ok || r.status === 401) { lockPending = false; changed(); }
  } catch {
    /* 断网：等 online 再试 */
  }
}
if (liveBackend && typeof window !== "undefined") {
  window.addEventListener("online", () => { void finishLock(); if (state === "offline") void restoreSession(); });
  channel?.addEventListener("message", (e: MessageEvent) => {
    if (e.data?.type === "locked" && state !== "signedOut") become("signedOut");
    if (e.data?.type === "login" && state !== "active") { state = "restoring"; void restoreSession(); }
  });
}

// 「使用」只算人真的在操作：点击、输入。轮询和事件流不算，不能把 30 天空闲期限永远续下去。
let lastTouch = 0;
const TOUCH_EVERY = 10 * 60 * 1000;
if (liveBackend && typeof window !== "undefined") {
  const touch = () => {
    if (state !== "active" || Date.now() - lastTouch < TOUCH_EVERY) return;
    lastTouch = Date.now();
    void authFetch("/auth/touch", { method: "POST", headers: write })
      .then(async (r) => { if (r.status === 401) { const v = await r.json().catch(() => null); become(stateOf(v?.code)); } })
      .catch(() => {});
  };
  window.addEventListener("pointerdown", touch, { capture: true, passive: true });
  window.addEventListener("keydown", touch, { capture: true, passive: true });
}

/** 业务请求统一出口：带 Cookie；写操作带防伪造头。401 按 code 退到登录（过期 / 已退出）。 */
async function send(method: string, path: string, body?: unknown, key?: string) {
  if (state !== "active") throw Error("请先登录。");
  const expected = generation;
  const r = await authFetch(path, {
    method,
    headers: method === "GET" ? {} : { ...write, "Idempotency-Key": key ?? crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (expected !== generation) throw Error("会话已变化，请重试。");
  if (r.status === 401) {
    const v = await r.json().catch(() => null);
    become(stateOf(v?.code));
    throw Object.assign(Error("登录已过期，请重新登录。"), { status: 401, code: v?.code ?? "HTTP_401" });
  }
  return r;
}

export async function api(path: string, body?: unknown, key?: string) {
  const r = await send(body === undefined ? "GET" : "POST", path, body, key);
  if (!r.ok) throw Object.assign(Error("请求未完成，请刷新后重试。"), { status: r.status });
  return r.json();
}

/** 带方法与错误码的请求：服务端错误统一是 { code, message }（design/prd/03-dossier-contract.md 第 5 节），原样带回给界面。 */
export async function request(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) {
  const r = await send(method, path, body);
  if (r.status === 204) return null;
  const value = await r.json().catch(() => null);
  if (!r.ok)
    throw Object.assign(Error(value?.message ?? "请求未完成，请稍后重试。"), { status: r.status, code: value?.code ?? "HTTP_" + r.status, detail: value });
  return value;
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
/** 同源事件流：认 Cookie，凭据不进 URL。 */
export async function readEventStream(path: string, signal: AbortSignal, after: number) {
  if (state !== "active") throw Error("请先登录。");
  const expected = generation;
  const response = await authFetch(path, { signal, headers: { "Last-Event-ID": String(after) } });
  if (expected !== generation) { await response.body?.cancel(); throw Error("会话已变化，请重试。"); }
  if (response.status === 401) {
    const v = await response.json().catch(() => null);
    become(stateOf(v?.code));
    throw Error("登录已过期，请重新登录。");
  }
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
