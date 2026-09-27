/** In-memory simulation events; intentionally separate from the legacy saved research records. */
export type Execution = 'running' | 'completed' | 'blocked';
export type Verdict = 'pending' | 'unsupported' | 'candidate' | 'supported';
export type Task = { id: string; lane: number; agents: number[]; title: string; hypothesis: string; execution: Execution; verdict: Verdict; input: string; method: string; artifact: string; finding: string; score?: number; verified?: boolean; };
export type Post = { id: string; agent: number; task: string; text: string; kind: '解释' | '质疑' | '决定' };
export type ResearchEvent = { id: string; kind: 'start' | 'result' | 'verification' | 'forum' | 'discussion' | 'decision' | 'report'; title: string; task?: Task; post?: Post; target?: string; approval?: 'manual' | 'auto'; };
export type WorkflowState = { tasks: Task[]; posts: Post[]; discussion: boolean; approved: boolean; participants: number[]; champion?: Task; reportReady: boolean; };
const base = { input: 'D2 固定验证集 · C4 配置 · seed 17 · 预算 30 分钟（模拟）', method: '只改变指定因素；保持数据版本、验证条件与计算预算一致。', artifact: '配置快照、运行记录与结果表（演示文本）', verified: false };
const architecture: Task = { ...base, id: 'E07', lane: 0, agents: [1, 2, 3], title: '残差结构的匹配预算对照', hypothesis: 'H1：结构调整能否改善固定预算下的表现？', execution: 'running', verdict: 'pending', finding: '等待实验结果，不能提前判断。' };
const optimizer: Task = { ...base, id: 'E08', lane: 1, agents: [4, 5, 6], title: '优化方法的单因素对照', hypothesis: 'H2：当前优化方法是否限制收敛？', execution: 'running', verdict: 'pending', finding: '等待实验结果，不能提前判断。' };
const schedule: Task = { ...base, id: 'E09', lane: 2, agents: [7, 8, 9], title: '训练调度的稳定性检查', hypothesis: 'H3：调度是否影响最终表现？', execution: 'running', verdict: 'pending', finding: '等待资源，尚无可比较结果。' };
const joint: Task = { ...base, id: 'E11', lane: 0, agents: [2, 5, 3], title: '结构 × 优化方法联合对照', hypothesis: 'H1′：结构收益是否依赖优化方法？', execution: 'running', verdict: 'pending', method: '2×2 联合对照；沿用 D2 / seed 17 和相同预算；a3 独立核验比较条件。', finding: '已依据讨论决定派发；尚未产生结果。' };
export const initialWorkflow = (): WorkflowState => ({ tasks: [], posts: [], discussion: false, approved: false, participants: [], reportReady: false });
export function applyResearchEvent(state: WorkflowState, event: ResearchEvent): WorkflowState {
  const next: WorkflowState = { ...state, tasks: [...state.tasks], posts: [...state.posts] };
  if (event.task) next.tasks = [...next.tasks.filter(task => task.id !== event.task!.id), { ...event.task }];
  if (event.post) next.posts.push({ ...event.post });
  if (event.kind === 'verification') {
    const task = next.tasks.find(item => item.id === event.target);
    if (task?.execution === 'completed' && task.score !== undefined && task.verdict !== 'unsupported' && task.input === base.input) {
      const checked = { ...task, verified: true, verdict: 'supported' as const };
      next.tasks = next.tasks.map(item => item.id === task.id ? checked : item);
      if (!next.champion || task.score > next.champion.score!) next.champion = checked;
    }
  }
  if (event.kind === 'discussion') { next.discussion = true; next.participants = [2, 5, 3]; }
  if (event.kind === 'decision') next.approved = true;
  if (event.task?.id === 'E11' && event.kind === 'start') { next.discussion = false; next.participants = []; }
  if (event.kind === 'report') next.reportReady = true;
  return next;
}
export function projectResearchEvents(events: ResearchEvent[]): WorkflowState { return events.reduce(applyResearchEvent, initialWorkflow()); }
export const workflowScript: ResearchEvent[] = [
  { id: 'S01', kind: 'start', title: 'a1–a3 接受 H1，开始 E07', task: architecture },
  { id: 'S02', kind: 'start', title: 'a4–a6 接受 H2，开始 E08', task: optimizer },
  { id: 'S03', kind: 'start', title: 'a7–a9 接受 H3，开始 E09', task: schedule },
  { id: 'S04', kind: 'result', title: 'E07 已完成：本轮未支持 H1；结果存入 Log', task: { ...architecture, execution: 'completed', verdict: 'unsupported', score: .4312, finding: '同预算下未观察到预期改善；不代表结构方向整体无效。' } },
  { id: 'S05', kind: 'result', title: 'E08 已完成：发现候选改善，等待检查', task: { ...optimizer, execution: 'completed', verdict: 'candidate', score: .4480, finding: '指标达到 0.4480，但须核验比较条件后才能更新 Champion。' } },
  { id: 'S06', kind: 'result', title: 'E09 资源不足：等待执行，不判断 H3', task: { ...schedule, execution: 'blocked', verdict: 'pending', artifact: '资源检查记录（演示文本）；无实验结果表', finding: '模拟执行器没有可用算力；未完成实验，不能据此支持或否定 H3。' } },
  { id: 'S07', kind: 'verification', title: 'a6 检查 E08 比较条件，候选进入 Champion', target: 'E08' },
  { id: 'S08', kind: 'forum', title: 'a2 对 E07 提出解释', post: { id: 'F01', agent: 2, task: 'E07', kind: '解释', text: '结构改动没有显著收益，结构可能不是本轮的主要瓶颈。' } },
  { id: 'S09', kind: 'forum', title: 'a5 引用 E07 提出质疑', post: { id: 'F02', agent: 5, task: 'E07', kind: '质疑', text: '当前优化设置可能掩盖结构收益。E08 的改善不足以排除交互作用，建议联合对照。' } },
  { id: 'S10', kind: 'discussion', title: '召集 a2、a5、a3：结构收益是否依赖优化方法？' },
  { id: 'S11', kind: 'decision', title: '确认联合对照；H1 缩小为 H1′', post: { id: 'F03', agent: 3, task: 'E07', kind: '决定', text: '保留但收窄 H1；a2 与 a5 执行 E11，a3 检查条件。维持预算，不扩大外部访问。' } },
  { id: 'S12', kind: 'start', title: '讨论决定已落地：a2、a5、a3 进入联合实验 E11', task: joint },
  { id: 'S13', kind: 'result', title: 'E11 产物已保存，等待独立核验', task: { ...joint, execution: 'completed', verdict: 'candidate', score: .4526, finding: '联合条件下指标为 0.4526；当前只是候选，不足以推广为一般规律。' } },
  { id: 'S14', kind: 'verification', title: 'a3 核验 E11：比较条件一致，更新当前候选', target: 'E11' },
  { id: 'S15', kind: 'report', title: '报告 v2 已汇总；E09 的资源依赖仍待解决' },
];
export function nextResearchEvent(events: ResearchEvent[], mode: 'manual' | 'auto', approved = false): ResearchEvent | null {
  const template = workflowScript[events.length];
  if (!template) return null;
  if (template.kind === 'decision' && mode === 'manual' && !approved) return null;
  return template.kind === 'decision' ? { ...template, approval: mode } : template;
}
export function workflowPosition(agent: number, state: WorkflowState) {
  if (state.discussion && state.participants.includes(agent)) {
    const index = state.participants.indexOf(agent);
    return [{ x: 518, y: 205 }, { x: 966, y: 205 }, { x: 742, y: 337 }][index];
  }
  if (state.tasks.some(task => task.id === 'E11') && [2, 5, 3].includes(agent)) return { x: 445 + [2, 5, 3].indexOf(agent) * 46, y: 463 };
  const lane = Math.floor((agent - 1) / 3), slot = (agent - 1) % 3;
  // a1 remains on the original direction after the joint experiment is formed.
  if (agent === 1 && state.tasks.some(task => task.id === 'E11')) return { x: 411, y: 486 };
  return { x: [490, 730, 970][lane] - 47 + slot * 47, y: 463 };
}
