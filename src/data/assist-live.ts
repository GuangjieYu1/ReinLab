// 非研究台的侧边会话（档案助手）：POST /v1/kernel/runs { dossierId, query, mode:'assist' }，
// 事件沿用精读的内核事件流。这一档只有档案工具。
import type { Confirmation, OpenTarget } from '../../packages/contracts/src/dossier';
import { api } from './research-live';

type KernelEvent = { seq: number; action: string; payload: Record<string, any> };

export type AssistItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'agent'; text: string }
  | { id: string; kind: 'note'; text: string }
  | { id: string; kind: 'tool'; name: string; state: 'running' | 'done' | 'failed'; label: string }
  | { id: string; kind: 'open'; title: string; open: OpenTarget }
  | { id: string; kind: 'confirm'; confirmation: Confirmation };

const TOOL_LABEL: Record<string, string> = {
  dossier_list: '查档案', dossier_get: '读档案', dossier_create: '新建档案', dossier_update: '修改档案',
  dossier_archive: '归档', dossier_unarchive: '取消归档', dossier_delete: '删除（等你确认）',
  dossier_attach_course: '加入课程', dossier_detach: '移除关联',
};
const INTERNAL = new Set(['step/start', 'step/end', 'turn/start', 'request/header', 'request/context', 'system/message', 'session/title', 'session-log-deepseek/delivery-accepted', 'agent/inbox/spliced', 'llm/retry', 'llm/retry-started', 'assistant/attempt']);
/** 服务端投递的档案变动（第 8 节）：显示成一行操作提示，不当作用户说的话。 */
export const CHANGE_PREFIX = '档案变动：';

const textOf = (m: any): string => Array.isArray(m?.content) ? m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('') : typeof m?.content === 'string' ? m.content : '';

/** 结果里带 open 的（档案 / 课程），渲染成可点的卡。 */
function opensIn(result: unknown): { title: string; open: OpenTarget }[] {
  const out: { title: string; open: OpenTarget }[] = [];
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v.open && typeof v.open === 'object' && typeof v.open.to === 'string') out.push({ title: String(v.title ?? v.target?.title ?? '打开'), open: v.open });
    Object.values(v).forEach(x => { if (x && typeof x === 'object') walk(x); });
  };
  walk(result);
  return out.slice(0, 6);
}

export function mapAssist(e: KernelEvent): AssistItem[] {
  const d = e.payload ?? {};
  if (INTERNAL.has(e.action)) return [];
  switch (e.action) {
    case 'user/message': {
      if (d.source?.kind === 'runtime-context') return [];
      const t = textOf(d) || textOf(d.message);
      if (!t) return [];
      if (t.startsWith(CHANGE_PREFIX)) return [{ id: `n${e.seq}`, kind: 'note', text: t.slice(CHANGE_PREFIX.length).trim() }];
      return [{ id: String(d.id ?? `u${e.seq}`), kind: 'user', text: t }];
    }
    case 'assistant/message': { const t = textOf(d.message); return t ? [{ id: String(d.message?.id ?? `a${e.seq}`), kind: 'agent', text: t }] : []; }
    case 'tool/call': { const n = String(d.name ?? ''); return [{ id: String(d.callId ?? `t${e.seq}`), kind: 'tool', name: n, state: 'running', label: TOOL_LABEL[n] ?? n }]; }
    case 'tool/result': {
      const id = String(d.message?.toolCallId ?? d.message?.source?.callId ?? `t${e.seq}`);
      const raw = textOf(d.message);
      let parsed: unknown = null; try { parsed = JSON.parse(raw); } catch { /* 不是 JSON 就只更新状态 */ }
      const failed = !!d.error || !!d.message?.isError || (parsed as any)?.error;
      const conf = (parsed as any)?.confirmation as Confirmation | undefined;
      return [{ id, kind: 'tool', name: '', state: failed ? 'failed' : 'done', label: '' },
        // 删除 / 归档的确认卡：在对话里也显示同一张（同一个 id），点了和在收件箱、弹窗里点一样
        ...(conf?.id ? [{ id: `${id}:c`, kind: 'confirm' as const, confirmation: conf }] : []),
        ...(conf ? [] : opensIn(parsed).map((o, i) => ({ id: `${id}:o${i}`, kind: 'open' as const, ...o })))];
    }
    default: return [];
  }
}

/** 一份档案的档案助手会话。发一句 = 起一轮；轮询事件直到这一轮结束。 */
export function assistSession(dossierId: string, on: (items: AssistItem[], busy: boolean) => void) {
  let items: AssistItem[] = [];
  let stopped = false;
  const push = (xs: AssistItem[]) => {
    for (const x of xs) {
      const i = items.findIndex(y => y.id === x.id);
      if (i < 0) items = [...items, x];
      else if (x.kind === 'tool' && items[i].kind === 'tool') items = items.map((y, k) => k === i ? { ...y, state: x.state } as AssistItem : y);
    }
  };
  async function follow(runId: string) {
    let after = 0;
    for (let n = 0; !stopped && n < 400; n++) {
      const { events = [] } = await api(`/v1/kernel/runs/${runId}/events?after=${after}`) as { events?: KernelEvent[] };
      for (const e of events) { after = Math.max(after, e.seq); push(mapAssist(e)); }
      const st = await api(`/v1/kernel/runs/${runId}`) as { state?: string };
      const done = ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(st.state));
      on(items, !done);
      if (done) return;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  return {
    async load() {
      stopped = false; // StrictMode 下 effect 会先清理再挂载：重新挂载时恢复
      // 最近一轮（如果是档案助手的）照原样回放；打开本身不发起任何运行
      const { runs = [] } = await api(`/v1/kernel/dossiers/${dossierId}/runs`) as { runs?: { id: string; state: string; mode?: string }[] };
      const last = runs.find(r => r.mode === 'assist');
      if (last) await follow(last.id); else on(items, false);
    },
    async send(text: string) {
      stopped = false;
      push([{ id: `local-${Date.now()}`, kind: 'user', text }]); on(items, true);
      const run = await api('/v1/kernel/runs', { dossierId, query: text, mode: 'assist' }, crypto.randomUUID()) as { id: string };
      // 本地占位的用户气泡由服务端事件里的同一句话取代
      items = items.filter(x => !x.id.startsWith('local-'));
      await follow(run.id);
    },
    stop() { stopped = true; },
  };
}
