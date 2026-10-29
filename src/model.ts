export type Platform = 'research' | 'learning' | 'engineering' | 'travel';
export type Mode = 'document' | 'slides';
export type Page = 'home' | 'projects' | 'workspace' | 'conversation' | 'research-lab' | 'studio' | 'learning' | 'learning-course';

export const platforms: { id: Platform; title: string; english: string; code: string; desc: string; project: string; workspace: string; unit: string }[] = [
  { id: 'research', title: 'AI 研究实验室', english: 'RESEARCH', code: '01', desc: '让假设、实验与证据持续对话', project: '人机协作 · 探索研究', workspace: '文献与实验', unit: '可解释性研究' },
  { id: 'learning', title: '学习平台', english: 'LEARNING', code: '02', desc: '让知识连接，让理解发生', project: '机器学习 · 知识构建', workspace: '线性代数', unit: '特征值与特征向量' },
  { id: 'engineering', title: '工程与项目', english: 'ENGINEERING', code: '03', desc: '把想法，变成可以运行的事物', project: 'ReinLab · 工作台设计', workspace: '交互设计', unit: '档案交互原型' },
  { id: 'travel', title: '旅行平台', english: 'EXPLORATION', code: '04', desc: '保持好奇，探索更远的世界', project: '京都 · 秋日观察计划', workspace: '路线与灵感', unit: '城市漫步路线' },
];

export interface Turn {
  id: string;
  parent: string | null;
  title: string;
  prompt: string;
  body: string;
  kind: 'intro' | 'geometry' | 'practice' | 'summary' | 'custom';
  status: 'complete' | 'running' | 'stopped';
}

export const initialTurns = (platform: Platform): Turn[] => platform === 'learning' ? [
  { id: '01', parent: null, title: '建立直觉', prompt: '用直观的方式解释特征值和特征向量。', body: '线性变换会让大多数向量改变方向。但有一些向量，变换后依然沿着原来的直线。这些特殊的方向，就是特征向量；沿着它们伸缩的倍数，就是特征值。', kind: 'intro', status: 'complete' },
  { id: '02', parent: '01', title: '从几何视角理解', prompt: '我想从几何角度理解，可以给我一个能够操作的例子吗？', body: '先不急着计算。把矩阵想象成一个改变空间的装置：它可以拉伸、压缩，也可以旋转。观察哪些方向在变换之后保持不变，就找到了理解特征向量的入口。', kind: 'geometry', status: 'complete' },
  { id: '03', parent: '02', title: '用一个例子验证', prompt: '用一个简单矩阵验证这个结论。', body: '考虑对角矩阵 A = diag(λ, 1)。水平方向的向量被拉伸到原来的 λ 倍，竖直方向保持不变。这两个坐标轴方向都是特征向量。', kind: 'practice', status: 'complete' },
  { id: '04', parent: '02', title: '整理学习笔记', prompt: '换个分支，把几何直觉整理成学习笔记。', body: '特征向量回答的是“哪些方向保持不变”，特征值回答的是“沿这些方向改变多少”。先观察空间中的方向，再用 Av = λv 检验，可以让公式和直觉建立连接。', kind: 'summary', status: 'complete' },
] : [
  { id: '01', parent: null, title: '定义目标与边界', prompt: `为「${platforms.find(p => p.id === platform)!.unit}」建立一份清晰的探索计划。`, body: '从问题本身出发，先明确想要得到的结果，再收集可以支持判断的材料。这份档案保留每一次探索的路径，让结论与过程始终能够相互追溯。', kind: 'intro', status: 'complete' },
  { id: '02', parent: '01', title: '构建第一版方案', prompt: '把这个目标整理成可执行的方案，并标出待确认的部分。', body: '将探索分成观察、比较与验证三个阶段。先记录已知信息，再并列不同方案，最后用一个小规模尝试验证最关键的假设。下方内容为设计原型示例，不代表真实检索或执行结果。', kind: 'summary', status: 'complete' },
  { id: '03', parent: '02', title: '检查关键假设', prompt: '哪些假设需要优先验证？', body: '优先验证那些一旦不成立，就会改变整个方案的假设。为每条假设记录证据、验证方式和接受条件，再决定是否继续投入。', kind: 'practice', status: 'complete' },
];

export interface Template {
  id: string;
  name: string;
  description: string;
  platform: Platform;
  mode: Mode;
  accent: 'sage' | 'amber' | 'slate';
  modules: string[];
  workspaceLabel: string;
  unitLabel: string;
}

export const defaultTemplate: Template = {
  id: 'learning-v1',
  name: '知识探索',
  description: '建立知识之间的连接，让每一次学习都有迹可循。',
  platform: 'learning',
  mode: 'document',
  accent: 'sage',
  modules: ['知识路径', '学习进度', '工作区档案'],
  workspaceLabel: '学习档案',
  unitLabel: '学习单元',
};

export function buildTree(turns: Turn[]): { turn: Turn; depth: number }[] {
  const result: { turn: Turn; depth: number }[] = [];
  const seen = new Set<string>();
  function visit(parent: string | null, depth: number) {
    for (const turn of turns.filter(t => t.parent === parent)) {
      if (seen.has(turn.id)) continue;
      seen.add(turn.id);
      result.push({ turn, depth });
      visit(turn.id, depth + 1);
    }
  }
  visit(null, 0);
  return result;
}

export function newTurn(turns: Turn[], parent: string | null, prompt: string): Turn {
  const id = String(Math.max(0, ...turns.map(t => Number(t.id))) + 1).padStart(2, '0');
  return { id, parent, prompt, title: prompt.trim().slice(0, 15), kind: 'custom', status: 'running', body: '' };
}

export function readStored<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return validate(value) ? value : fallback;
  } catch { return fallback; }
}

export const isTemplate = (value: unknown): value is Template => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Template>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.description === 'string'
    && ['research', 'learning', 'engineering', 'travel'].includes(v.platform ?? '')
    && ['document', 'slides'].includes(v.mode ?? '') && ['sage', 'amber', 'slate'].includes(v.accent ?? '')
    && Array.isArray(v.modules) && v.modules.every(m => typeof m === 'string')
    && typeof v.workspaceLabel === 'string' && typeof v.unitLabel === 'string';
};
