// 探索台 live 适配器：控制面 /v1/explore/*（design/prd/07-explore-contract.md）。
import type { Op, PendingChange, Profile, RefImage, Viewport, Basemap } from '../../packages/contracts/src/explore';
import { ExploreError, type ChatItem, type ExploreAdapter, type ExploreEvent, type ExploreSnapshot } from '../components/workbenches/explore/live/adapter';
import { api, decide, readEventStream, request, upload } from './research-live';

const enc = encodeURIComponent;
/** 服务端给的资源地址是 /v1/...，页面要经同源前缀 /backend 访问。 */
const viaBackend = (src: string) => (src.startsWith('/v1/') ? '/backend' + src : src);
const fixRef = (r: RefImage): RefImage => (r.image ? { ...r, image: { ...r.image, src: viaBackend(r.image.src) } } : r);
const CHANGE_PREFIX = '档案变动：';

/** 服务端错误 → ExploreError，保留 code 给页面分支用。 */
async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  try { return await request(method, path, body) as T; }
  catch (e) { const x = e as { message?: string; code?: string; detail?: unknown }; throw new ExploreError(x.message ?? '没有成功', x.code ?? 'UNKNOWN', x.detail); }
}

type KernelEvent = { seq: number; action: string; payload: Record<string, any> };
const textOf = (m: any): string => Array.isArray(m?.content) ? m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('') : typeof m?.content === 'string' ? m.content : '';
const HIDDEN = new Set(['step/start', 'step/end', 'turn/start', 'turn/end', 'request/header', 'request/context', 'system/message', 'session/title', 'session-log-deepseek/delivery-accepted', 'agent/inbox/spliced', 'llm/retry', 'llm/retry-started', 'assistant/attempt', 'job/registered', 'job/settled']);

/** 内核事件 → 对话条目。工具结果里带 stopIds / pending / refIds 的，渲染成对应的卡。 */
export function mapExploreEvent(e: KernelEvent): ChatItem[] {
  const d = e.payload ?? {};
  if (HIDDEN.has(e.action)) return [];
  switch (e.action) {
    case 'user/message': {
      if (d.source?.kind === 'runtime-context') return [];
      const t = textOf(d) || textOf(d.message);
      if (!t) return [];
      if (t.startsWith(CHANGE_PREFIX)) return [{ id: `n${e.seq}`, kind: 'note', text: t.slice(CHANGE_PREFIX.length).trim() }];
      return [{ id: String(d.id ?? `u${e.seq}`), kind: 'user', text: t }];
    }
    case 'assistant/message': { const t = textOf(d.message); return t ? [{ id: String(d.message?.id ?? `a${e.seq}`), kind: 'agent', text: t }] : []; }
    case 'tool/call': { const n = String(d.name ?? ''); return [{ id: String(d.callId ?? `t${e.seq}`), kind: 'tool', name: n, label: TOOL_LABEL[n] ?? n, state: 'running' }]; }
    case 'tool/result': {
      const id = String(d.message?.toolCallId ?? d.message?.source?.callId ?? d.callId ?? `t${e.seq}`);
      let r: any = null; try { r = JSON.parse(textOf(d.message)); } catch { /* 不是 JSON 就只更新状态 */ }
      const failed = !!d.error || !!d.message?.isError || !!r?.error;
      const out: ChatItem[] = [{ id, kind: 'tool', name: '', label: '', state: failed ? 'failed' : 'done' }];
      if (Array.isArray(r?.stopIds) && r.stopIds.length) out.push({ id: `${id}:s`, kind: 'stops', stopIds: r.stopIds.map(String) });
      if (r?.pending?.approvalId) out.push({ id: `${id}:p`, kind: 'pending', change: r.pending as PendingChange });
      if (Array.isArray(r?.refIds) && r.refIds.length) out.push({ id: `${id}:r`, kind: 'refs', refIds: r.refIds.map(String) });
      return out;
    }
    case 'run/malformed-tool-json': return [{ id: `m${e.seq}`, kind: 'malformed' }];
    default: return [];
  }
}
// 只是给人看的短名；没列到的照原名显示
const TOOL_LABEL: Record<string, string> = {
  web_search: '搜索', web_fetch: '读网页', bash: 'bash',
};

export function createLiveExploreAdapter(dossierId: string): ExploreAdapter {
  const base = `/v1/explore/plans/${enc(dossierId)}`;
  let viewTimer: number | undefined;
  return {
    kind: 'live',
    async load() { const s = await call<ExploreSnapshot>('GET', base); return { ...s, refs: s.refs.map(fixRef) }; },
    async ops(baseRevision: number, ops: Op[]) {
      return call('POST', `${base}/ops`, { baseRevision, ops });
    },
    saveView(viewport: Viewport, basemap: Basemap) {
      // 视野只记最后一次，拖动时不必每帧都存
      window.clearTimeout(viewTimer);
      viewTimer = window.setTimeout(() => { void call('POST', `${base}/ops`, { baseRevision: -1, ops: [{ op: 'view.save', viewport, basemap }] }).catch(() => {}); }, 1500);
    },
    weather: stopId => call('GET', `${base}/weather${stopId ? `?stopId=${enc(stopId)}` : ''}`),
    suggestions: async () => (await call<{ items: never[] }>('GET', `${base}/suggestions`)).items,
    usage: () => call('GET', `${base}/usage`),
    places: async (q, near) => (await call<{ items: never[] }>('GET', `/v1/explore/places?q=${enc(q)}${near ? `&near=${near[0]},${near[1]}` : ''}`)).items,
    mapConfig: () => call('GET', '/v1/explore/map-config'),
    profiles: async () => (await call<{ items: Profile[] }>('GET', '/v1/profiles')).items,
    saveProfile: p => p.id ? call('PATCH', `/v1/profiles/${enc(p.id)}`, { ...p, baseRevision: p.revision }) : call('POST', '/v1/profiles', p),
    async deleteProfile(id) { await call('DELETE', `/v1/profiles/${enc(id)}`); },
    async uploadRef(file, kind) {
      const f = new FormData(); f.append('file', file); f.append('kind', kind);
      return fixRef(await upload(`${base}/refs`, f) as RefImage);
    },
    async removeRef(id) { await call('DELETE', `${base}/refs/${enc(id)}`); },
    async uploadSnapshot(key, revision, png, attribution) {
      const f = new FormData(); f.append('file', png, `${key}.png`); f.append('key', key); f.append('revision', String(revision)); f.append('basemap', 'vector'); f.append('attribution', attribution);
      await upload(`${base}/snapshots`, f);
    },
    book: (variant, revision) => call('POST', `${base}/books`, { variant, revision }),
    timezone: async () => (await call<{ timezone: string | null }>('GET', '/v1/account/settings')).timezone,
    async setTimezone(tz) { await call('PUT', '/v1/account/settings', { timezone: tz }); },
    async decide(approvalId, approve) { await decide('approval', approvalId, { decision: approve ? 'approve' : 'reject', scope: 'once' }); },
    subscribe(on) {
      // 共用 /v1/stream；只收这份档案的探索事件。断线 3 秒重连，期间漏的由页面按修订号重取兜底。
      const ctl = new AbortController();
      let stopped = false;
      (async () => {
        while (!stopped) {
          try {
            const res = await readEventStream('/v1/stream?bench=exploration', ctl.signal, 0);
            const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += value;
              let i;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, i); buf = buf.slice(i + 2);
                const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
                if (!data) continue;
                try {
                  const ev = JSON.parse(data) as ExploreEvent;
                  if (typeof ev.type === 'string' && ev.type.startsWith('explore.') && ev.dossierId === dossierId) on(ev);
                } catch { /* 坏的一条跳过 */ }
              }
            }
          } catch { /* 断线：稍后重连 */ }
          if (!stopped) await new Promise(r => setTimeout(r, 3000));
        }
      })();
      return () => { stopped = true; ctl.abort(); };
    },
    chat(on) {
      let items: ChatItem[] = [];
      let stopped = false;
      const push = (xs: ChatItem[]) => {
        for (const x of xs) {
          const i = items.findIndex(y => y.id === x.id);
          if (i < 0) items = [...items, x];
          else if (x.kind === 'tool' && items[i].kind === 'tool') items = items.map((y, k) => k === i ? { ...y, state: x.state } as ChatItem : y);
        }
      };
      /**
       * 订阅这一轮的事件流（SSE），代替 1 秒轮询。
       * 服务端会把每一步事件（含 step/start 这类活性事件）与状态帧推过来；
       * 断线后按 last seq 重连，漏的会在重连时补齐。
       */
      // 当前打开的事件流：stop() 要真正断开它。运行停在「等你回答」时服务端不会收尾，
      // 只置 stopped 不断开，每次切页面都会留下一条长连接，攒满浏览器同站 6 条上限后整页卡住。
      let active: AbortController | null = null;
      async function follow(runId: string) {
        let after = 0;
        active?.abort();
        const ctl = new AbortController();
        active = ctl;
        const stopIt = () => ctl.abort();
        try {
          while (!stopped) {
            let response: Response;
            try {
              response = await readEventStream(`/v1/kernel/runs/${runId}/stream?after=${after}`, ctl.signal, after);
            } catch (e) {
              if (stopped) return;
              // 断线要说出来（以前 load 静默吞掉，看起来像"没反应"）。
              push([{ id: "err:follow", kind: "note", text: `连接断了：${e instanceof Error ? e.message : '未知原因'}，正在重试…` }]);
              on(items, true);
              await new Promise(r => setTimeout(r, 1500));
              continue;
            }
            items = items.filter(x => x.id !== "err:follow");
            const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read().catch(() => ({ value: '', done: true }));
              if (done) break;
              buf += value;
              let cut: number;
              while ((cut = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
                const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
                if (!data) continue;
                let frame: { seq?: number; action?: string; payload?: Record<string, unknown>; state?: string; done?: boolean };
                try { frame = JSON.parse(data); } catch { continue; }
                if (typeof frame.seq === 'number') {
                  after = Math.max(after, frame.seq);
                  push(mapExploreEvent({ seq: frame.seq, action: String(frame.action ?? ''), payload: frame.payload ?? {} }));
                }
                if (frame.state) on(items, !['completed', 'failed', 'cancelled', 'interrupted'].includes(frame.state));
                if (frame.done) { stopped = true; return; }
              }
            }
            if (stopped) return;
            // 服务端主动收尾（超时/重启）：稍后按 last seq 重连一次，页面看得到断点也会自愈。
            await new Promise(r => setTimeout(r, 800));
          }
        } finally {
          stopIt();
        }
      }

      return {
        async load() {
          stopped = false;
          try {
            const { runs = [] } = await api(`/v1/kernel/dossiers/${enc(dossierId)}/runs`) as { runs?: { id: string; mode?: string }[] };
            const last = runs.find(r => r.mode === 'explore');
            if (last) await follow(last.id);
            else on(items, false);
          } catch (e) {
            // 读历史失败要看得见，不要静默成"空对话"。
            push([{ id: "err:load", kind: "note", text: `读对话历史失败：${e instanceof Error ? e.message : '未知原因'}` }]);
            on(items, false);
          }
        },
        async send(text, refIds) {
          stopped = false;
          push([{ id: `local-${Date.now()}`, kind: 'user', text }]); on(items, true);
          const run = await api('/v1/kernel/runs', { dossierId, query: text, mode: 'explore', ...(refIds?.length ? { refIds } : {}) }, crypto.randomUUID()) as { id: string };
          items = items.filter(x => !x.id.startsWith('local-'));
          await follow(run.id);
        },
        stop() { stopped = true; active?.abort(); active = null; },
      };
    },
  };
}
