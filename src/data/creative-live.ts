// 创作台 live 适配器：控制面 /v1/creative/worlds/*（design/prd/20-creative-contract.md §2）。
import type { CreativeOp } from '../../packages/contracts/src/creative';
import { CreativeError, type CreativeAdapter, type CreativeStreamEvent } from '../components/workbenches/creative/live/adapter';
import { readEventStream, request } from './research-live';

const enc = encodeURIComponent;

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  try { return await request(method, path, body) as T; }
  catch (e) { const x = e as { message?: string; code?: string; detail?: unknown }; throw new CreativeError(x.message ?? '没有成功', x.code ?? 'UNKNOWN', x.detail); }
}

export function createLiveCreativeAdapter(dossierId: string): CreativeAdapter {
  const base = `/v1/creative/worlds/${enc(dossierId)}`;
  return {
    kind: 'live',
    works: () => call('GET', `${base}/works`),
    work: id => call('GET', `${base}/works/${enc(id)}`),
    createWork: (title, targetWords) => call('POST', `${base}/works`, { kind: 'novel', title, targetWords }),
    workOps: (id, baseRevision, ops) => call('POST', `${base}/works/${enc(id)}/ops`, { baseRevision, ops }),
    proposals: filters => call('GET', `${base}/proposals?${new URLSearchParams(filters)}`),
    generate: (id, req) => call('POST', `${base}/works/${enc(id)}/generate`, req),
    generation: (_id, job, stop) => call(stop ? 'POST' : 'GET', `${base}/generate/${enc(job)}${stop ? '/stop' : ''}`, stop ? {} : undefined),
    importText: async (id, text, title) => {
      const { assetId } = await call<{ assetId: string }>('POST', `${base}/assets`, { name: title || '导入原文', content: text, format: 'text' });
      return call('POST', `${base}/works/${enc(id)}/import`, { assetId });
    },
    importPreview: (id, text) => call('POST', `${base}/works/${enc(id)}/import/preview`, { text }),
    importJob: (id, action) => call(action ? 'POST' : 'GET', `${base}/imports/${enc(id)}${action ? '/' + action : ''}`, action ? {} : undefined),
    exportWork: async (id, format) => {
      const res = await fetch(`/backend${base}/works/${enc(id)}/export?format=${format}`, { credentials: 'same-origin' });
      if (!res.ok) { const error = await res.json().catch(() => null); throw new Error(error?.message || '导出失败'); }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = url; a.download = `小说.${format}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    startAssistant: async (query, mode, workId, sceneId) => {
      const run = await call<{ id: string }>('POST', '/v1/kernel/runs', { dossierId, query, mode, workId, sceneId });
      localStorage.setItem(`creative-assistant:${dossierId}:${mode}`, run.id);
      return run;
    },
    runs: async () => {
      const page = await call<{ runs: { id: string; mode?: string; state: string }[] }>('GET', `/v1/kernel/dossiers/${enc(dossierId)}/runs`);
      // 内核列表的 mode 是 creative；本机记录启动时选择的具体角色，用于断线恢复。
      for (const mode of ['creative_advisor', 'creative_writer']) {
        const id = localStorage.getItem(`creative-assistant:${dossierId}:${mode}`);
        const row = page.runs.find(r => r.id === id);
        if (row) row.mode = mode;
        else if (id) page.runs.push({ id, mode, state: 'unknown' });
      }
      return page;
    },
    runEvents: (id, after) => call('GET', `/v1/kernel/runs/${enc(id)}/events?after=${after}`),
    runState: id => call('GET', `/v1/kernel/runs/${enc(id)}`),
    load: version => call('GET', base + (version ? `?version=${version}` : '')),
    ops: (baseRevision: number, ops: CreativeOp[]) => call('POST', `${base}/ops`, { baseRevision, ops }),
    tracks: (from, to, ids) => call('GET', `${base}/tracks?from=${Math.floor(from)}&to=${Math.ceil(to)}${ids?.length ? `&entityIds=${ids.map(enc).join(',')}` : ''}`),
    editsAt: t => call('GET', `${base}/edits/geojson?t=${Math.round(t)}`),
    check: () => call('POST', `${base}/check`, {}),
    importNetwork: req => call('POST', `${base}/network/import`, req),
    uploadAsset: (name, content) => call('POST', `${base}/assets`, { name, content, format: 'geojson' }),
    saveVersion: summary => call('POST', `${base}/versions`, { summary }),
    mapConfig: () => call('GET', '/v1/explore/map-config'),
    subscribe(after, on, onGap) {
      const ctl = new AbortController();
      let stopped = false, last = after;
      (async () => {
        while (!stopped) {
          let quietSince = Date.now();
          try {
            const res = await readEventStream(`${base}/stream?after=${last}`, ctl.signal, last);
            const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              quietSince = Date.now();
              buf += value;
              let i;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, i); buf = buf.slice(i + 2);
                const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
                if (!data) continue;
                try {
                  const ev = JSON.parse(data) as CreativeStreamEvent & { dossierId?: string };
                  // seq 是全库自增（creative_event 的 bigserial），同一世界观里本来就不连续；
                  // 服务端按 after 从库里顺序补发，所以这里只按 seq 去重，断线由 after 续上。
                  if (typeof ev.seq !== 'number' || ev.seq <= last) continue;
                  last = ev.seq;
                  on(ev);
                } catch { /* 坏的一条跳过 */ }
              }
            }
          } catch { /* 断线：稍后重连 */ }
          if (stopped) break;
          // 断开超过 30 秒：漏掉的可能太多，让页面重取快照（契约 §7）
          if (Date.now() - quietSince > 30_000) onGap();
          await new Promise(r => setTimeout(r, 3000));
        }
      })();
      return () => { stopped = true; ctl.abort(); };
    },
  };
}
