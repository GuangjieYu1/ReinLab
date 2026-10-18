// 研究台的示例数据与本地模拟（纯前端）。
// 定题：对话逐轮填满研究简报；运行：参照 karpathy/autoresearch「改代码 → 训练 → 评估 → 保留或回滚 → 记一行」。

export type Cat = 'arch' | 'opt' | 'sched' | 'data' | 'reg';
export const CAT: Record<Cat, string> = { arch: '结构', opt: '优化器', sched: '调度', data: '数据', reg: '正则' };
export type Idea = { title: string; cat: Cat; effect: number; diff: [string, string]; paper?: string };
export const IDEAS: Idea[] = [
  { title: 'warmup 600 → 1200 步', cat: 'sched', effect: -.0032, diff: ['warmup_steps = 600', 'warmup_steps = 1200'] },
  { title: 'LayerNorm 换成 RMSNorm', cat: 'arch', effect: -.0018, diff: ['norm = nn.LayerNorm(d)', 'norm = RMSNorm(d)'] },
  { title: '层数 12 → 14，宽度 768 → 704', cat: 'arch', effect: .0012, diff: ['n_layer, d = 12, 768', 'n_layer, d = 14, 704'] },
  { title: 'AdamW β₂ 0.95 → 0.98', cat: 'opt', effect: -.0009, diff: ['betas = (0.9, 0.95)', 'betas = (0.9, 0.98)'] },
  { title: '加入 QK-Norm', cat: 'arch', effect: -.0041, diff: ['q, k = q, k', 'q, k = qk_norm(q), qk_norm(k)'], paper: 'QK-Norm (Dehghani 2023)' },
  { title: '余弦调度改为 WSD', cat: 'sched', effect: -.0047, diff: ["schedule = 'cosine'", "schedule = 'wsd'  # decay 20%"], paper: 'WSD 调度 (Hu 2024)' },
  { title: '梯度裁剪 1.0 → 0.5', cat: 'opt', effect: .0004, diff: ['clip_grad = 1.0', 'clip_grad = 0.5'] },
  { title: '去掉 dropout', cat: 'reg', effect: -.0021, diff: ['dropout = 0.1', 'dropout = 0.0'], paper: 'nanoGPT speedrun 记录' },
  { title: 'SwiGLU 激活', cat: 'arch', effect: -.0026, diff: ['act = nn.GELU()', 'act = SwiGLU(d, 4 * d)'] },
  { title: '权重衰减 0.1 → 0.05', cat: 'reg', effect: .0006, diff: ['weight_decay = 0.1', 'weight_decay = 0.05'] },
  { title: 'batch 256 → 384', cat: 'data', effect: .0015, diff: ['batch_size = 256', 'batch_size = 384'] },
  { title: 'RoPE base 10k → 50k', cat: 'arch', effect: -.0007, diff: ['rope_base = 10_000', 'rope_base = 50_000'] },
  { title: '学习率 3e-4 → 6e-4', cat: 'opt', effect: -.0013, diff: ['lr = 3e-4', 'lr = 6e-4'] },
  { title: '去重后的数据顺序', cat: 'data', effect: -.0011, diff: ['loader = shuffle(raw)', 'loader = shuffle(dedup(raw))'] },
  { title: '嵌入层与输出层共享权重', cat: 'arch', effect: -.0005, diff: ['lm_head = Linear(d, V)', 'lm_head.weight = wte.weight'] },
  { title: 'Lion 替换 AdamW', cat: 'opt', effect: .0024, diff: ['opt = AdamW(params, lr)', 'opt = Lion(params, lr / 3)'] },
];

export type BriefKey = 'question' | 'hypothesis' | 'metric' | 'scope' | 'budget' | 'compute';
export const BRIEF_FIELDS: { key: BriefKey; label: string; en: string }[] = [
  { key: 'question', label: '问题', en: 'QUESTION' }, { key: 'hypothesis', label: '假设', en: 'HYPOTHESIS' }, { key: 'metric', label: '指标', en: 'METRIC' },
  { key: 'scope', label: '约束', en: 'CONSTRAINTS' }, { key: 'budget', label: '预算', en: 'BUDGET' }, { key: 'compute', label: '算力位置', en: 'COMPUTE' },
];
export type Topic = { ask: string; question: string; hypothesis: string; metric: string; baseline: number; papers: string[]; ideas: Idea[]; seeded: number };
export const TOPICS: Topic[] = [
  { ask: '我想看看文献里那几个训练技巧，在我们的小模型上还成不成立。', question: '文献中的训练技巧，在 124M 小模型上能否复现收益？', hypothesis: 'QK-Norm、WSD、去 dropout 各自能降低 val_bpb，组合后收益可叠加但递减。', metric: 'val_bpb', baseline: 1.0212, papers: ['nanoGPT speedrun 记录', 'QK-Norm (Dehghani 2023)', 'WSD 调度 (Hu 2024)'], ideas: IDEAS, seeded: 0 },
  { ask: '帮我找一个能区分“记住”和“理解”的评估方法。', question: '哪种评估信号最能区分记忆与泛化？', hypothesis: '反事实扰动比留出集更早暴露记忆。', metric: 'gap_score', baseline: .412, papers: ['Counterfactual eval (2024)', 'Perturbation tests', 'Held-out canaries'], ideas: IDEAS.slice(4).concat(IDEAS.slice(0, 4)), seeded: 0 },
  { ask: '固定计算预算下，模型结构的收益是不是依赖优化方法？', question: '固定 1×10¹⁸ FLOPs 预算下，结构改动的收益是否依赖优化方法与调度？', hypothesis: '结构改动的收益在 WSD 调度下更稳定。', metric: 'val_bpb', baseline: .9984, papers: ['autoresearch (Karpathy 2026)', 'Scaling optimizers (2025)', 'μP transfer notes'], ideas: IDEAS, seeded: 23 },
  { ask: '把研究笔记里反复出现的问题挑出来，能自动跑的就先跑。', question: '研究笔记中的开放问题，哪些可以转成可自动检验的实验？', hypothesis: '至少一半的开放问题可以在 5 分钟内自动检验。', metric: 'val_bpb', baseline: 1.0045, papers: ['研究笔记 · 12 条', 'R—014 档案', 'P—013 观察记录'], ideas: IDEAS.slice(8).concat(IDEAS.slice(0, 8)), seeded: 0 },
];

/** 定题的几轮对话：每轮回答一个问题，填一部分简报。 */
export type Step = { k: 'think' | 'search' | 'read' | 'run' | 'write'; text: string; detail?: string };
export type ScopeRound = { fills: Partial<Record<BriefKey, string>>; steps: Step[]; say: string; ask?: { q: string; chips: string[] } };
export function scopeRounds(t: Topic): ScopeRound[] {
  return [
    { fills: { question: t.question, hypothesis: t.hypothesis, metric: `${t.metric} · 越低越好 · 基线 ${t.baseline.toFixed(4)} ± 0.0006（3 个种子）` },
      steps: [{ k: 'think', text: '把问题拆成可检验的形式', detail: '每个技巧单独一组对照，指标固定为验证集 bits-per-byte。' }, { k: 'search', text: `检索 ${t.papers.length} 篇相关文献`, detail: t.papers.join(' · ') }, { k: 'read', text: '读取 train.py · 412 行', detail: 'AdamW · 余弦调度 · dropout 0.1 · 12 层 × 768' }, { k: 'run', text: '跑 3 次基线', detail: `${t.metric} = ${t.baseline.toFixed(4)} ± 0.0006 · 每次 5 分 02 秒` }, { k: 'write', text: '写入简报 · 问题 / 假设 / 指标' }],
      say: '基线已经跑过 3 次，波动约 0.0006——小于这个量的改进我会当作噪声。', ask: { q: '实验允许改动哪些文件？', chips: ['只改 train.py，不改评测', '允许改 train.py 与 model.py'] } },
    { fills: { scope: '' }, steps: [{ k: 'think', text: '确定改动边界与防作弊规则', detail: 'prepare.py 与评测脚本只读；每次实验只允许一处改动，便于归因。' }, { k: 'write', text: '写入简报 · 约束' }],
      say: '评测脚本我会锁成只读，避免“改评测刷分”。', ask: { q: '预算多少？超过 50% 和 80% 时我会停下来等你批准。', chips: ['8 GPU·h · 最多 96 次 · 每次 5 分钟', '4 GPU·h · 最多 48 次 · 每次 5 分钟'] } },
    { fills: { budget: '' }, steps: [{ k: 'think', text: '估算总次数与审批线', detail: '每次 5 分钟训练 + 20 秒评估。' }, { k: 'write', text: '写入简报 · 预算' }],
      say: '审批线设在 50% 与 80%。', ask: { q: '在哪里跑？', chips: ['本机 · 1×4090', '远程 · 8×H100（需审批）'] } },
    { fills: { compute: '' }, steps: [{ k: 'run', text: '检查算力', detail: 'nvidia-smi · 显存 24 GB · 空闲' }, { k: 'write', text: '写入简报 · 算力位置' }],
      say: '简报已经齐了。签发之后我会进入运行，你在 program.md 里写的研究指令随时生效。' },
  ];
}

/* ———— 循环 ———— */
export type Exp = { n: number; idea: Idea; value: number; kept: boolean; delta: number };
export function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
export function nextExperiment(t: Topic, done: Exp[], rand: () => number, only?: Cat | null): Exp {
  const n = done.length + 1;
  const pool = only ? t.ideas.filter(i => i.cat === only) : t.ideas;
  const idea = pool[(n * 7 + Math.floor(rand() * 3)) % pool.length];
  const best = done.reduce((b, e) => e.kept ? Math.min(b, e.value) : b, t.baseline);
  const tried = done.filter(e => e.idea === idea && e.kept).length;
  const value = best + idea.effect * (tried ? .25 : 1) * (.6 + rand() * .8) + (rand() - .5) * .0018;
  const kept = value < best - .0004;
  return { n, idea, value, kept, delta: value - best };
}
export const PHASES = ['提出', '改代码', '训练', '评估', '取舍'];
export const BUDGET = { gpuHours: 8, cap: 96, minutes: 5 };
export const PROGRAM = `# program.md · 研究指令
目标：在不改评测的前提下降低 val_bpb。

- 每次只改一处，便于归因
- 先试文献里的技巧：QK-Norm、WSD、去 dropout
- 改进小于 0.0004 视为噪声，回滚
- 连续 8 次没有改进时，换一个类别
`;
