import { z } from 'zod';

const text = z.string().trim().min(1);
const count = z.number().finite().int().nonnegative();
const money = z.number().finite().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const id = z.string().uuid();
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const Json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(Json), z.record(Json)]));

export const Risk = z.enum(['read', 'write', 'danger']);
export type Risk = z.infer<typeof Risk>;
export const Layer = z.enum(['L1', 'L2', 'L3', 'L4']);
export type Layer = z.infer<typeof Layer>;
export const Mode = z.enum(['read', 'swarm', 'auto']);
export type Mode = z.infer<typeof Mode>;
export const GateState = z.enum(['locked', 'ready', 'running', 'review', 'discuss', 'approved']);
export type GateState = z.infer<typeof GateState>;
export const RunState = z.enum(['queued', 'running', 'waiting', 'paused_budget', 'completed', 'failed', 'cancelled', 'interrupted']);
export const CredentialKind = z.enum(['api_key', 'subscription_oauth', 'external_runtime', 'self_hosted']);
export const Citation = z.object({ source: text, locator: text, quote: z.string().max(400).optional(), verifiedBy: text.optional() }).strict();
export type Citation = z.infer<typeof Citation>;
export const CitationInput = Citation.omit({ verifiedBy: true }).strict();
export type CitationInput = z.infer<typeof CitationInput>;
export const Ref = z.object({ kind: z.enum(['artifact', 'memory', 'url']), id: text, version: z.number().int().positive().optional() }).strict();
export const Budget = z.object({ cny: money, quotaRuns: count.optional(), gpuMinutes: money.optional() }).strict();
export type Budget = z.infer<typeof Budget>;
export const LedgerEvent = z.object({
  seq: z.number().int().positive().safe(), at: timestamp, dossierId: id, runId: id.nullable(), roleId: text.nullable(),
  kind: z.enum(['message', 'tool', 'approval', 'card', 'artifact', 'cost', 'gate', 'swarm', 'study', 'delegation', 'memory', 'error']),
  action: text.nullable(), risk: Risk.nullable(), costCny: money.nullable(), payload: z.record(Json),
}).strict();
export type LedgerEvent = z.infer<typeof LedgerEvent>;
export const Card = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), question: text, options: z.array(text).min(2).max(6), multi: z.boolean() }).strict(),
  z.object({ kind: z.literal('approval'), title: text, effects: z.array(text).min(1), risk: Risk, action: text }).strict(),
  z.object({ kind: z.literal('plan'), stage: text, steps: z.array(text).min(1), budgetCny: money }).strict(),
  z.object({ kind: z.literal('finding'), claim: text, citations: z.array(Citation).min(1), negative: z.boolean() }).strict(),
  z.object({ kind: z.literal('verdict'), subject: text, pass: z.boolean(), reasons: z.array(text).min(1) }).strict(),
]);
export type Card = z.infer<typeof Card>;
export const ResearchRequestV1 = z.object({
  schema: z.literal('research_request@1'), question: z.string().trim().min(4),
  scope: z.object({ include: z.array(text).optional(), exclude: z.array(text).optional(), since: text.optional(), languages: z.array(z.enum(['zh', 'en'])).optional() }).strict(),
  refs: z.array(Ref), budget: Budget.extend({ cny: money.positive() }), expect: text, deadline: timestamp.optional(), gate: z.enum(['none', 'approve-before', 'approve-after']),
}).strict();
export type ResearchRequestV1 = z.infer<typeof ResearchRequestV1>;
export const ResearchFindingsV1 = z.object({
  schema: z.literal('research_findings@1'),
  methods: z.array(z.object({ name: text, claim: text, evidence: z.array(Citation).min(1), fit: text, confidence: z.enum(['high', 'mid', 'low']) }).strict()),
  routes: z.array(z.object({ id: text, name: text, steps: z.array(text), why: text, picked: z.boolean() }).strict()),
  negatives: z.array(z.object({ what: text, how: text }).strict()), nextPlan: text,
}).strict();
export type ResearchFindingsV1 = z.infer<typeof ResearchFindingsV1>;
export const RunToken = z.object({
  accountId: id, dossierId: id, runId: id, osSessionId: text, roleId: text,
  grants: z.array(z.object({ tool: text, risk: z.enum(['read', 'write']) }).strict()),
  readScope: z.object({ layers: z.array(Layer), dossierIds: z.array(id), refs: z.array(Ref) }).strict(),
  writeTargets: z.array(text), budget: z.object({ cny: money, quotaRuns: count, gpuSeconds: count }).strict(), expiresAt: timestamp,
}).strict();
export type RunToken = z.infer<typeof RunToken>;
export const ApprovalDecision = z.object({ decision: z.enum(['approve', 'reject']), scope: z.enum(['once', 'session']).optional() }).strict();
export const PromotionTarget = z.enum(['L3.profile', 'L3.preference', 'L3.procedure', 'L4.knowledge']);
export const PromotionItem = z.object({ key: text, value: Json, evidence: z.array(text).min(1), supersedes: id.optional() }).strict();
export const MemoryRead = z.object({ query: text, layers: z.array(Layer).min(1) }).strict();
export const MemoryPropose = z.object({ target: PromotionTarget, items: z.array(PromotionItem).min(1), reason: text }).strict();
export const PendingPromotion = MemoryPropose.extend({ id, accountId: id, fromRun: id, createdAt: timestamp, expiresAt: timestamp }).strict();
export type PendingPromotion = z.infer<typeof PendingPromotion>;
export const PromotionDecision = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(), z.object({ decision: z.literal('edit'), items: z.array(PromotionItem).min(1) }).strict(),
  z.object({ decision: z.literal('reject') }).strict(), z.object({ decision: z.literal('keep_local') }).strict(),
]);
export const ReadLayerWrite = z.object({ paperId: id, layer: text, items: z.array(z.object({ text, kind: z.enum(['claim', 'interpretation']), citations: z.array(CitationInput) }).strict().refine(item => item.kind === 'interpretation' || item.citations.length > 0, '作者声称必须带引用')).min(1) }).strict();
export const QuizItem = z.object({ id, paperId: id, layer: text, question: text, rubric: Json, answer: text.optional(), verdict: text.optional() }).strict();
export type QuizItem = z.infer<typeof QuizItem>;
export const ReadQuizWrite = z.object({ paperId: id, layer: text, question: text, rubric: Json }).strict();
export const SwarmRole = z.enum(['lead', 'planner', 'scout', 'reader', 'analyst', 'critic', 'verifier', 'synth']);
export const SwarmTaskDraft = z.object({ id: text.optional(), parentId: text.optional(), title: text, kind: text }).strict();
export const SwarmTools = {
  broadcast: z.object({ text, task: z.array(SwarmTaskDraft).optional() }).strict(),
  claim: z.object({ taskId: text }).strict(),
  ask: z.object({ to: text, question: text, taskId: text.optional() }).strict(),
  deliver: z.object({ taskId: text, summary: text, citations: z.array(CitationInput), negative: z.boolean().optional() }).strict().refine(value => value.negative === true || value.citations.length > 0, '交付必须附引用，负结果须写检索过程'),
  help: z.object({ text, taskId: text.optional() }).strict(),
  handoff: z.object({ to: text, taskId: text, artifactRef: Ref }).strict(),
  refute: z.object({ claimId: text, reason: text, citations: z.array(CitationInput).optional() }).strict(),
  board: z.object({ columns: z.array(z.enum(['question', 'finding', 'help', 'decision'])).optional() }).strict(),
} as const;
export const ToolSchemas = {
  card_answer: Card.options[0].omit({ kind: true }), card_approval: Card.options[1].omit({ kind: true }),
  plan_propose: Card.options[2].omit({ kind: true }), finding_record: Card.options[3].omit({ kind: true }).extend({ citations: z.array(CitationInput).min(1) }), verdict_record: Card.options[4].omit({ kind: true }),
  memory_read: MemoryRead, memory_propose: MemoryPropose, read_layer_write: ReadLayerWrite, read_quiz_write: ReadQuizWrite,
  swarm_broadcast: SwarmTools.broadcast, swarm_claim: SwarmTools.claim, swarm_ask: SwarmTools.ask, swarm_deliver: SwarmTools.deliver,
  swarm_help: SwarmTools.help, swarm_handoff: SwarmTools.handoff, swarm_refute: SwarmTools.refute, swarm_board: SwarmTools.board,
} as const;
export type ToolId = keyof typeof ToolSchemas;
export const ToolResult = z.object({ title: text, output: text, metadata: z.record(Json) }).strict();
export const DossierCreate = z.object({ bench: z.literal('research').default('research'), title: text.max(200) }).strict();
export const EstimateRequest = z.object({ dossierId: id, mode: Mode, size: count.positive().max(32).optional(), modelTier: z.enum(['cheap', 'mid', 'strong']).optional() }).strict();
export const RunCreate = z.object({ dossierId: id, mode: Mode, roleId: text, budget: Budget.extend({ cny: money.positive() }), estimateId: id, confirmed: z.literal(true), input: z.record(Json) }).strict();
export const BudgetAppend = z.object({ cny: money.positive() }).strict();
export const ApiError = z.object({ code: text, message: text, details: Json.optional() }).strict();
export type ApiError = z.infer<typeof ApiError>;
export type RunState = z.infer<typeof RunState>;
export type CredentialKind = z.infer<typeof CredentialKind>;
export type Ref = z.infer<typeof Ref>;
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
export type PromotionTarget = z.infer<typeof PromotionTarget>;
export type PromotionItem = z.infer<typeof PromotionItem>;
export type MemoryRead = z.infer<typeof MemoryRead>;
export type MemoryPropose = z.infer<typeof MemoryPropose>;
export type PromotionDecision = z.infer<typeof PromotionDecision>;
export type ReadLayerWrite = z.infer<typeof ReadLayerWrite>;
export type ReadQuizWrite = z.infer<typeof ReadQuizWrite>;
export type SwarmRole = z.infer<typeof SwarmRole>;
export type SwarmTaskDraft = z.infer<typeof SwarmTaskDraft>;
export type ToolInputs = { [K in ToolId]: z.infer<typeof ToolSchemas[K]> };
export type ToolResult = z.infer<typeof ToolResult>;
export type DossierCreate = z.infer<typeof DossierCreate>;
export type EstimateRequest = z.infer<typeof EstimateRequest>;
export type RunCreate = z.infer<typeof RunCreate>;
export type BudgetAppend = z.infer<typeof BudgetAppend>;
export const Bench = z.enum(['research','curriculum','engineering','creative','automation','exploration','data']);
export const Dossier = z.object({ id, bench: Bench, title: text, createdAt: timestamp, archivedAt: timestamp.nullable().optional() }).strict();
export type Dossier = z.infer<typeof Dossier>;
export const AccountProfile = z.object({ id, displayName: z.string().nullable(), monthlyBudgetCny: money,
  machine: z.object({ state: text, osVersion: z.string().nullable(), lastHealthAt: timestamp.nullable() }).strict().nullable(),
}).strict();
export type AccountProfile = z.infer<typeof AccountProfile>;
export const RunSummary = z.object({ id, mode: Mode, state: RunState, budgetCny: money, spentCny: money }).strict();
export const DossierDetail = z.object({ dossier: Dossier, gates: z.array(z.object({ id, subject: text, state: GateState }).strict()), activeRuns: z.array(RunSummary), budget: z.object({ allocatedCny: money, spentCny: money }).strict() }).strict();
export type DossierDetail = z.infer<typeof DossierDetail>;
