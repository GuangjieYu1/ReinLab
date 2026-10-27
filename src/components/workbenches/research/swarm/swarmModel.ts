// 研究台 · 群研模式的示例剧本（纯前端）。32 个 agent、7 种消息；整个状态只由「当前时刻」推出，所以可以拖动回放。

export type Role = 'lead' | 'plan' | 'scout' | 'read' | 'analyst' | 'critic' | 'verify' | 'synth';
export const ROLES: Record<Role, { zh: string; en: string; tag: string }> = {
  lead: { zh: '总负责人', en: 'LEAD', tag: 'L' }, plan: { zh: '拆解', en: 'PLANNER', tag: 'P' }, scout: { zh: '搜索', en: 'SCOUT', tag: 'S' },
  read: { zh: '阅读', en: 'READER', tag: 'R' }, analyst: { zh: '分析', en: 'ANALYST', tag: 'A' }, critic: { zh: '反驳', en: 'CRITIC', tag: 'C' },
  verify: { zh: '核实', en: 'VERIFIER', tag: 'V' }, synth: { zh: '汇总', en: 'SYNTH', tag: 'Y' },
};
export type Agent = { id: string; role: Role; name: string };
const make = (role: Role, n: number): Agent[] => Array.from({ length: n }, (_, i) => ({ id: `${ROLES[role].tag}${n > 1 ? String(i + 1).padStart(2, '0') : ''}`, role, name: `${ROLES[role].zh}${n > 1 ? ` ${String(i + 1).padStart(2, '0')}` : ''}` }));
export const AGENTS: Agent[] = [...make('lead', 1), ...make('plan', 2), ...make('scout', 10), ...make('read', 10), ...make('analyst', 3), ...make('critic', 3), ...make('verify', 2), ...make('synth', 1)];
export const agent = (id: string) => AGENTS.find(a => a.id === id);

export type MsgType = 'broadcast' | 'claim' | 'ask' | 'deliver' | 'help' | 'handoff' | 'refute';
export const MSG: Record<MsgType, { zh: string; glyph: string; desc: string }> = {
  broadcast: { zh: '广播', glyph: '◎', desc: '一对所有：发布任务、公告决定。所有人都能收到，没有指定接收者。' },
  claim: { zh: '领取', glyph: '✋', desc: '「这个我来」：认领一个开放任务，避免两个 agent 做重复的事。' },
  ask: { zh: '提问', glyph: '?', desc: '点对点：向某个 agent 要一条具体信息，对方用「交付」回答。' },
  deliver: { zh: '交付', glyph: '↳', desc: '交出结果：摘要、核实结论、汇总稿。交付后对应任务前进一格。' },
  help: { zh: '求助', glyph: '!', desc: '卡住了：发到留言板，谁能帮谁接，不指定人。' },
  handoff: { zh: '转交', glyph: '⇢', desc: '接力：把自己做完的半成品交给下一棒（搜索 → 阅读 → 核实）。' },
  refute: { zh: '反驳', glyph: '✕', desc: '质疑某个结论，附理由。被反驳的结论要么补证据，要么降级为「局限」。' },
};

export type TaskStatus = 'open' | 'doing' | 'done' | 'failed' | 'limit';
export type Task = { id: string; parent?: string; title: string; kind: 'root' | 'sub' | 'search' | 'read' | 'verify' | 'extra' };
export type Msg = { id: string; t: number; from: string; to: string; type: MsgType; text: string; task?: string; set?: [string, TaskStatus][]; post?: Post['col'] };
export type Post = { id: string; t: number; by: string; col: 'question' | 'finding' | 'help' | 'decision'; text: string; reply?: string };

/** 六个子问题（方法名与要点均为通用概括）。 */
export const SUBS = [
  { id: 'Q1', title: '稀疏注意力', method: 'Longformer / BigBird', idea: '每个字只看附近的窗口，外加少量全局字；计算量随长度线性增长。', cost: 'O(n·w)', exact: '近似', trade: '远距离信息要靠全局字中转' },
  { id: 'Q2', title: '线性 / 核注意力', method: 'Linear Transformer / Performer', idea: '用核函数近似 softmax，把「先算 QKᵀ」改成「先算 KᵀV」，避开 n×n 矩阵。', cost: 'O(n·d²)', exact: '近似', trade: '在需要精确查找的任务上质量会下降' },
  { id: 'Q3', title: '低秩压缩', method: 'Linformer', idea: '把长度为 n 的键和值投影到固定长度 k，注意力矩阵变成 n×k。', cost: 'O(n·k)', exact: '近似', trade: '依赖「注意力矩阵近似低秩」的假设' },
  { id: 'Q4', title: '状态空间 / 循环', method: 'Mamba / RWKV 等', idea: '回到「带状态逐步读」的思路，但设计成可并行训练；推理时每步代价固定。', cost: 'O(n)', exact: '不同架构', trade: '不是注意力，精确回忆远处细节较弱' },
  { id: 'Q5', title: '系统层优化', method: 'FlashAttention', idea: '数学上仍是精确注意力，通过分块计算减少显存读写；显存随长度线性增长。', cost: 'O(n²) 计算 · O(n) 显存', exact: '精确', trade: '计算量本身仍是平方' },
  { id: 'Q6', title: '长度外推', method: 'ALiBi / RoPE 插值', idea: '让训练时较短的模型在推理时处理更长的输入：改造位置信息而不是注意力本身。', cost: '不改变', exact: '精确', trade: '外推太远时效果会衰减' },
];

export const TASKS: Task[] = [
  { id: 'ROOT', title: '注意力计算量随长度平方增长，后续工作如何解决长文本？', kind: 'root' },
  ...SUBS.flatMap(s => [
    { id: s.id, parent: 'ROOT', title: s.title, kind: 'sub' as const },
    { id: `${s.id}-S`, parent: s.id, title: '搜索文献', kind: 'search' as const },
    { id: `${s.id}-R`, parent: s.id, title: '阅读与摘要', kind: 'read' as const },
    { id: `${s.id}-V`, parent: s.id, title: '核实复杂度', kind: 'verify' as const },
  ]),
  { id: 'X1', parent: 'ROOT', title: '注意力蒸馏能否解决长文本？', kind: 'extra' },
];

/* ———— 剧本 ———— */
let n = 0;
const m = (t: number, from: string, to: string, type: MsgType, text: string, extra: Partial<Msg> = {}): Msg => ({ id: `m${++n}`, t, from, to, type, text, ...extra });
const S = (i: number) => `S${String(i).padStart(2, '0')}`, R = (i: number) => `R${String(i).padStart(2, '0')}`;
function script(): Msg[] {
  const out: Msg[] = [
    m(0, 'L', 'all', 'broadcast', '新问题：注意力计算量随长度平方增长，后续工作如何解决长文本？拆解组先出任务树。', { set: [['ROOT', 'doing']] }),
    m(1.2, 'P01', 'L', 'claim', '我来拆解。'),
    m(3.4, 'P01', 'L', 'deliver', '按「改了什么」拆成 6 个子问题：稀疏、线性 / 核、低秩、状态空间、系统优化、长度外推。每个子问题走 搜索 → 阅读 → 核实。'),
    m(4.2, 'L', 'board', 'broadcast', '决定：比较维度统一为 计算量 · 是否精确 · 代价。', { post: 'decision' }),
  ];
  SUBS.forEach((s, i) => {
    const t0 = 5 + i * 7.5, a = S(i * 2 + 1), b = S(i * 2 + 2 > 10 ? 1 : i * 2 + 2), r = R(i + 1), r2 = R(i + 5 > 10 ? 10 : i + 5), crit = `C0${(i % 3) + 1}`, ver = `V0${(i % 2) + 1}`, an = `A0${(i % 3) + 1}`;
    out.push(
      m(t0, 'P02', 'all', 'broadcast', `开放任务 ${s.id}：${s.title}。`, { task: s.id, set: [[s.id, 'open'], [`${s.id}-S`, 'open']] }),
      m(t0 + .8, a, 'P02', 'claim', `${s.id} 的搜索我来。`, { task: `${s.id}-S`, set: [[s.id, 'doing'], [`${s.id}-S`, 'doing']] }),
      m(t0 + 1.1, b, 'P02', 'claim', `我也搜 ${s.id}，换关键词分头找。`, { task: `${s.id}-S` }),
      m(t0 + 3.2, a, r, 'handoff', `${s.id} 找到核心工作：${s.method}，附 2 篇后续。交给你读。`, { task: `${s.id}-R`, set: [[`${s.id}-S`, 'done'], [`${s.id}-R`, 'doing']] }),
      m(t0 + 4.0, r, a, 'ask', `${s.method} 有没有官方实现？我想核对实现细节。`, { task: `${s.id}-R` }),
      m(t0 + 4.6, a, r, 'deliver', '有，已附代码链接与对应论文段落。', { task: `${s.id}-R` }),
      m(t0 + 6.0, r, 'Y', 'deliver', `${s.id} 摘要：${s.idea}`, { task: `${s.id}-R`, set: [[`${s.id}-R`, 'done'], [`${s.id}-V`, 'doing']] }),
      m(t0 + 6.2, r, 'board', 'deliver', `${s.title}：${s.idea}`, { post: 'finding' }),
    );
    if (s.id === 'Q2') out.push(m(t0 + 6.8, crit, r, 'refute', '「线性注意力等价于 softmax 注意力」说得太满：它是近似，在需要精确查找的任务上质量下降。', { task: 'Q2' }), m(t0 + 7.6, r, crit, 'deliver', '同意，已在摘要里改成「近似」，并补上一条质量下降的证据。', { task: 'Q2' }));
    if (s.id === 'Q3') out.push(m(t0 + 6.8, crit, r, 'refute', '低秩假设在长依赖任务上未必成立，不能当成通用结论。', { task: 'Q3' }), m(t0 + 7.4, 'L', 'board', 'broadcast', '决定：Q3 的结论降级为「有前提的方法」，写进局限。', { post: 'decision', set: [['Q3', 'limit']] }));
    if (s.id === 'Q5') out.push(m(t0 + 5.0, r2, 'board', 'help', 'FlashAttention 的显存是线性还是平方？两篇资料说法不一，求核实。', { post: 'help' }), m(t0 + 5.8, an, r2, 'deliver', '计算量仍是平方，但不需要存完整的 n×n 矩阵，所以显存是线性的；两种说法分别指计算和显存。', { task: `${s.id}-R` }));
    out.push(m(t0 + 7.2, ver, 'L', 'deliver', `核实 ${s.id}：${s.cost} · ${s.exact}。`, { task: `${s.id}-V`, set: [[`${s.id}-V`, 'done'], ...(s.id === 'Q3' ? [] : [[s.id, 'done'] as [string, TaskStatus]])] }));
  });
  out.push(
    m(14, 'S10', 'P02', 'claim', '我去查「注意力蒸馏」这条路。', { task: 'X1', set: [['X1', 'doing']] }),
    m(31, 'S10', 'board', 'help', '「注意力蒸馏」没有找到直接解决长文本的工作，大多是压缩模型大小。', { post: 'question' }),
    m(32, 'L', 'S10', 'deliver', '这条路标记为失败路径，保留记录，不再投入。', { task: 'X1', set: [['X1', 'failed']] }),
    m(36, 'A01', 'board', 'deliver', '共性：所有方法要么减少「谁看谁」（稀疏、低秩），要么改写计算顺序（线性），要么换掉注意力（状态空间），要么不改数学只改实现（系统层）。', { post: 'finding' }),
    m(40, 'C02', 'A01', 'refute', '长度外推不属于这四类：它不降低计算量，只让模型能用更长的上下文。', {}),
    m(41, 'A01', 'C02', 'deliver', '对，补成第五类「改位置信息」。'),
    m(52, 'Y', 'L', 'deliver', '汇总稿完成：5 类方法、6 张卡片、2 条局限、1 条失败路径。', { set: [['ROOT', 'done']] }),
    m(53, 'L', 'all', 'broadcast', '结论已发布到「汇总」。可量化的子任务（长文本速度对比）建议交给自研。', { post: 'decision' }),
  );
  return out.sort((x, y) => x.t - y.t);
}
export const SCRIPT = script();
export const DURATION = 56;

/** 由当前时刻推出状态。 */
export function stateAt(now: number, msgs: Msg[]) {
  const seen = msgs.filter(x => x.t <= now);
  const status: Record<string, TaskStatus> = {};
  seen.forEach(x => x.set?.forEach(([id, s]) => { status[id] = s; }));
  const busy: Record<string, { task?: string; type: MsgType; t: number }> = {};
  seen.forEach(x => { if (x.from !== 'L' || x.type !== 'broadcast') busy[x.from] = { task: x.task, type: x.type, t: x.t }; });
  const posts: Post[] = seen.filter(x => x.post).map(x => ({ id: x.id, t: x.t, by: x.from, col: x.post!, text: x.text }));
  return { seen, status, busy, posts };
}
