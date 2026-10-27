// 「上线时待批准」收件箱的数据接口（design/BACKEND_MEMORY_SESSION.md §13）。
// 字段与后端 packages/contracts 的 InboxPromotion / InboxApproval / PromotionDecision 一一对齐；
// 前端只认 InboxAdapter：mock 版在 mockInbox.ts，live 版由后端按同一接口实现，界面不改。

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type PromotionTarget = 'L3.profile' | 'L3.preference' | 'L3.procedure' | 'L4.knowledge';
export type Risk = 'read' | 'write' | 'danger';

/** href：回到原对话的真实路由；没有就不显示跳转，不用假链接。 */
export type InboxSource = { bench: string; dossierId: string; dossierTitle: string; runId: string; roleId: string; href?: string };
export type PromotionItem = { key: string; value: Json; evidence: string[]; supersedes?: string };
export type InboxPromotion = { id: string; target: PromotionTarget; items: PromotionItem[]; reason: string; createdAt: string; expiresAt: string; source: InboxSource };
/** 原生 question：AI 在运行中问你的问题（与后端 question.asked 对齐）。custom 未设或为 true 时允许自己填答案。 */
export type InboxQuestion = { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean; custom?: boolean };
export type InboxApproval = { id: string; runId: string; kind: string; title: string; effects: string[]; risk: Risk; state: 'pending' | 'indeterminate'; sent: boolean; source: InboxSource; questions?: InboxQuestion[] };

export type PromotionDecision =
  | { decision: 'approve' }
  | { decision: 'edit'; items: PromotionItem[] }
  | { decision: 'reject' }
  | { decision: 'keep_local' };

/** 依据：点开后展示的原文片段，可以回到原对话。 */
export type EvidenceView = { ref: string; kind: string; title: string; quote: string; at: string; href?: string };
/** 被替换的旧条目（supersedes 指向的那条），用来显示「将替换」。 */
export type SupersededView = { id: string; key: string; value: Json };

export interface InboxAdapter {
  load(): Promise<{ promotions: InboxPromotion[]; approvals: InboxApproval[] }>;
  decidePromotion(id: string, decision: PromotionDecision): Promise<void>;
  /** kind 为 question 时，批准必须带 answers（每题一组所选标签，顺序与 questions 一致）；驳回不带。 */
  decideApproval(id: string, decision: 'approve' | 'reject', answers?: string[][]): Promise<void>;
  evidence(ref: string): Promise<EvidenceView>;
  superseded(id: string): Promise<SupersededView | null>;
}

export const BENCH: Record<string, { code: string; name: string }> = {
  research: { code: 'RSCH', name: '研究台' }, curriculum: { code: 'CURR', name: '课程台' }, engineering: { code: 'ENGR', name: '工程台' },
  creative: { code: 'CRTV', name: '创作台' }, automation: { code: 'AUTO', name: '自动化台' }, exploration: { code: 'EXPL', name: '探索台' }, data: { code: 'DATA', name: '数据台' },
};
export const TARGET: Record<PromotionTarget, { layer: string; name: string; effect: string }> = {
  'L3.profile': { layer: 'L3', name: '个人侧写', effect: '以后所有工作台讲解、出题、推荐时都会参考这条' },
  'L3.preference': { layer: 'L3', name: '偏好', effect: '以后所有工作台默认按这个偏好来' },
  'L3.procedure': { layer: 'L3', name: '做事方法', effect: '以后遇到同类事情，AI 会按这个方法先做' },
  'L4.knowledge': { layer: 'L4', name: '长期知识', effect: '写进知识库，所有工作台以后都能检索并引用' },
};
export const RISK_TEXT: Record<Risk, string> = { read: '只读', write: '写入 · 需你批准', danger: '危险 · 只能你点' };
