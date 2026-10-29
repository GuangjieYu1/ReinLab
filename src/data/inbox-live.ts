import type { InboxReport, InboxAdapter, InboxPromotion, InboxQuestion, PromotionItem, EvidenceView } from '../components/inbox/inboxTypes';
import { api, decide, inbox, sessionGeneration } from './research-live';

type Ports = { api: typeof api; decide: typeof decide; inbox: typeof inbox; generation: typeof sessionGeneration };
const unavailable = () => Error('收件箱来源或会话已变化，请刷新。');
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function items(value: unknown): PromotionItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(v => !object(v) || typeof v.key !== 'string' || !('value' in v) || !Array.isArray(v.evidence) || v.evidence.some((e: unknown) => typeof e !== 'string'))) throw unavailable();
  return value;
}
function effects(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(effects);
  if (typeof value === 'string') return [value];
  if (value === undefined || value === null) return [];
  // API has already scrubbed private metadata. Text nodes remain escaped by Claude's component.
  return [JSON.stringify(value, null, 2)];
}
function nativeQuestions(value: unknown): InboxQuestion[] | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const event = value[0];
  if (!object(event) || event.source?.type !== 'question.asked' || !object(event.properties)) return undefined;
  const questions = event.properties.questions;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 64 || questions.some(q =>
    !object(q) || typeof q.question !== 'string' || typeof q.header !== 'string' ||
    !Array.isArray(q.options) || q.options.length > 64 || q.options.some((o: unknown) => !object(o) || typeof o.label !== 'string' || typeof o.description !== 'string') ||
    (q.multiple !== undefined && typeof q.multiple !== 'boolean') || (q.custom !== undefined && typeof q.custom !== 'boolean')
  )) return undefined;
  return questions.map(q => ({ question: q.question, header: q.header,
    options: q.options.map((o: { label: string; description: string }) => ({ label: o.label, description: o.description })),
    ...(q.multiple === undefined ? {} : { multiple: q.multiple }),
    ...(q.custom === undefined ? {} : { custom: q.custom }),
  }));
}
export function createLiveInboxAdapter(ports: Ports = { api, decide, inbox, generation: sessionGeneration }): InboxAdapter {
  let generation = -1;
  let promotions = new Map<string, InboxPromotion>();
  let approvals = new Map<string, { state: string; kind: string; sent?: boolean }>();
  const current = () => { if (generation !== ports.generation()) throw unavailable(); };
  const source = (ref: string, field: 'evidence' | 'supersedes') => {
    current();
    return [...promotions.values()].find(p => p.items.some(i => field === 'evidence' ? i.evidence.includes(ref) : i.supersedes === ref));
  };
  return {
    // 任务报告：GET /v1/reports（只读，结束了的任务；不需要批准）
    async reports() {
      const value = await ports.api("/v1/reports");
      const list = Array.isArray(value?.items) ? value.items : [];
      const STATE: Record<string, InboxReport["state"]> = { completed: "completed", interrupted: "interrupted", failed: "failed", cancelled: "cancelled" };
      return list.map((r: any): InboxReport => {
        const layers = Number(r.produced?.layers ?? 0), findings = Number(r.produced?.findings ?? 0);
        const at = r.endedAt ? new Date(r.endedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
        return {
          id: String(r.runId), runId: String(r.runId),
          title: `精读${r.state === "completed" ? "完成" : "结束"}：${r.dossierTitle ?? "未命名档案"}${layers ? `（讲解 ${layers} 层、发现 ${findings} 张）` : ""}`,
          state: STATE[r.state] ?? "failed", reason: r.reason ?? undefined, artifacts: layers + findings, at,
          source: { bench: "research", dossierId: String(r.dossierId), dossierTitle: String(r.dossierTitle ?? ""), runId: String(r.runId), roleId: "research-read" },
        };
      });
    },
    async load() {
      const expected = ports.generation();
      const data = await ports.inbox();
      if (expected !== ports.generation()) throw unavailable();
      const mapped = data.promotions.map(p => ({ ...p, items: items(p.items) }));
      promotions = new Map(mapped.map(p => [p.id, p]));
      approvals = new Map(data.approvals.map(a => [a.id, a]));
      generation = expected;
      return { promotions: mapped, approvals: data.approvals.map(a => ({ ...a, state: a.sent ? 'indeterminate' as const : a.state, effects: effects(a.effects), ...(a.kind === 'question' ? { questions: nativeQuestions(a.effects) } : {}) })) };
    },
    async decidePromotion(id, decision) {
      current();
      if (!promotions.has(id)) throw unavailable();
      await ports.decide('promotion', id, decision);
      current();
    },
    async decideApproval(id, decision, answers) {
      current();
      const entry = approvals.get(id);
      if (!entry || entry.state !== 'pending' || entry.sent || (entry.kind === 'question' && decision === 'approve' && answers === undefined)) throw unavailable();
      // Keep labels, ordering and whitespace intact; the native decision API validates the answers.
      await ports.decide('approval', id, { decision, scope: 'once', ...(answers === undefined ? {} : { answers }) });
      current();
    },
    async evidence(ref) {
      const p = source(ref, 'evidence');
      if (!p || !/^event:[1-9][0-9]{0,15}$/.test(ref) || !Number.isSafeInteger(Number(ref.slice(6)))) throw unavailable();
      const value = await ports.api(`/v1/promotions/${encodeURIComponent(p.id)}/evidence/${ref.slice(6)}`);
      current();
      if (value.ref !== ref || !object(value.event) || typeof value.event.at !== 'string' || value.event.dossierId !== p.source.dossierId || value.event.runId !== p.source.runId) throw unavailable();
      const event = value.event, payload = event.payload;
      const text = typeof payload === 'string' ? payload : object(payload) ? [payload.text, payload.message, payload.summary].find(v => typeof v === 'string') : undefined;
      return { ref, kind: event.kind === 'message' ? '来源对话' : '来源记录', title: p.source.dossierTitle + (event.action ? ' · ' + event.action : ''), quote: text ?? JSON.stringify(payload, null, 2), at: event.at } satisfies EvidenceView;
    },
    async superseded(id) {
      const p = source(id, 'supersedes');
      if (!p) return null;
      let value: unknown;
      try { value = await ports.api(`/v1/promotions/${encodeURIComponent(p.id)}/superseded/${encodeURIComponent(id)}`); }
      catch { current(); return null; }
      current();
      if (!object(value) || value.id !== id || !p.items.some(i => i.supersedes === id && i.key === value.key) || !('value' in value)) throw unavailable();
      return { id:value.id, key:value.key, value:value.value };
    },
  };
}
export const liveInboxAdapter = createLiveInboxAdapter();
