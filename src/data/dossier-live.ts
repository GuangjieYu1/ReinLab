// 档案 live 适配器：一一对应 design/prd/03-dossier-contract.md 第 2～5 节。
import { DossierError, type DossierAdapter, type StreamEvent } from '../components/dossier/adapter';
import { readEventStream, request } from './research-live';

const enc = encodeURIComponent;

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  try { return await request(method, path, body) as T; }
  catch (e) {
    const x = e as Error & { code?: string; detail?: { tombstone?: unknown } & Record<string, unknown> };
    throw new DossierError(x.code ?? 'UNKNOWN', x.message, x.detail?.tombstone ?? x.detail);
  }
}

export function liveDossierAdapter(): DossierAdapter {
  return {
    kind: 'live',
    async list(bench, opts = {}) {
      const q = new URLSearchParams({ bench, view: opts.view ?? 'active' });
      if (opts.q) q.set('q', opts.q);
      if (opts.via) q.set('via', opts.via);
      return (await call<{ items: never[] }>('GET', `/v1/dossiers?${q}`)).items;
    },
    get: id => call('GET', `/v1/dossiers/${enc(id)}`),
    open: id => call('POST', `/v1/dossiers/${enc(id)}/open`, { via: 'page' }),
    async resume(bench) { return (await call<{ dossier: never | null }>('GET', `/v1/benches/${enc(bench)}/resume`)).dossier; },
    async savePosition(id, p) { await call('PUT', `/v1/dossiers/${enc(id)}/resume`, p); },
    create: input => call('POST', '/v1/dossiers', input),
    update: (id, patch) => call('PATCH', `/v1/dossiers/${enc(id)}`, patch),
    async archive(id) {
      const v = await call<{ confirmation?: never } & Record<string, unknown>>('POST', `/v1/dossiers/${enc(id)}/archive`, {});
      return v.confirmation ? { confirmation: v.confirmation } : { done: v as never };
    },
    unarchive: id => call('POST', `/v1/dossiers/${enc(id)}/unarchive`, {}),
    remove: id => call('POST', `/v1/dossiers/${enc(id)}/delete`, {}),
    async decide(cid, approve) { await call('POST', `/v1/approvals/${enc(cid)}/decide`, { decision: approve ? 'approve' : 'reject', scope: 'once' }); },
    async artifacts(id) { return (await call<{ items: never[] }>('GET', `/v1/dossiers/${enc(id)}/artifacts`)).items; },
    async courses(q) { return (await call<{ items: never[] }>('GET', `/v1/courses${q ? `?q=${enc(q)}` : ''}`)).items; },
    attachCourse: (id, courseId) => call('POST', `/v1/dossiers/${enc(id)}/artifacts`, { kind: 'course', courseId }),
    async detach(id, artifactId) { await call('DELETE', `/v1/dossiers/${enc(id)}/artifacts/${enc(artifactId)}`); },
    subscribe(bench, on) {
      // SSE；断线自动重连，期间由使用方的 15 秒刷新兜底。
      const ctl = new AbortController();
      let stopped = false;
      (async () => {
        while (!stopped) {
          try {
            const res = await readEventStream(`/v1/stream?bench=${enc(bench)}`, ctl.signal, 0);
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
                if (data) { try { on(JSON.parse(data) as StreamEvent); } catch { /* 坏的一条跳过 */ } }
              }
            }
          } catch { /* 断线：稍后重连 */ }
          if (!stopped) await new Promise(r => setTimeout(r, 3000));
        }
      })();
      return () => { stopped = true; ctl.abort(); };
    },
  };
}
