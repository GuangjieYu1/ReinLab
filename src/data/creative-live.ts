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
