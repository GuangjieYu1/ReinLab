// 探索台 live 适配器：控制面 /v1/explore/*（design/prd/07-explore-contract.md）。
import type { Op, PendingChange, Profile, RefImage, Viewport, Basemap } from '../../packages/contracts/src/explore';
import { ExploreError, type ChatItem, type ExploreAdapter, type ExploreEvent, type ExploreSnapshot } from '../components/workbenches/explore/live/adapter';
import { api, decide, readEventStream, request, upload } from './research-live';
import * as tus from 'tus-js-client';
import type { Photo } from '../../packages/contracts/src/explore';
import type { ReviewApi } from '../components/workbenches/explore/live/adapter';

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
      if (r?.pending?.approvalId) out.push(r.pending.kind === 'experience'
        ? { id: `${id}:p`, kind: 'experience', proposal: r.pending }
        : { id: `${id}:p`, kind: 'pending', change: r.pending as PendingChange });
      if (Array.isArray(r?.photoIds) && r.photoIds.length) out.push({ id: `${id}:ph`, kind: 'photos', photoIds: r.photoIds.map(String) });
      if (r?.comparison === true) out.push({ id: `${id}:c`, kind: 'review', part: 'comparison' });
      if (typeof r?.travelogueId === 'string') out.push({ id: `${id}:tl`, kind: 'review', part: 'travelogue' });
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

const fixPhoto = (p: Photo): Photo => ({ ...p, thumb: viaBackend(p.thumb), preview: viaBackend(p.preview) });

/** 回顾：照片 / 对时 / 实际 / 游记（10-explore-v2-contract.md 第 2.3–2.5 节）。 */
function liveReview(base: string): ReviewApi {
  return {
    createBatch: files => call('POST', `${base}/photo-batches`, { files }),
    batch: async id => { const r = await call<any>('GET', `${base}/photo-batches/${enc(id)}`); return r.batch ?? r; },   // 包不包 {batch} 都接
    upload(file, batchId, uploadUrl, on) {
      const up = new tus.Upload(file, {
        endpoint: viaBackend(uploadUrl), chunkSize: 8 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000],
        headers: { 'X-ReinLab-CSRF': '1' },
        metadata: { batchId, filename: file.name, lastModified: String(file.lastModified) },
        fingerprint: async f => ['reinlab-photo', batchId, (f as File).name, f.size, (f as File).lastModified].join(':'),
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => on.progress(sent, total),
        onSuccess: () => on.done(),
        onError: e => on.error(e.message.split('\n')[0]),
      });
      return {
        start() { up.findPreviousUploads().then(prev => { if (prev.length) up.resumeFromPreviousUpload(prev[0]); up.start(); }, () => up.start()); },
        pause() { void up.abort(); },
        abort() { void up.abort(true); },
      };
    },
    async photos(q = {}) {
      const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
      const r = await call<{ items: Photo[]; cursor: string | null }>('GET', `${base}/photos${qs ? '?' + qs : ''}`);
      return { items: r.items.map(fixPhoto), cursor: r.cursor };
    },
    async assign(photoIds, stopId) { await call('POST', `${base}/photos/assign`, { photoIds, stopId, basis: 'manual' }); },
    async pick(photoIds, picked) { await call('POST', `${base}/photos/pick`, { photoIds, picked }); },
    async remove(id) { await call('DELETE', `${base}/photos/${enc(id)}`); },
    storage: () => call('GET', `${base}/storage`),
    clock: async () => (await call<{ groups: never[] }>('GET', `${base}/clock`)).groups,
    async anchor(g, a) { await call('POST', `${base}/clock/${enc(g)}/anchor`, a); },
    async confirmClock(g, timezone, offsetSec) { await call('POST', `${base}/clock/${enc(g)}/confirm`, { timezone, offsetSec }); },
    async split(g, beforePhotoId) { await call('POST', `${base}/clock/${enc(g)}/split`, { beforePhotoId }); },
    actual: async rev => (await call<{ items: never[] }>('GET', `${base}/actual${rev ? `?revision=${rev}` : ''}`)).items,
    get: () => call('GET', `${base}/review`),
    saveTravelogue: (baseRevision, markdown) => call('PUT', `${base}/review/travelogue`, { baseRevision, markdown }),
    exportUrl: f => viaBackend(`${base}/review/travelogue/export?format=${f}`),
    media: viaBackend,
    cropUrl: (pid, r) => viaBackend(`${base}/photos/${enc(pid)}/crop?x=${r.x.toFixed(4)}&y=${r.y.toFixed(4)}&w=${r.w.toFixed(4)}&h=${r.h.toFixed(4)}`),
  };
}

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
    // PATCH 不收 type（类型不能改）；id / revision 走路径和 baseRevision
    saveProfile: p => { if (!p.id) return call('POST', '/v1/profiles', p); const { id, revision, type: _t, ...rest } = p as typeof p & { type: string }; return call('PATCH', `/v1/profiles/${enc(id!)}`, { ...rest, baseRevision: revision }); },
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
    offlinePack: (day, detail) => call('POST', `${base}/offline-packs`, { day, ...(detail ? { detail } : {}) }).then((r: any) => r.pack),
    getOfflinePack: packId => call('GET', `${base}/offline-packs/${enc(packId)}`),
    postFieldEvents: events => call('POST', `${base}/field-events`, { events }),
    fieldEvents: async () => (await call<{ items: never[] }>('GET', `${base}/field-events`)).items,
    revision: rev => call('GET', `${base}/revisions/${rev}`),
    scene: stopId => call('GET', `${base}/scene?stopId=${enc(stopId)}`),
    review: liveReview(base),
    async recomputeLight(stopId) { await call('POST', `${base}/light/recompute`, { stopId }); },
    async ping() {
      try { const r = await fetch('/backend/v1/explore/map-config', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(4000) }); return r.status < 500; }
      catch { return false; }
    },
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
      let gen = 0;   // 每次 load 一代：开发模式下 effect 会跑两次，旧的那次要让路，不能和新的互相掐断
      /** history=true：只把一轮已结束的回放进来（读到 done 就返回，不动 stopped）。 */
      async function follow(runId: string, history = false, my = gen) {
        let after = 0;
        const tag = runId.slice(0, 8) + ':';   // 每轮的 seq 从头数，加前缀免得不同轮的条目撞 id
        active?.abort();
        const ctl = new AbortController();
        active = ctl;
        const stopIt = () => ctl.abort();
        try {
          while (!stopped && my === gen) {   // 换代了（又 load 了一次，或发了新消息）就让路
            let response: Response;
            try {
              response = await readEventStream(`/v1/kernel/runs/${runId}/stream?after=${after}`, ctl.signal, after);
            } catch (e) {
              if (stopped || history) return;   // 回放旧轮次失败就跳过，不卡住
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
              // 回放旧轮次：过去的事件会一口气推过来；2 秒没有新数据就算读完。
              // 否则一轮还在等批准的旧对话永远不收尾，这条连接一直占着，攒满浏览器同站连接上限后整页请求排队。
              const next = reader.read().catch(() => ({ value: '', done: true as const }));
              const { value, done } = history
                ? await Promise.race([next, new Promise<{ value: string; done: true }>(r => setTimeout(() => r({ value: '', done: true }), 2000))])
                : await next;
              if (done) { if (history) { void reader.cancel().catch(() => {}); return; } break; }
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
                  push(mapExploreEvent({ seq: frame.seq, action: String(frame.action ?? ''), payload: frame.payload ?? {} }).map(x => ({ ...x, id: tag + x.id })));
                }
                if (frame.state && !history) on(items, !['completed', 'failed', 'cancelled', 'interrupted', 'waiting'].includes(frame.state));   // waiting = 等你批准 / 回答：不算「正在想」
                if (frame.done) { if (!history) stopped = true; return; }
              }
            }
            if (stopped || history || my !== gen) return;
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
          const my = ++gen;
          try {
            const { runs = [] } = await api(`/v1/kernel/dossiers/${enc(dossierId)}/runs`) as { runs?: { id: string; mode?: string }[] };
            // 每句话是一轮：先按时间顺序回放之前几轮（卡片也要在），再跟住最新一轮
            const mine = runs.filter(r => r.mode === 'explore');
            const last = mine[0];
            for (const r of mine.slice(1, 12).reverse()) { if (stopped || my !== gen) return; await follow(r.id, true, my); }
            if (my !== gen) return;
            if (last) await follow(last.id, false, my);
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
          await follow(run.id, false, ++gen);   // 新的一代：还在回放的历史 / 旧的跟随都让路
        },
        stop() { stopped = true; active?.abort(); active = null; },
      };
    },
  };
}
