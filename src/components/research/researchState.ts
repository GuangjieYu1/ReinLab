export const RESEARCH_VERSION = 1;
export const MAX_DEMO_ROUNDS = 4;
export const MAX_RESEARCH_NOTES = 40;
export const MAX_RESEARCH_NOTE_LENGTH = 1200;
export const BASELINE_SCORE = 91.8;
export const RESEARCH_ARCHIVES = ['文献与实验', '方法与证据', '研究笔记'] as const;

export type ResearchLane = 'architecture' | 'optimizer' | 'schedule';
export type ResearchDecision = 'keep' | 'reject' | 'review';
export type ResearchNoteKind = 'note' | 'question';
export type ResearchExperiment = {
  id: string;
  lane: ResearchLane;
  round: number;
  title: string;
  hypothesis: string;
  change: string;
  score: number;
  latency: number;
  parameters: number;
  defaultDecision: ResearchDecision;
  evidence: string;
};
export type ResearchNote = {
  id: string;
  kind: ResearchNoteKind;
  text: string;
  experimentId: string;
  createdAt: number;
};
export type ResearchStore = {
  version: typeof RESEARCH_VERSION;
  archiveName: string;
  round: number;
  selectedId: string;
  decisions: Record<string, ResearchDecision>;
  notes: ResearchNote[];
  draft: string;
  draftKind: ResearchNoteKind;
};

export const researchLaneInfo: Record<ResearchLane, { name: string; researcher: string; letter: string; role: string }> = {
  architecture: { name: '模型结构', researcher: 'ASTER', letter: 'A', role: '结构研究员' },
  optimizer: { name: '优化策略', researcher: 'SAGE', letter: 'S', role: '优化研究员' },
  schedule: { name: '训练调度', researcher: 'IRIS', letter: 'I', role: '评估研究员' },
};

export const researchLanes: ResearchLane[] = ['architecture', 'optimizer', 'schedule'];

const initialExperiments: ResearchExperiment[] = [
  { id: 'EXP-001', lane: 'architecture', round: 0, title: '更深一点，更稳定一点', hypothesis: '增加残差连接，能否让更深的网络保持稳定？', change: '残差连接 · 6 → 8 层', score: 92.7, latency: 14.6, parameters: 3.2, defaultDecision: 'keep', evidence: '预设样例中，准确率增加 0.9 个百分点；同时记录了模型规模与延迟的增加，避免只看单一指标。' },
  { id: 'EXP-002', lane: 'optimizer', round: 0, title: '寻找更温和的更新', hypothesis: '降低权重衰减，能否减少欠拟合？', change: 'AdamW · weight decay 0.01', score: 93.4, latency: 14.8, parameters: 3.2, defaultDecision: 'keep', evidence: '这是一个既定的对照样例：固定结构与训练预算，只改变权重衰减。它不是本机真实训练结果。' },
  { id: 'EXP-003', lane: 'schedule', round: 0, title: '给收敛留一点余地', hypothesis: '线性预热是否足以改善最终表现？', change: 'Linear warmup · 1,000 steps', score: 93.1, latency: 14.8, parameters: 3.2, defaultDecision: 'reject', evidence: '预设准确率低于前一个保留方案。淘汰只表示本轮未进入共享最优，不删除假设与对照证据。' },
  { id: 'EXP-004', lane: 'architecture', round: 0, title: '让信息走一条短路', hypothesis: '用轻量残差模块替换宽连接，是否更有效？', change: 'Lightweight residual · width 128', score: 94.2, latency: 13.9, parameters: 2.8, defaultDecision: 'keep', evidence: '初始共享最优样例。准确率、延迟和参数量均来自演示数据，可将它作为下一轮的比较基准。' },
  { id: 'EXP-005', lane: 'optimizer', round: 0, title: '步长不是越大越好', hypothesis: '提高初始学习率，能否更快越过局部平台？', change: 'Learning rate · 0.003 → 0.006', score: 93.7, latency: 13.9, parameters: 2.8, defaultDecision: 'reject', evidence: '预设结果未超过当前共享最优。这个样例用于展示反例的保留，而不是宣称提高学习率通常无效。' },
  { id: 'EXP-006', lane: 'schedule', round: 0, title: '在最后一程放慢脚步', hypothesis: '余弦退火是否能带来更平滑的最终收敛？', change: 'Cosine decay · min lr 0.00001', score: 94, latency: 13.8, parameters: 2.8, defaultDecision: 'review', evidence: '等待你的判断。预设分数稍低于共享最优，但延迟略低；是否保留由你的研究取舍决定。' },
];

const roundTemplates = [
  { titles: ['只留下必要的连接', '让更新方向更一致', '把耐心留给后半程'], changes: ['Channel pruning · ratio 0.10', 'AdamW · β₂ 0.98', 'Cosine decay · warmup 1,600'], hypotheses: ['轻量剪枝能否在不损失准确率的前提下降低延迟？', '调整二阶动量能否缓解波动？', '更长预热能否改善最终表现？'], scores: [94.5, 93.8, 94.4], latency: [12.6, 13.9, 13.7], parameters: [2.5, 2.8, 2.8] },
  { titles: ['给特征一次重新组合', '在噪声中保持方向', '让步长跟随证据'], changes: ['Gated residual · width 128', 'Gradient clipping · norm 1.0', 'Plateau decay · patience 3'], hypotheses: ['轻量门控能否改善特征融合？', '梯度裁剪能否使评估结果更稳定？', '平台期调度是否优于固定曲线？'], scores: [95, 94.7, 94.1], latency: [13.1, 12.7, 12.6], parameters: [2.7, 2.5, 2.5] },
  { titles: ['少一层，多一份余地', '让正则更有分寸', '对照更短的训练旅程'], changes: ['Residual depth · 8 → 7', 'Weight decay · 0.008', 'Training budget · 14,000'], hypotheses: ['减少一层，是否能保留主要收益？', '更细的正则设置是否能提升验证表现？', '缩短预算会带来多大代价？'], scores: [94.8, 95.2, 94.6], latency: [12.2, 13.1, 13.1], parameters: [2.4, 2.7, 2.7] },
  { titles: ['把轻量与表达放在一起', '再检验一次更新尺度', '为下一次研究留出起点'], changes: ['Hybrid residual · width 112', 'Learning rate · 0.0025', 'Cosine restarts · period 4,000'], hypotheses: ['混合宽度是否能平衡表达力与效率？', '较小学习率的收益是否足够明显？', '周期重启是否值得增加调度复杂度？'], scores: [95.4, 95.1, 95], latency: [12.4, 13.1, 13.2], parameters: [2.5, 2.7, 2.7] },
];

export function normalizeResearchArchive(archiveName: string) {
  return archiveName.trim().normalize('NFC').slice(0, 160) || '文献与实验';
}

export function researchStorageKey(archiveName: string) {
  return `reinlab-research-lab-v1:${encodeURIComponent(normalizeResearchArchive(archiveName))}`;
}

export function researchExperiments(round = 0): ResearchExperiment[] {
  const boundedRound = Number.isInteger(round) ? Math.max(0, Math.min(MAX_DEMO_ROUNDS, round)) : 0;
  const experiments = initialExperiments.map(experiment => ({ ...experiment }));
  let best = 94.2;
  for (let index = 0; index < boundedRound; index++) {
    const template = roundTemplates[index];
    researchLanes.forEach((lane, laneIndex) => {
      const score = template.scores[laneIndex];
      const defaultDecision = score > best ? 'keep' : 'reject';
      best = Math.max(best, score);
      experiments.push({
        id: `EXP-${String(7 + index * 3 + laneIndex).padStart(3, '0')}`,
        lane,
        round: index + 1,
        title: template.titles[laneIndex],
        hypothesis: template.hypotheses[laneIndex],
        change: template.changes[laneIndex],
        score,
        latency: template.latency[laneIndex],
        parameters: template.parameters[laneIndex],
        defaultDecision,
        evidence: `第 ${index + 1} 轮固定演示样例。验证准确率 ${score.toFixed(1)}%，延迟 ${template.latency[laneIndex].toFixed(1)} ms；这些数字用于说明研究工作流，并非实际模型、工具或训练产生的结果。`,
      });
    });
  }
  return experiments;
}

export function freshResearch(archiveName: string): ResearchStore {
  return {
    version: RESEARCH_VERSION,
    archiveName: normalizeResearchArchive(archiveName),
    round: 0,
    selectedId: 'EXP-004',
    decisions: {},
    notes: [],
    draft: '',
    draftKind: 'note',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDecision(value: unknown): value is ResearchDecision {
  return value === 'keep' || value === 'reject' || value === 'review';
}

export function isResearchStore(value: unknown, archiveName: string): value is ResearchStore {
  if (!isRecord(value) || value.version !== RESEARCH_VERSION ||
    value.archiveName !== normalizeResearchArchive(archiveName) ||
    !Number.isInteger(value.round) || typeof value.round !== 'number' || value.round < 0 || value.round > MAX_DEMO_ROUNDS ||
    typeof value.selectedId !== 'string' || !isRecord(value.decisions) ||
    !Array.isArray(value.notes) || value.notes.length > MAX_RESEARCH_NOTES ||
    typeof value.draft !== 'string' || value.draft.length > MAX_RESEARCH_NOTE_LENGTH ||
    (value.draftKind !== 'note' && value.draftKind !== 'question')) return false;
  const ids = new Set(researchExperiments(value.round).map(experiment => experiment.id));
  if (!ids.has(value.selectedId) || Object.entries(value.decisions).some(([id, decision]) => !ids.has(id) || !isDecision(decision))) return false;
  const noteIds = new Set<string>();
  return value.notes.every(note => {
    if (!isRecord(note) || typeof note.id !== 'string' || !note.id || note.id.length > 100 || noteIds.has(note.id) ||
      (note.kind !== 'note' && note.kind !== 'question') ||
      typeof note.text !== 'string' || !note.text.trim() || note.text.length > MAX_RESEARCH_NOTE_LENGTH ||
      typeof note.experimentId !== 'string' || !ids.has(note.experimentId) ||
      typeof note.createdAt !== 'number' || !Number.isFinite(note.createdAt) || note.createdAt < 0 || note.createdAt > 8.64e15) return false;
    noteIds.add(note.id);
    return true;
  });
}

export function researchDecision(store: ResearchStore, experiment: ResearchExperiment): ResearchDecision {
  return store.decisions[experiment.id] ?? experiment.defaultDecision;
}

export function researchChampion(store: ResearchStore): ResearchExperiment | null {
  return researchExperiments(store.round).filter(experiment => researchDecision(store, experiment) === 'keep')
    .reduce<ResearchExperiment | null>((best, experiment) => experiment.score > (best?.score ?? BASELINE_SCORE) ? experiment : best, null);
}

export function researchTrend(store: ResearchStore) {
  let best = BASELINE_SCORE;
  return [
    { id: 'baseline', score: BASELINE_SCORE },
    ...researchExperiments(store.round).map(experiment => {
      if (researchDecision(store, experiment) === 'keep') best = Math.max(best, experiment.score);
      return { id: experiment.id, score: best };
    }),
  ];
}

export function decideResearchExperiment(store: ResearchStore, id: string, decision: ResearchDecision): ResearchStore {
  if (!isDecision(decision) || !researchExperiments(store.round).some(experiment => experiment.id === id)) return store;
  return { ...store, decisions: { ...store.decisions, [id]: decision } };
}

export function completeResearchDemo(store: ResearchStore): ResearchStore {
  if (store.round >= MAX_DEMO_ROUNDS) return store;
  const round = store.round + 1;
  return { ...store, round, selectedId: `EXP-${String(7 + store.round * 3).padStart(3, '0')}` };
}

export function addResearchNote(store: ResearchStore, input: { id: string; createdAt: number }): ResearchStore {
  const text = store.draft.trim().slice(0, MAX_RESEARCH_NOTE_LENGTH);
  if (!text || !input.id || input.id.length > 100 || store.notes.some(note => note.id === input.id) ||
    !Number.isFinite(input.createdAt) || input.createdAt < 0 || input.createdAt > 8.64e15 ||
    store.notes.length >= MAX_RESEARCH_NOTES) return store;
  return { ...store, draft: '', notes: [...store.notes, { ...input, text, kind: store.draftKind, experimentId: store.selectedId }] };
}

export function researchMarkdown(store: ResearchStore) {
  const champion = researchChampion(store);
  return [
    `# ${store.archiveName} · AI 研究实验室`,
    '',
    '> 本地交互演示。实验、指标与研究员讨论均为预设示例，不是实际 AI 调用或训练结果。手记与问题为使用者自己的文字。',
    '',
    `当前共享最优：${champion?.id ?? 'BASELINE'} · ${(champion?.score ?? BASELINE_SCORE).toFixed(1)}%`,
    `已展开演示轮次：${store.round} / ${MAX_DEMO_ROUNDS}`,
    '',
    '## 实验记录',
    '',
    '| 实验 | 方向 | 假设 | 示例准确率 | 当前决定 |',
    '| --- | --- | --- | --- | --- |',
    ...researchExperiments(store.round).map(experiment => `| ${experiment.id} | ${researchLaneInfo[experiment.lane].name} | ${experiment.hypothesis} | ${experiment.score.toFixed(1)}% | ${researchDecision(store, experiment).toUpperCase()} |`),
    '',
    '## 我的研究手记',
    '',
    ...store.notes.flatMap(note => [
      `### ${note.kind === 'question' ? '待研究问题' : '研究手记'} · ${note.experimentId}`,
      '',
      note.text,
      '',
    ]),
    ...(store.draft ? ['## 未提交草稿', '', store.draft, ''] : []),
  ].join('\n');
}
