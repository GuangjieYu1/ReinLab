// 群研 live 适配器：接 /v1/swarm/*（design/prd/13-swarm-contract.md §2、§3、§7）。
// 打开 / 重连：先取快照，再从快照的 cursor 订阅事件流；断开就重取快照再订阅。
// 澄清阶段负责人说的话不在群研时间线里，取同一运行的内核事件（assistant/message）；提问卡从收件箱按 runId 取。
import type {
  ClaimDetail, EvidenceDetail, ReadLink, SwarmCardView, BusEntry, MemberLogItem, SwarmAdapter, SwarmAnswer, SwarmAsk, SwarmEvent, SwarmPlan, SwarmReport, SwarmSnapshot, DockLine,
} from '../components/workbenches/research/swarm/swarmTypes';
import { isTerminal } from '../components/workbenches/research/swarm/swarmTypes';
import { applyEvent, createHub, emptyView, mergeBus } from '../components/workbenches/research/swarm/swarmStore';
import { request } from './research-live';
import { isSwarmCard } from '../components/inbox/SwarmCard';

type Req = typeof request;
const clock = () => new Date().toISOString();

export function createLiveSwarmAdapter(dossierId: string | undefined, ports: { request: Req } = { request }): SwarmAdapter {
  const hub = createHub();
  let runId: string | null = null;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let kernelAfter = 0;
  let watchers = 0;
  let downAt: number | null = null;
  const said: DockLine[] = [];          // 本页发过的话（服务端只存包了提示词的版本，不拿来显示）
  const heard = new Map<number, DockLine>();
  const swarm = (path: string) => `/v1/swarm${path}`;

  const dockOf = () => [...said, ...heard.values()].sort((a, b) => a.at.localeCompare(b.at));
  const fail = (e: unknown) => hub.set(v => ({ ...v, error: e instanceof Error ? e.message : '请求没有完成，请稍后重试。' }));

  async function allTimeline(after: number) {
    let out: BusEntry[] = [], cursor: number | null = after;
    for (let i = 0; cursor !== null && i < 20; i++) {
      const page = await ports.request('GET', swarm(`/runs/${runId}/timeline?after=${cursor}&limit=200`)) as { entries: BusEntry[]; next: number | null };
      out = mergeBus(out, page.entries);
      cursor = page.next;
    }
    return out;
  }

  async function snapshot() {
    if (!runId) return;
    const snap = await ports.request('GET', swarm(`/runs/${runId}`)) as SwarmSnapshot;
    const before = hub.get().bus.length;
    const bus = mergeBus(hub.get().bus, await allTimeline(hub.get().bus.at(-1)?.seq ?? 0));
    const missed = downAt ? bus.length - before : 0;
    downAt = null;
    hub.set(v => ({ ...v, snap, bus, missed, error: null }));
    return snap;
  }

  function stream(after: number) {
    source?.close();
    if (!runId || isTerminal(hub.get().snap?.run)) { hub.set(v => ({ ...v, conn: 'idle' })); return; }
    const es = new EventSource(`/backend${swarm(`/runs/${runId}/stream?after=${after}`)}`, { withCredentials: true });
    source = es;
    // 代理要等第一帧（最长 15 秒心跳）才回 open：先按已连上显示，出错再改成重连中
    hub.set(v => ({ ...v, conn: 'live' }));
    es.onopen = () => hub.set(v => ({ ...v, conn: 'live' }));
    es.onmessage = (m) => {
      let frame: SwarmEvent & { done?: boolean };
      try { frame = JSON.parse(m.data); } catch { return; }
      if (frame.done) { es.close(); source = null; void snapshot().then(() => hub.set(v => ({ ...v, conn: 'idle' }))); return; }
      hub.set(v => applyEvent(v, frame));
      if (frame.type === 'run') void pollSide();
    };
    es.onerror = () => {
      es.close(); source = null;
      downAt ??= Date.now();
      hub.set(v => ({ ...v, conn: navigator.onLine ? 'reconnecting' : 'offline' }));
      if (retry) clearTimeout(retry);
      // §7：断开就重取快照，再从快照的 cursor 接着订阅（不靠事件流自己补）
      retry = setTimeout(() => { retry = null; void reconnect(); }, 2000);
    };
  }

  async function reconnect() {
    try { const snap = await snapshot(); if (snap) stream(snap.cursor); }
    catch { hub.set(v => ({ ...v, conn: 'offline' })); retry = setTimeout(() => { retry = null; void reconnect(); }, 5000); }
  }

  const textOf = (message: any): string => {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
  };

  /** 负责人的回话与提问卡（只在还没结束时轮询）。 */
  async function pollSide() {
    if (!runId) return;
    const id = runId;
    try {
      const page = await ports.request('GET', `/v1/kernel/runs/${id}/events?after=${kernelAfter}`) as { events: { seq: number; action?: string; payload?: any; at?: string }[] };
      let thinking = hub.get().thinking;
      for (const e of page.events ?? []) {
        kernelAfter = Math.max(kernelAfter, e.seq);
        if (e.action === 'turn/start') thinking = true;
        if (e.action === 'turn/end') thinking = false;
        // 开跑后同一运行的内核事件里混着队员的话、又分不出是谁说的：只取建队之前（那时只有负责人）
        const started = hub.get().snap?.run.startedAt;
        if (e.action === 'assistant/message' && (!started || !e.at || e.at < started)) {
          const text = textOf(e.payload?.message).trim();
          if (text) heard.set(e.seq, { id: 'k' + e.seq, kind: 'agent', text, at: e.at ?? clock() });
        }
      }
      const approvals = await ports.request('GET', '/v1/approvals?state=pending') as { items: any[] };
      const asks: SwarmAsk[] = (approvals.items ?? []).filter(a => a.runId === id && a.kind === 'question').map(a => ({
        id: a.id, title: String(a.title ?? ''), multi: a.question?.multi === true,
        candidates: Array.isArray(a.question?.candidates) ? a.question.candidates.map((c: any) => ({ id: String(c.id), title: String(c.title ?? c.id) })) : [],
      }));
      const cards: SwarmCardView[] = (approvals.items ?? []).filter(a => a.runId === id && isSwarmCard(String(a.kind))).map(a => ({
        id: a.id, kind: a.kind, title: String(a.title ?? ''), data: Array.isArray(a.effects) && a.effects[0] && typeof a.effects[0] === 'object' ? a.effects[0] : {},
      }));
      if (runId !== id) return;
      hub.set(v => ({ ...v, dock: dockOf(), asks, cards, thinking }));
    } catch { /* 侧边信息拿不到不影响主视图，下次再取 */ }
  }

  function watchSide() {
    if (poll) clearInterval(poll);
    poll = setInterval(() => { if (!isTerminal(hub.get().snap?.run)) void pollSide(); }, 2500);
  }

  async function attach(id: string) {
    source?.close(); source = null;
    if (runId !== id) {
      kernelAfter = 0; heard.clear();
      hub.set(v => ({ ...emptyView(), dock: said.slice(), logTick: v.logTick }));
    }
    runId = id;
    const snap = await snapshot();
    if (snap) stream(snap.cursor);
    await pollSide();
    watchSide();
  }

  async function answer(askId: string, body: SwarmAnswer) {
    await ports.request('POST', `/v1/kernel/approvals/${askId}/answer`, body);
    hub.set(v => ({ ...v, asks: v.asks.filter(a => a.id !== askId), thinking: true }));
    void pollSide();
  }

  const say = (text: string) => { said.push({ id: 'u' + said.length + Date.now(), kind: 'user', text, at: clock() }); hub.set(v => ({ ...v, dock: dockOf() })); };

  return {
    async load() {
      if (!dossierId) { hub.set(v => ({ ...v, error: null })); return; }
      const list = await ports.request('GET', swarm(`/dossiers/${dossierId}/runs`)).catch((e: any) => {
        throw Object.assign(Error(e?.message ?? '群研记录没有读到，请稍后重试。'), { code: e?.code });
      }) as { runs: { id: string }[] };
      const latest = list.runs?.[0];
      if (latest) await attach(latest.id);
    },
    subscribe(on) {
      watchers++;
      const off = hub.subscribe(on);
      // 离开群研页面（没人看）就断开事件流和轮询；再打开时 load() 重新接上
      return () => { off(); if (--watchers === 0) { source?.close(); source = null; if (poll) clearInterval(poll); poll = null; if (retry) clearTimeout(retry); retry = null; } };
    },
    async timeline(after) { return ports.request('GET', swarm(`/runs/${runId}/timeline?after=${after}&limit=200`)); },
    async memberLog(memberId, after) {
      return ports.request('GET', swarm(`/runs/${runId}/members/${encodeURIComponent(memberId)}/log?after=${after}`)) as Promise<{ items: MemberLogItem[]; next: number | null }>;
    },
    async send(text) {
      if (!dossierId) throw Error('先在左边打开或新建一个研究档案，群研跟着档案走。');
      const run = hub.get().snap?.run;
      const active = run && !isTerminal(run);
      say(text);
      try {
        // 开跑后：对话框的话给负责人（服务端按 @lead 生成 mention 干预）
        if (active && run.state !== 'clarifying' && run.state !== 'awaiting_confirm') {
          await ports.request('POST', swarm(`/runs/${runId}/posts`), { col: 'question', text: `@lead ${text}` });
          return;
        }
        // 澄清中有待答的提问：当作回答
        const ask = hub.get().asks[0];
        if (active && ask) { await answer(ask.id, { text }); return; }
        const res = await ports.request('POST', '/v1/kernel/runs', { dossierId, mode: 'swarm', query: text }) as { id: string };
        hub.set(v => ({ ...v, thinking: true }));
        await attach(res.id);
      } catch (e) { fail(e); throw e; }
    },
    answer,
    async post(text) {
      return ports.request('POST', swarm(`/runs/${runId}/posts`), { col: 'question', text });
    },
    async intervene(kind, extra = {}) {
      const body = { kind, ...(extra.text ? { text: extra.text } : {}), ...(extra.role ? { role: extra.role } : {}), ...(extra.limits ? { limits: extra.limits } : {}), ...(extra.routeId || extra.memberId ? { target: { ...(extra.routeId ? { routeId: extra.routeId } : {}), ...(extra.memberId ? { memberId: extra.memberId } : {}) } } : {}) };
      const made = await ports.request('POST', swarm(`/runs/${runId}/interventions`), body);
      hub.set(v => v.snap ? { ...v, snap: { ...v.snap, interventions: v.snap.interventions.some(x => x.id === made.id) ? v.snap.interventions : [...v.snap.interventions, made] } } : v);
      return made;
    },
    async confirmPlan(planVersion, limits) {
      try {
        const res = await ports.request('POST', swarm(`/runs/${runId}/plan/confirm`), { planVersion, ...(limits ? { limits } : {}) }) as { run: SwarmSnapshot['run'] };
        hub.set(v => v.snap ? { ...v, snap: { ...v.snap, run: res.run } } : v);
      } catch (e: any) {
        // 409 PLAN_STALE：直接用服务端给的最新计划刷新计划卡
        const plan = e?.detail?.plan as SwarmPlan | undefined;
        if (e?.code === 'PLAN_STALE' && plan) hub.set(v => v.snap ? { ...v, snap: { ...v.snap, plan } } : v);
        throw e;
      }
    },
    async decideCard(id, decision, answers) {
      await ports.request('POST', `/v1/approvals/${id}/decide`, { decision, scope: 'once', ...(answers ? { answers } : {}) });
      hub.set(v => ({ ...v, cards: v.cards.filter(c => c.id !== id) }));
      void pollSide(); void snapshot();
    },
    async report() {
      if (!runId) return null;
      return ports.request('GET', swarm(`/runs/${runId}/report`)) as Promise<SwarmReport>;
    },
    async claim(claimId, version) {
      return ports.request('GET', swarm(`/runs/${runId}/claims/${encodeURIComponent(claimId)}${version ? `?version=${version}` : ''}`)) as Promise<ClaimDetail>;
    },
    async readEvidence(claimId, evidenceId) {
      return ports.request('POST', swarm(`/runs/${runId}/claims/${encodeURIComponent(claimId)}/read`), { evidenceId }) as Promise<ReadLink>;
    },
    async evidence(evidenceId) {
      return ports.request('GET', swarm(`/runs/${runId}/evidence/${encodeURIComponent(evidenceId)}`)) as Promise<EvidenceDetail>;
    },
  };
}
