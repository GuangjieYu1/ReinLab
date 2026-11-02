// 研究台 · 群研：界面只认 SwarmAdapter（design/prd/13-swarm-contract.md）。
// mock 版在 mockSwarm.ts（快照 + 事件回放），live 版在 src/data/swarm-live.ts（接 /v1/swarm/* 与事件流）。
// 数据类型全部来自共用契约，这里不另抄。
import type {
  BoardPost, BusEntry, Intervention, InterventionKind, MemberLogItem, SwarmReport, SwarmRun, SwarmSnapshot,
} from '../../../../../packages/contracts/src/swarm';

export type * from '../../../../../packages/contracts/src/swarm';

/** 对话框（AgentDock）里的一行：你说的话、负责人的回复、一行操作提示。 */
export type DockLine = { id: string; kind: 'user' | 'agent' | 'note'; text: string; at: string };

/** 负责人在澄清或研究中问你的问题（收件箱提问卡，同一张卡在页面上就地回答）。 */
export type SwarmAsk = { id: string; title: string; multi: boolean; candidates: { id: string; title: string }[] };
export type SwarmAnswer = { candidateId?: string; candidateIds?: string[]; text?: string };

export type SwarmConn = 'idle' | 'live' | 'reconnecting' | 'offline';

export type SwarmView = {
  /** 当前档案上最近的一次群研；没有就是 null（还没发起）。 */
  snap: SwarmSnapshot | null;
  /** 通信时间线（按 seq 升序、去重）。 */
  bus: BusEntry[];
  dock: DockLine[];
  asks: SwarmAsk[];
  conn: SwarmConn;
  /** 负责人正在回话（澄清阶段）。 */
  thinking: boolean;
  /** 某个队员的工作记录有新内容：抽屉看到变化就重取。 */
  logTick: number;
  /** 断开期间新增的通信条数（重连后提示一次）。 */
  missed: number;
  error: string | null;
};

export type SwarmError = Error & { code?: string; status?: number; detail?: unknown };

export interface SwarmAdapter {
  /** 读当前档案最近一次群研（快照 + 时间线 + 事件流）。失败 reject，message 写人话。 */
  load(): Promise<void>;
  subscribe(on: (view: SwarmView) => void): () => void;
  /** 历史时间线分页（回放只读这里）。 */
  timeline(after: number): Promise<{ entries: BusEntry[]; next: number | null }>;
  memberLog(memberId: string, after: number): Promise<{ items: MemberLogItem[]; next: number | null }>;
  /** 对话框发话：没有运行就发起；澄清中接着说（有待答提问就当回答）；开跑后发给负责人。 */
  send(text: string): Promise<void>;
  answer(askId: string, body: SwarmAnswer): Promise<void>;
  /** 留言板发言；`@队员名` 由服务端生成 mention 干预。 */
  post(text: string): Promise<BoardPost>;
  intervene(kind: InterventionKind, extra?: { text?: string; routeId?: string; memberId?: string }): Promise<Intervention>;
  /** 版本不符时 reject（code=PLAN_STALE），并已用服务端给的最新计划刷新。 */
  confirmPlan(planVersion: number, limits?: { rounds: number; minutes: number }): Promise<void>;
  report(): Promise<SwarmReport | null>;
}

/** 本批（MVP-1）服务端接受的干预；其余入口置灰。 */
export const LIVE_INTERVENTIONS: InterventionKind[] = ['stop_route', 'pause', 'resume', 'finish'];

export const TERMINAL: SwarmRun['state'][] = ['done', 'partial', 'unresolved', 'cancelled', 'failed'];
export const isTerminal = (run: SwarmRun | null | undefined) => !!run && TERMINAL.includes(run.state);
