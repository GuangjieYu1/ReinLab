import type { EvidenceView, InboxAdapter, InboxApproval, InboxPromotion, PromotionDecision, SupersededView } from './inboxTypes';

// 收件箱示例数据：离开期间 5 条「提议记住」+ 3 个「待确认动作」，覆盖四种记忆目标、替换旧条目、结果未知的动作。
// 时间相对「现在」生成；决定只改内存，不连接任何后端。

const H = 3600_000;
const at = (h: number) => new Date(Date.now() + h * H).toISOString();
const src = (bench: string, dossierTitle: string, roleId: string, n: number) => ({ bench, dossierId: `d-${bench}-${n}`, dossierTitle, runId: `run-${bench}-${n}`, roleId });

export const PROMOTIONS: InboxPromotion[] = [
  {
    id: 'p-moe', target: 'L4.knowledge', createdAt: at(-2.2), expiresAt: at(21.8), source: src('research', '稀疏专家路由的稳定性', 'research-read', 1),
    reason: '精读《Sparse MoE Routing at Scale》时两次独立得到同一结论，复现实验的数字也一致，值得以后直接引用。',
    items: [
      { key: 'MoE 负载均衡辅助损失的稳定区间', value: '系数在 1e-2 附近训练最稳；超过 5e-2 时专家开始塌缩，路由熵在 2k 步内跌到 0.3 以下。', evidence: ['ev-read-7', 'ev-repro-2'] },
      { key: '容量因子与丢弃率', value: { '容量因子 1.0': '约 8% token 被丢弃', '容量因子 1.25': '约 1.5%', '建议': '1.25，显存只多 6%' }, evidence: ['ev-read-9'] },
    ],
  },
  {
    id: 'p-read-habit', target: 'L3.procedure', createdAt: at(-5), expiresAt: at(43), source: src('research', '稀疏专家路由的稳定性', 'research-read', 1),
    reason: '你连续 4 篇论文都是先展开图表、再回头看方法，我想把它变成精读的默认顺序。',
    items: [{ key: '精读的默认顺序', value: '先看图表与结论，再看方法，最后看相关工作。', evidence: ['ev-habit'], supersedes: 'mem-old-order' }],
  },
  {
    id: 'p-learner', target: 'L3.profile', createdAt: at(-20), expiresAt: at(4), source: src('curriculum', '群论 · 对称与群', 'course-review', 2),
    reason: '「群论 · 对称与群」U1 正式收尾时生成的学习者侧写，每条都能追溯到考核或复核记录。',
    items: [
      { key: '群论 · 已掌握', value: '子群判定、群的同态；能独立写出单位元唯一性的证明。', evidence: ['ev-exam-u1'] },
      { key: '群论 · 尚不稳', value: '陪集与拉格朗日定理：会用，但说不清为什么每个陪集一样大。', evidence: ['ev-exam-q4', 'ev-dispute'] },
      { key: '学习偏好', value: '先看具体例子（正方形的对称），再看抽象定义。', evidence: ['ev-pref'] },
    ],
  },
  {
    id: 'p-higashiyama', target: 'L3.procedure', createdAt: at(-30), expiresAt: at(18), source: src('exploration', '东山 · 秋日人像', 'review-assistant', 3),
    reason: '回顾时你写了「下次早点到」，结合实际拍摄时间线，整理成一条可复用的经验。',
    items: [{ key: '八坂塔逆光人像', value: '16:20 之后逆光最好；提前 20 分钟到，先占二年坂转角的机位。', evidence: ['ev-field-notes'] }],
  },
  {
    id: 'p-arxiv', target: 'L4.knowledge', createdAt: at(-9), expiresAt: at(63), source: src('automation', '每日资料整理', 'maintainer', 4),
    reason: '维护 Agent 排查 WF-01 三次「空结果」后确认的来源规律，例程和研究台都会用到。',
    items: [{ key: 'arXiv RSS 的更新时间', value: '当天条目在北京时间 20:00 之后才出现；早上 08:30 拉取得到的是前一天的。', evidence: ['ev-inc-11'] }],
  },
];

export const APPROVALS: InboxApproval[] = [
  { id: 'a-finding', runId: 'run-research-1', kind: 'files.write', title: '写入 findings/routing-stability.md', risk: 'write', state: 'pending', sent: false, source: src('research', '稀疏专家路由的稳定性', 'research-read', 1),
    effects: ['新建 1 个文件，约 1.2 KB', '内容是上面那条 L4 知识的长版本，带 3 处页码引用', '写入后可以在档案里撤销'] },
  { id: 'a-source', runId: 'run-automation-5', kind: 'live.params.set', title: 'LV-01 新能源车舆情 · 来源加上「短视频」', risk: 'write', state: 'pending', sent: false, source: src('automation', '新能源车舆情', 'maintainer', 5),
    effects: ['运行器会放行 1 个新域名', '下一拍开始生效，可以一键回到上一版'] },
  { id: 'a-question', runId: 'run-research-7', kind: 'question', title: '群研第二轮：先往哪个方向查？', risk: 'read', state: 'pending', sent: false, source: src('research', '稀疏专家路由的稳定性', 'swarm-lead', 7),
    effects: ['群研指挥暂停在第二轮开始前，等你回答', '回答后按你的选择分派 4 个子 Agent', '不回答也可以驳回，这一轮会结束'],
    questions: [
      { header: '方向', question: '第二轮先集中在哪个方向？', options: [{ label: '路由塌缩的成因', description: '读 3 篇近期分析论文，找共同机制' }, { label: '容量因子的工程取舍', description: '对比 4 个开源实现的默认值与报告' }, { label: '两边各一半', description: '每边 2 个子 Agent，深度会浅一些' }] },
      { header: '来源', question: '允许用哪些来源？', multiple: true, custom: false, options: [{ label: 'arXiv', description: '预印本，最新但未审稿' }, { label: '会议论文', description: 'NeurIPS / ICML / ICLR' }, { label: '技术博客', description: '工程经验，引用时要标注' }] },
    ] },
  { id: 'a-unknown', runId: 'run-research-6', kind: 'files.write', title: '写入 read/layers/03-method.md', risk: 'write', state: 'indeterminate', sent: true, source: src('research', '稀疏专家路由的稳定性', 'research-read', 6),
    effects: ['你上次已批准，但发出后连接中断，结果未知', '不会自动重发；核对后会出现在档案的写入记录里'] },
];

const EVIDENCE: Record<string, Omit<EvidenceView, 'ref'>> = {
  'ev-read-7': { kind: '精读批注', title: '《Sparse MoE Routing at Scale》p.7 · 图 4', quote: 'Auxiliary loss coefficients above 5e-2 led to expert collapse within 2k steps in all three seeds.', at: at(-2.4) },
  'ev-repro-2': { kind: '复现记录', title: '复现 · 辅助损失扫描（3 个种子）', quote: '0.01：路由熵 1.92 ± 0.04；0.05：第 1.8k 步跌到 0.27。', at: at(-2.3) },
  'ev-read-9': { kind: '精读批注', title: '同上 p.9 · 表 2', quote: 'capacity factor 1.25 reduces dropped tokens from 8.1% to 1.4% at +6% memory.', at: at(-2.25) },
  'ev-habit': { kind: '操作记录', title: '最近 4 次精读的阅读顺序', quote: '4 / 4 次先展开「图表」分层，平均停留 3 分 40 秒，之后才打开「方法」。', at: at(-5.1) },
  'ev-exam-u1': { kind: '考核', title: 'U1 考核 · 第 5 题（证明题）', quote: '设 e 和 e′ 都是单位元。e = e·e′ = e′。—— 评分：满分，按锁定 rubric。', at: at(-21) },
  'ev-exam-q4': { kind: '考核', title: 'U1 考核 · 第 4 题', quote: '选择正确，但解释写成了「因为子群大小相同」，没有提到陪集之间的双射。', at: at(-21) },
  'ev-dispute': { kind: '复核', title: '第 4 题异议复核', quote: '独立复核维持原判：结论对，理由不完整，扣 1 分。', at: at(-20.5) },
  'ev-pref': { kind: '学习记录', title: 'U1 课堂 · 讲解方式选择', quote: '5 次讲解里有 4 次你点了「先看例子」。', at: at(-24) },
  'ev-field-notes': { kind: '现场记录', title: '东山 · 回顾 · 实际时间线', quote: '16:41 到达八坂塔，转角已有 6 组人；16:20 前后的逆光已过最佳。', at: at(-30.5) },
  'ev-inc-11': { kind: '维护诊断', title: 'INC-11 · WF-01 空结果', quote: '对比 30 次运行：08:30 拉取 0 条的 3 次，当天条目都在 20:05 之后出现。', at: at(-9.2) },
};
const OLD: Record<string, SupersededView> = { 'mem-old-order': { id: 'mem-old-order', key: '精读的默认顺序', value: '先读摘要，再按章节顺序读。' } };

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
export function mockAdapter(): InboxAdapter {
  let promotions = PROMOTIONS.map(p => ({ ...p })), approvals = APPROVALS.map(a => ({ ...a }));
  return {
    async load() { await wait(160); return { promotions, approvals }; },
    async decidePromotion(id: string, _d: PromotionDecision) { await wait(220); promotions = promotions.filter(p => p.id !== id); },
    async decideApproval(id: string, decision: 'approve' | 'reject', answers?: string[][]) {
      await wait(220);
      const a = approvals.find(x => x.id === id);
      if (a?.kind === 'question' && decision === 'approve' && (!answers || answers.length !== a.questions?.length || answers.some(x => !x.length))) throw new Error('INVALID_ANSWER');
      approvals = approvals.filter(x => x.id !== id);
    },
    async evidence(ref: string) { await wait(120); const e = EVIDENCE[ref]; if (!e) throw new Error('EVIDENCE_NOT_FOUND'); return { ref, ...e }; },
    async superseded(id: string) { await wait(80); return OLD[id] ?? null; },
    async reports() {
      await wait(100);
      return [
        { id: 'rep-1', runId: 'run-r1', title: '精读完成：Attention Is All You Need', state: 'completed' as const, artifacts: 7, at: '今天 09:12', source: { bench: 'research', dossierId: 'd1', dossierTitle: '文献与实验', runId: 'run-r1', roleId: 'research-read' } },
        { id: 'rep-2', runId: 'run-r2', title: '精读中断：s1: Simple test-time scaling', state: 'interrupted' as const, reason: '服务重启后这一段执行已不在，可以重试。', artifacts: 2, at: '昨天 21:40', source: { bench: 'research', dossierId: 'd2', dossierTitle: '方法与证据', runId: 'run-r2', roleId: 'research-read' } },
      ];
    },
  };
}
