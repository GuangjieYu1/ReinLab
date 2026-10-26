// 精读模式的数据接口：同一套界面，mock 和 live 两种数据源（design/RESEARCH_LIVE_FRONTEND.md）。
// 界面只认 ReadAdapter：mock 版在 mockRead.ts（剧本回放），live 版由后端按同一接口实现（接事件流）。
// 引用统一落到「原文段」：mock 的原文段是论文章节（§3.2.1），live 的原文段是读过的页（p.7），引文放进 gist。

export type SourceSection = { id: string; no: string; title: string; gist: string[] };
export type PaperView = {
  id: string; title: string; authors: string; venue: string; code?: string;
  access: 'full' | 'abstract_only'; license?: string; sections: SourceSection[];
};
/** 分层讲解卡（对应后端 card.layer）。refs 是原文段 id。 */
export type LayerCard = { id: string; no: string; title: string; en: string; body: { text: string; refs: string[] }[]; anim?: string };
/** 检查题卡（card.quiz）。keys 只在 mock 里用于本地评分；live 的答案只存在档案里，评分走 adapter.grade。 */
export type QuizCard = { id: string; q: string; layer: string; hint?: string; keys?: string[][] };
/** 发现卡（card.finding）。 */
export type FindingCard = { id: string; n: number; text: string; refs: string[]; confidence: 'low' | 'mid' | 'high'; status: 'hypothesis' | 'supported' | 'refuted'; at: string };

/** 检索到的候选论文。由你选一篇，AI 不替你决定读哪篇。 */
export type PaperCandidate = { id: string; title: string; authors: string; venue: string; access: 'full' | 'abstract_only'; pages?: number; note?: string };

export type Estimate = { id: string; model: string; maxCny: number; steps: number; note?: string };
export type RunState = 'idle' | 'estimating' | 'confirm' | 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type RunView = {
  id?: string; state: RunState; query?: string; estimate?: Estimate; budgetCny: number;
  /** 已知花费；null 表示还没有可核对的用量。unknownCost 为真时，界面写「另有未知用量」，不当作 0。 */
  spentCny: number | null; unknownCost?: boolean; step?: string; message?: string;
  /** 对话澄清后你选定的论文；有了它才能预估。 */
  chosen?: PaperCandidate;
  /** 澄清对话（便宜档模型）已花 / 上限。上限内不单独确认，超过就停下问你。 */
  clarifySpentCny?: number; clarifyCapCny?: number; clarifyUnknownCost?: boolean;
};

export type Grade = 'ok' | 'part' | 'miss';
export type ReadEvent =
  | { type: 'run'; run: Partial<RunView> }
  | { type: 'paper'; paper: PaperView }
  | { type: 'section'; section: SourceSection }
  | { type: 'layer'; layer: LayerCard }
  | { type: 'quiz'; quiz: QuizCard }
  | { type: 'finding'; finding: FindingCard }
  /** 你说的话（追问、发起时的要求）。 */
  | { type: 'user'; id: string; text: string }
  /** 助手说的话；refs 指向原文段，anim 指向可打开的动画。 */
  | { type: 'agent'; id: string; text: string; refs?: string[]; anim?: string }
  /** 工具调用：在助手面板里折叠成一行，可展开看 detail。 */
  | { type: 'tool'; id: string; action: string; label: string; state: 'running' | 'done' | 'failed'; detail?: string; ms?: number }
  /** 选论文：检索后列出候选，等你选一篇（live 对应原生 question）。state 为 none 表示没找到。 */
  | { type: 'pick'; id: string; query: string; candidates: PaperCandidate[]; state: 'pending' | 'answered' | 'none'; chosen?: string }
  /** 运行中的审批（例如把全文下载进档案）。 */
  | { type: 'approval'; id: string; action: string; title: string; effects: string[]; risk: 'read' | 'write' | 'danger'; state: 'pending' | 'approved' | 'rejected' };

export type ReadSnapshot = {
  dossier: { id: string; title: string };
  paper: PaperView | null; layers: LayerCard[]; quizzes: QuizCard[]; findings: FindingCard[];
  /** 可用的交互动画 id（mock 有三个；live 由 OpenMAIC 在第二期提供，现在为空）。 */
  anims: string[];
  /** 复现结论（mock 有；live 在第二期 P2-09 提供，现在为空）。 */
  hasRepro: boolean;
  run: RunView;
  /** 历史事件（刷新后恢复助手面板）。 */
  history: ReadEvent[];
};

export interface ReadAdapter {
  /** mock：示例数据；live：真实后端。界面只用它决定状态栏文案。 */
  readonly kind: 'mock' | 'live';
  load(): Promise<ReadSnapshot>;
  subscribe(on: (e: ReadEvent) => void): () => void;
  /** 第一步：在对话里说想读什么。助手检索、必要时追问，候选以 pick 事件出现在对话里。便宜档，上限 ¥0.05，不单独确认。 */
  clarify(text: string): Promise<void>;
  /** 结束当前档案的澄清；已知费用保留，未知用量保持未知。 */
  cancelClarify?(): Promise<void>;
  /** 换一篇：清掉已选定的论文，回到对话澄清。 */
  unchoose(): Promise<void>;
  /** 选定论文之后预估：返回最多花多少钱；你确认后才 start。 */
  estimate(candidateId: string, budgetCny: number): Promise<Estimate>;
  start(estimateId: string, budgetCny: number): Promise<void>;
  cancel(): Promise<void>;
  decide(approvalId: string, approve: boolean): Promise<void>;
  /** 选论文：candidateId 为 null 表示「都不是」，助手会请你再描述一下。 */
  pick(pickId: string, candidateId: string | null): Promise<void>;
  /** 读完之后的追问：回答以 agent 事件回来。 */
  ask(text: string): Promise<void>;
  grade(quizId: string, answer: string): Promise<Grade>;
  /** 新建一次精读（新档案）；之后界面会重新 load。 */
  newReading?(): Promise<void>;
}
