import { describe, expect, it } from 'vitest';
import * as c from '../packages/contracts/src/index';

const uuid = '11111111-1111-4111-8111-111111111111';
const citation = { source: uuid, locator: 'p.1', quote: '原文' };
const request = { schema: 'research_request@1', question: '如何学习群论', scope: {}, refs: [], budget: { cny: 8 }, expect: 'research_findings@1', gate: 'approve-before' };
const token = { accountId: uuid, dossierId: uuid, runId: uuid, osSessionId: 'session_1', roleId: 'research-lead', grants: [{ tool: 'literature', risk: 'read' }], readScope: { layers: ['L2'], dossierIds: [uuid], refs: [] }, writeTargets: ['findings/'], budget: { cny: 5, quotaRuns: 0, gpuSeconds: 0 }, expiresAt: '2030-01-01T00:00:00Z' };

describe('共享契约', () => {
  it('引用解析与长度', () => { expect(c.Citation.parse(citation)).toEqual(citation); expect(c.Citation.safeParse({ ...citation, quote: 'x'.repeat(401) }).success).toBe(false); });
  it.each(['', ' '])('拒绝空引用 %s', source => expect(c.Citation.safeParse({ source, locator: 'p.1' }).success).toBe(false));
  it.each([
    { kind: 'answer', question: '选择路线', options: ['甲', '乙'], multi: false },
    { kind: 'approval', title: '运行试验', effects: ['写结果'], risk: 'write', action: 'compute' },
    { kind: 'plan', stage: '调研', steps: ['检索'], budgetCny: 8 },
    { kind: 'finding', claim: '可行', citations: [citation], negative: false },
    { kind: 'verdict', subject: '结论甲', pass: false, reasons: ['引用错误'] },
  ])('卡片 %s', card => expect(c.Card.safeParse(card).success).toBe(true));
  it.each([
    { kind: 'answer', question: '问题', options: ['仅一个'], multi: false },
    { kind: 'finding', claim: '无证据', citations: [], negative: false },
    { kind: 'plan', stage: '调研', steps: [], budgetCny: -1 },
  ])('拒绝畸形卡片 %s', card => expect(c.Card.safeParse(card).success).toBe(false));
  it('委托版本与严格字段', () => { expect(c.ResearchRequestV1.safeParse(request).success).toBe(true); expect(c.ResearchRequestV1.safeParse({ ...request, accountId: uuid }).success).toBe(false); });
  it.each([0, -1, Infinity, NaN])('拒绝委托预算 %s', cny => expect(c.ResearchRequestV1.safeParse({ ...request, budget: { cny } }).success).toBe(false));
  it('拒绝无证据的产出', () => expect(c.ResearchFindingsV1.safeParse({ schema: 'research_findings@1', methods: [{ name: '方法', claim: '声称', evidence: [], fit: '适用', confidence: 'high' }], routes: [], negatives: [], nextPlan: '结束' }).success).toBe(false));
  it('运行令牌有效范围', () => expect(c.RunToken.safeParse(token).success).toBe(true));
  it('令牌不得授予danger', () => expect(c.RunToken.safeParse({ ...token, grants: [{ tool: 'delete', risk: 'danger' }] }).success).toBe(false));
  it.each(['always','project'])('拒绝审批作用域 %s', scope => expect(c.ApprovalDecision.safeParse({ decision: 'approve', scope }).success).toBe(false));
  it('未知事件按error记录而不虚构已知kind', () => expect(c.LedgerEvent.safeParse({ seq: 1, at: '2030-01-01T00:00:00Z', dossierId: uuid, runId: null, roleId: null, kind: 'error', action: 'unmapped_event', risk: null, costCny: null, payload: {} }).success).toBe(true));
  it('精读写入不能自签verified', () => expect(c.ReadLayerWrite.safeParse({ paperId: uuid, layer: 'method', items: [{ text: '结论', kind: 'claim', citations: [citation], verified: true }] }).success).toBe(false));
  it('群研领取', () => expect(c.SwarmTools.claim.safeParse({ taskId: 'task-1' }).success).toBe(true));
  it('群研交付要引用', () => expect(c.SwarmTools.deliver.safeParse({ taskId: 'task-1', summary: '结论', citations: [], negative: false }).success).toBe(false));
  it('负结果必须写明检索过程', () => { expect(c.SwarmTools.deliver.safeParse({ taskId: 'task-1', summary: '', citations: [], negative: true }).success).toBe(false); expect(c.SwarmTools.deliver.safeParse({ taskId: 'task-1', summary: '检索 OpenAlex，未找到匹配来源', citations: [], negative: true }).success).toBe(true); });
  it('不能伪造黑板签核', () => expect(c.SwarmTools.deliver.safeParse({ taskId: 'task-1', summary: '结论', citations: [citation], signedOffBy: 'me' }).success).toBe(false));
  it('升级不能无依据', () => expect(c.MemoryPropose.safeParse({ target: 'L4.knowledge', items: [{ key: '结论', value: 'x', evidence: [] }], reason: '保存' }).success).toBe(false));
  it.each([
    [c.ResearchFindingsV1, { schema: 'research_findings@1', methods: [], routes: [], negatives: [{ what: '无结果', how: '查过 OpenAlex' }], nextPlan: '扩大来源' }],
    [c.Json, { ok: true, n: 1, nil: null, list: ['x'] }], [c.Layer, 'L2'], [c.Risk, 'danger'], [c.Mode, 'auto'], [c.GateState, 'ready'], [c.RunState, 'paused_budget'], [c.CredentialKind, 'api_key'],
    [c.Ref, { kind: 'artifact', id: uuid, version: 1 }], [c.Budget, { cny: 5, quotaRuns: 1, gpuMinutes: 0.5 }],
    [c.ApprovalDecision, { decision: 'approve', scope: 'once' }],
    [c.PromotionItem, { key: '发现', value: { good: true }, evidence: ['event:1'] }],
    [c.MemoryRead, { query: '群论', layers: ['L2'] }],
    [c.MemoryPropose, { target: 'L4.knowledge', items: [{ key: '发现', value: '结论', evidence: ['event:1'] }], reason: '已核实' }],
    [c.PendingPromotion, { id: uuid, accountId: uuid, fromRun: uuid, createdAt: '2030-01-01T00:00:00Z', expiresAt: '2030-01-02T00:00:00Z', target: 'L4.knowledge', items: [{ key: '发现', value: '结论', evidence: ['event:1'] }], reason: '已核实' }],
    [c.PromotionDecision, { decision: 'approve' }], [c.PromotionDecision, { decision: 'edit', items: [{ key: '发现', value: null, evidence: ['event:1'] }] }], [c.PromotionDecision, { decision: 'reject' }], [c.PromotionDecision, { decision: 'keep_local' }],
    [c.ReadLayerWrite, { paperId: uuid, layer: '方法', items: [{ text: '解释', kind: 'interpretation', citations: [] }] }],
    [c.ReadQuizWrite, { paperId: uuid, layer: '方法', question: '为何缩放', rubric: { answer: '稳定方差' } }],
    [c.QuizItem, { id: uuid, paperId: uuid, layer: '方法', question: '为何缩放', rubric: {} }],
    [c.SwarmRole, 'verifier'], [c.SwarmTaskDraft, { title: '核对', kind: 'verify' }],
    [c.SwarmTools.broadcast, { text: '开始', task: [{ title: '检索', kind: 'search' }] }], [c.SwarmTools.ask, { to: 'reader-1', question: '原文是什么' }],
    [c.SwarmTools.help, { text: '缺全文' }], [c.SwarmTools.handoff, { to: 'reader', taskId: 't1', artifactRef: { kind: 'artifact', id: uuid } }],
    [c.SwarmTools.refute, { claimId: 'c1', reason: '原文不支持' }], [c.SwarmTools.board, { columns: ['finding'] }],
    [c.ToolResult, { title: '已记录', output: '记录成功', metadata: { error: null } }],
    [c.DossierCreate, { title: '研究档案' }], [c.EstimateRequest, { dossierId: uuid, mode: 'swarm', size: 10 }],
    [c.RunCreate, { dossierId: uuid, mode: 'read', roleId: 'research-read', budget: { cny: 5 }, estimateId: uuid, confirmed: true, input: {} }],
    [c.BudgetAppend, { cny: 1 }], [c.ApiError, { code: 'SCOPE_DENIED', message: '超出权限' }],
  ])('补全有效 schema 样本 %#', (schema, value) => expect(schema.safeParse(value).success).toBe(true));
  it.each(Object.entries(c.ToolSchemas))('工具 %s 参数不允许未知字段', (_name, schema) => expect(schema.safeParse({ injectedAccountId: uuid }).success).toBe(false));
  it('JSON 不允许非有限值或函数', () => { expect(c.Json.safeParse({ value: Infinity }).success).toBe(false); expect(c.Json.safeParse({ value: () => 1 }).success).toBe(false); });
  it('费用未知保持null', () => expect(c.LedgerEvent.parse({ seq: 1, at: '2030-01-01T00:00:00Z', dossierId: uuid, runId: null, roleId: null, kind: 'cost', action: null, risk: null, costCny: null, payload: {} }).costCny).toBeNull());
  it.each([
    [c.ToolSchemas.finding_record, { claim: '结论', citations: [{ ...citation, verifiedBy: 'attacker' }], negative: false }],
    [c.ToolSchemas.read_layer_write, { paperId: uuid, layer: '方法', items: [{ text: '结论', kind: 'claim', citations: [{ ...citation, verifiedBy: 'attacker' }] }] }],
    [c.ToolSchemas.swarm_deliver, { taskId: 't1', summary: '交付', citations: [{ ...citation, verifiedBy: 'attacker' }] }],
    [c.ToolSchemas.swarm_refute, { claimId: 'c1', reason: '反驳', citations: [{ ...citation, verifiedBy: 'attacker' }] }],
  ])('输入不能嵌套自签 verifiedBy %#', (schema, value) => expect(schema.safeParse(value).success).toBe(false));
});
