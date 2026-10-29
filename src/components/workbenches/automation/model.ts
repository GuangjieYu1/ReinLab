// 自动化台 AUTO 的示例数据（纯前端模拟）。形态参照 Agent 例程（Claude Code routines / ChatGPT Tasks）：
// 一条例程 = 一段自然语言指令 + 触发 + 工具权限 + 产出与预算。Agent 每次按指令自己执行，界面以运行记录为主，不画流程图。
// 出错时由维护 Agent 走完：诊断 → 修复（改指令或配置）→ 沙盒重放失败那次的输入 → 人审上线。

import type { Risk } from '../AgentDock';

export type Perm = 'allow' | 'ask' | 'deny';
export type Tool = { id: string; name: string; risk: Risk; perm: Perm; desc: string };
export type TriggerKind = 'schedule' | 'event' | 'webhook' | 'manual';
export type Trigger = { kind: TriggerKind; spec: string; human: string; hours?: number[]; days?: number[] };
/** 指令里一处说得不够清楚的地方：Agent 解读时标出来，让人选一个说法替换。 */
export type Amb = { id: string; phrase: string; question: string; options: string[] };
export type StepKind = 'think' | 'tool' | 'approval' | 'artifact' | 'error' | 'done';
export type Step = { t: number; kind: StepKind; text: string; tool?: string; input?: string; output?: string; state?: 'pending' | 'approved' | 'rejected' };
export type RunState = 'ok' | 'warn' | 'fail' | 'waiting' | 'running';
export type Run = { id: string; at: string; trigger: string; state: RunState; took: string; calls: number; cost: number; version: string; note: string; steps: Step[]; sandbox?: boolean };
export type Routine = {
  id: string; name: string; file: number; enabled: boolean; version: string; owner: string; model: string;
  instruction: string; ambs: Amb[]; triggers: Trigger[]; tools: Tool[]; output: string;
  budget: { minutes: number; calls: number }; history: string; runs: Run[]; versions: [string, string, string][];
};

export const FILES = ['每日资料整理', '研究进展汇总', '作品归档流程', '任务编排与接续'];
export const STATE_LABEL: Record<RunState, string> = { ok: '成功', warn: '有提醒', fail: '失败', waiting: '等你确认', running: '运行中' };
export const PERM_LABEL: Record<Perm, string> = { allow: '允许', ask: '询问', deny: '禁止' };
export const TRIGGER_LABEL: Record<TriggerKind, string> = { schedule: '定时', event: '事件', webhook: 'Webhook', manual: '手动' };

const T = (id: string, name: string, risk: Risk, perm: Perm, desc: string): Tool => ({ id, name, risk, perm, desc });
const daily = (h: number, label: string): Trigger => ({ kind: 'schedule', spec: `cron ${Math.round((h % 1) * 60)} ${Math.floor(h)} * * *`, human: label, hours: [h], days: [0, 1, 2, 3, 4, 5, 6] });

export const ROUTINES: Routine[] = [
  { id: 'WF-01', name: '每日资料整理', file: 0, enabled: true, version: 'v1.4', owner: 'RSCH', model: 'reinlab-default',
    instruction: '每天早上收集 @arxiv_rss 和 @inbox 里的新论文与 PDF，跳过已经在 #R—014 里的。对每份写三句话摘要，保留关键数字，从 #标签表 里选 1–3 个标签。拿不准分类的放进待确认，等我看过再写入 #R—014。',
    ambs: [
      { id: 'a1', phrase: '新论文', question: '「新」从什么时候算起？', options: ['上次成功运行之后的新论文', '过去 24 小时内的新论文', '本周内的新论文'] },
      { id: 'a2', phrase: '拿不准分类的', question: '多不确定算「拿不准」？', options: ['标签置信度低于 0.6 的', '没有任何标签命中的', '和已有条目重复度高于 80% 的'] },
    ],
    triggers: [daily(8.5, '每天 08:30')],
    tools: [T('arxiv_rss', '读 arXiv RSS', 'read', 'allow', '拉取订阅的 6 个分类'), T('inbox', '读 ~/Inbox', 'read', 'allow', '只读本地文件夹'), T('summarize', '写摘要', 'read', 'allow', '模型调用，不落盘'),
      T('archive_write', '写入 R—014', 'write', 'ask', '追加条目；批量写入前询问'), T('archive_delete', '删除档案条目', 'danger', 'deny', '只能你点')],
    output: '研究档案 R—014 · 资料库', budget: { minutes: 10, calls: 80 }, history: 'oooowoooxooooW',
    runs: [], versions: [['v1.4', '10-05', '摘要要求保留关键数字'], ['v1.3', '09-28', '拿不准的先放待确认'], ['v1.2', '09-20', '去重改为按 DOI']] },
  { id: 'WF-02', name: 'PDF 收件箱归档', file: 0, enabled: true, version: 'v0.9', owner: 'RSCH', model: 'reinlab-small',
    instruction: '@inbox 里出现新 PDF 时，读出标题和作者，按「日期-标题」重命名，移进 #资料库。读不出标题的保留原名，并在 #R—014 的收件记录里记一笔。',
    ambs: [], triggers: [{ kind: 'event', spec: 'fs.watch ~/Inbox *.pdf', human: '~/Inbox 出现新 PDF' }],
    tools: [T('inbox', '读 ~/Inbox', 'read', 'allow', '只读本地文件夹'), T('pdf_meta', '读 PDF 元数据', 'read', 'allow', 'pdfinfo'), T('file_move', '移动与重命名', 'write', 'allow', '只在 ~/Inbox → 资料库 之间')],
    output: '资料库文件夹', budget: { minutes: 2, calls: 20 }, history: 'ooooooooooooo-', runs: [], versions: [['v0.9', '09-30', '初版']] },
  { id: 'WF-03', name: '研究周报', file: 1, enabled: true, version: 'v2.0', owner: 'RSCH', model: 'reinlab-default',
    instruction: '每周五傍晚读取本周 #研究档案 的变动和 @runs 里的实验，按课题起草一份周报：先写结论，再列证据，每条结论附实验编号。只引用本周的实验。写好后发给我确认，确认后存进 #研究档案。',
    ambs: [{ id: 'a3', phrase: '只引用本周的实验', question: '未复核的实验算不算？', options: ['只引用本周已复核的实验', '本周所有实验，未复核的标出来'] }],
    triggers: [{ kind: 'schedule', spec: 'cron 0 18 * * 5', human: '每周五 18:00', hours: [18], days: [5] }],
    tools: [T('archive_read', '读研究档案', 'read', 'allow', ''), T('runs', '查 runs 表', 'read', 'allow', 'PostgreSQL 只读账号'), T('draft', '起草文档', 'read', 'allow', ''), T('archive_write', '写入研究档案', 'write', 'ask', '确认后写入')],
    output: '研究档案 · 周报', budget: { minutes: 15, calls: 60 }, history: 'oooooo-oooowo-', runs: [], versions: [['v2.0', '09-26', '改为 Agent 起草'], ['v1.1', '09-12', '按课题分节']] },
  { id: 'WF-04', name: '实验结果入库', file: 1, enabled: true, version: 'v1.1', owner: 'DATA', model: 'reinlab-small',
    instruction: '收到 @webhook 的实验结果时，检查字段是否齐全（实验编号、val_bpb、GPU 分钟、类别），齐全就写进 @runs；不齐全就退回并说明缺了什么。',
    ambs: [], triggers: [{ kind: 'webhook', spec: 'POST /hooks/runs', human: 'POST /hooks/runs' }],
    tools: [T('webhook', '读请求体', 'read', 'allow', ''), T('runs_write', '写 runs 表', 'write', 'allow', '单行插入'), T('runs_drop', '清空 runs 表', 'danger', 'deny', '只能你点')],
    output: 'runs 表', budget: { minutes: 1, calls: 6 }, history: 'ooooxxoooooooo', runs: [], versions: [['v1.1', '10-01', '加字段检查']] },
  { id: 'WF-05', name: '作品定稿归档', file: 2, enabled: true, version: 'v1.0', owner: 'CRTV', model: 'reinlab-default',
    instruction: '创作台有作品标记为定稿时，导出 PNG 和 PDF，用 @cover_graph 按莱茵生命模板生成封面，连同设定卡一起归进 #C—008。归档前让我确认封面。',
    ambs: [], triggers: [{ kind: 'event', spec: 'creative.final', human: '创作台标记定稿' }],
    tools: [T('creative_read', '读创作台作品', 'read', 'allow', ''), T('export', '导出 PNG / PDF', 'write', 'allow', '写到临时目录'), T('cover_graph', '节点图 · 定稿封面', 'write', 'ask', 'WFG-03 · 参数 query / seed / batch_size'), T('archive_write', '写入 C—008', 'write', 'ask', '')],
    output: '作品档案 C—008', budget: { minutes: 5, calls: 30 }, history: '-----o----x--x', runs: [], versions: [['v1.0', '10-01', '初版']] },
  { id: 'WF-06', name: '探索照片回收', file: 2, enabled: false, version: 'v0.3', owner: 'EXPL', model: 'reinlab-small',
    instruction: '每天晚上把手机相册里今天拍的照片按 GPS 归到 #旅程档案 最近的站点；没有 GPS 的放进「未归位」。',
    ambs: [{ id: 'a4', phrase: '最近的站点', question: '离多远还算「最近」？', options: ['500 米以内最近的站点', '同一天行程里最近的站点'] }],
    triggers: [daily(22, '每天 22:00')],
    tools: [T('photos', '读相册', 'read', 'ask', '每次运行前询问'), T('geo', '地理匹配', 'read', 'allow', ''), T('journey_write', '写入旅程档案', 'write', 'ask', '')],
    output: '旅程档案 P—013', budget: { minutes: 5, calls: 40 }, history: '--------oooo--', runs: [], versions: [['v0.3', '10-06', '草稿 · 未启用']] },
  { id: 'WF-07', name: '明日接续清单', file: 3, enabled: true, version: 'v1.2', owner: 'ALL', model: 'reinlab-default',
    instruction: '每天睡前盘点各工作台没做完的事，按截止日期排序，阻塞别人的排前面，每项写一句「明天从哪儿接着做」，放到首页的「明日起点」。',
    ambs: [], triggers: [daily(23.5, '每天 23:30'), { kind: 'manual', spec: 'manual', human: '手动' }],
    tools: [T('benches_read', '读各工作台状态', 'read', 'allow', ''), T('home_write', '写首页卡片', 'write', 'allow', '只写「明日起点」')],
    output: '首页 · 明日起点', budget: { minutes: 3, calls: 30 }, history: 'oooooooooooooo', runs: [], versions: [['v1.2', '10-04', '阻塞他人的排前面']] },
  { id: 'WF-08', name: '中断任务接续', file: 3, enabled: true, version: 'v0.6', owner: 'ALL', model: 'reinlab-default',
    instruction: '任何例程或工作台任务中断时，读它的检查点，从断点重新排队；同一个任务连续中断两次就停下来告诉我原因，不要再试。',
    ambs: [], triggers: [{ kind: 'event', spec: 'task.interrupted', human: '任务中断' }],
    tools: [T('checkpoint', '读检查点', 'read', 'allow', ''), T('queue', '重新排队', 'write', 'allow', ''), T('notify', '通知你', 'read', 'allow', '')],
    output: '任务队列', budget: { minutes: 2, calls: 15 }, history: 'oooxoooooxooox', runs: [], versions: [['v0.6', '10-09', '连续中断两次就停']] },
];

/* ———— 运行记录（每一步是 Agent 的一次思考或工具调用） ———— */
const R = (id: string, at: string, trigger: string, state: RunState, took: string, calls: number, cost: number, version: string, note: string, steps: Step[]): Run => ({ id, at, trigger, state, took, calls, cost, version, note, steps });
const RUNS: Record<string, Run[]> = {
  'WF-01': [
    R('R-0812', '今天 08:30', '定时 · 08:30', 'waiting', '1m 42s', 31, 0.42, 'v1.4', '12 份资料 · 3 份等你确认', [
      { t: 0, kind: 'think', text: '按指令：收集 → 去重 → 摘要与标签 → 拿不准的待确认 → 写入。' },
      { t: 2, kind: 'tool', tool: 'arxiv_rss', text: '拉取 6 个分类的 RSS', input: 'categories: cs.LG cs.CL cs.CV stat.ML math.GR physics.ed-ph\nsince: 2026-10-17 08:31', output: '19 条' },
      { t: 4, kind: 'tool', tool: 'inbox', text: '读 ~/Inbox', input: 'glob: *.pdf', output: '2 个 PDF' },
      { t: 6, kind: 'think', text: '21 条里有 9 条的 DOI 已在 R—014，跳过。剩 12 条。' },
      { t: 78, kind: 'tool', tool: 'summarize', text: '为 12 份资料写摘要与标签', input: 'template: summarize v3 · keep_numbers: true', output: '12 份 · 平均置信度 0.81 · 3 份低于 0.6' },
      { t: 80, kind: 'artifact', text: '摘要草稿 · 12 份（9 份可直接写入，3 份待确认）' },
      { t: 82, kind: 'approval', tool: 'archive_write', text: '写入 R—014 · 9 条新条目；另外 3 条等你逐条确认', state: 'pending' },
    ]),
    R('R-0811', '昨天 08:30', '定时 · 08:30', 'warn', '2m 05s', 36, 0.51, 'v1.4', '15 份 · 2 份无法归类', [
      { t: 0, kind: 'think', text: '按指令执行。' }, { t: 3, kind: 'tool', tool: 'arxiv_rss', text: '拉取 RSS', output: '22 条' },
      { t: 121, kind: 'tool', tool: 'summarize', text: '摘要与标签', output: '15 份 · 2 份没有任何标签命中' },
      { t: 124, kind: 'approval', tool: 'archive_write', text: '写入 R—014 · 13 条', state: 'approved' }, { t: 125, kind: 'done', text: '写入 13 条，2 条留在待确认' }]),
    R('R-0810', '10-07 08:30', '定时 · 08:30', 'fail', '0m 41s', 4, 0.03, 'v1.4', 'arXiv RSS 超时', [
      { t: 0, kind: 'think', text: '按指令执行。' },
      { t: 30, kind: 'error', tool: 'arxiv_rss', text: 'arxiv_rss 超时（30s）', input: 'categories: 6', output: 'TimeoutError: export.arxiv.org did not respond in 30000ms' },
      { t: 35, kind: 'tool', tool: 'arxiv_rss', text: '重试 1 / 2', output: 'TimeoutError' }, { t: 41, kind: 'error', text: '重试用完，整次运行失败；~/Inbox 里的 2 个 PDF 也没有处理。' }]),
  ],
  'WF-03': [
    R('R-0041', '10-10 18:00', '定时 · 周五 18:00', 'warn', '3m 22s', 44, 0.88, 'v2.0', '周报引用了 1 个未复核实验', [
      { t: 0, kind: 'think', text: '读取本周变动与实验，按课题起草。' }, { t: 6, kind: 'tool', tool: 'runs', text: '查本周实验', input: "SELECT * FROM runs WHERE week = '2026-W41'", output: '26 行（其中 EXP-026 未复核）' },
      { t: 190, kind: 'artifact', text: '周报草稿 · 3 个课题 · 7 条结论' }, { t: 196, kind: 'approval', tool: 'archive_write', text: '存进研究档案', state: 'approved' },
      { t: 202, kind: 'done', text: '已存档。复核时发现结论 4 引用了未复核的 EXP-026。' }]),
    R('R-0040', '10-03 18:00', '定时 · 周五 18:00', 'ok', '3m 10s', 39, 0.79, 'v2.0', '周报 1 份', [{ t: 0, kind: 'think', text: '读取本周变动与实验。' }, { t: 188, kind: 'artifact', text: '周报草稿' }, { t: 190, kind: 'done', text: '已存档' }]),
  ],
  'WF-05': [
    R('R-0013', '昨天 21:14', '事件 · creative.final', 'fail', '0m 12s', 3, 0.02, 'v1.0', '没有定稿标记就失败了', [
      { t: 0, kind: 'think', text: '收到 creative.final 事件：《红皮书的最后一页》第 3 章。' },
      { t: 4, kind: 'tool', tool: 'creative_read', text: '读作品', input: 'work: redbook · chapter: 3', output: 'status: draft（没有 final 标记）' },
      { t: 12, kind: 'error', text: '指令说「标记为定稿时」，但这次事件来自「预览导出」，作品本身没有定稿标记；按失败处理。' }]),
    R('R-0012', '10-05 21:14', '事件 · creative.final', 'ok', '0m 48s', 11, 0.12, 'v1.0', 'V-04 已归档', [{ t: 0, kind: 'think', text: '收到定稿事件。' }, { t: 6, kind: 'tool', tool: 'export', text: '导出 PNG / PDF', output: '2 个文件' }, { t: 9, kind: 'tool', tool: 'cover_graph', text: '运行节点图 WFG-03 定稿封面', input: 'query: 最新定稿\nseed: 2608\nbatch_size: 4', output: '4 张 · 832×1216 → 放大 4x' }, { t: 40, kind: 'artifact', text: '封面 4 选 1 · PNG · PDF' }, { t: 46, kind: 'approval', tool: 'archive_write', text: '归进 C—008', state: 'approved' }, { t: 48, kind: 'done', text: '归进 C—008' }]),
  ],
  'WF-07': [R('R-0302', '昨天 23:30', '定时 · 23:30', 'ok', '0m 22s', 14, 0.09, 'v1.2', '7 项', [
    { t: 0, kind: 'think', text: '盘点各工作台未完成项。' }, { t: 8, kind: 'tool', tool: 'benches_read', text: '读 5 个工作台', output: '11 项未完成 · 2 项阻塞他人' },
    { t: 18, kind: 'artifact', text: '明日起点 · 7 项（4 项合并）' }, { t: 22, kind: 'done', text: '已写到首页' }])],
  'WF-08': [
    R('R-0077', '昨天 16:02', '事件 · task.interrupted', 'fail', '0m 09s', 5, 0.03, 'v0.6', '同一任务被反复排队', [
      { t: 0, kind: 'think', text: '收到中断：研究台 · 自研 · 第 37 轮实验。' },
      { t: 2, kind: 'tool', tool: 'checkpoint', text: '读检查点', output: 'step 37 · 中断原因 OOM · 已中断 2 次' },
      { t: 5, kind: 'tool', tool: 'queue', text: '重新排队', output: 'queued #3' },
      { t: 9, kind: 'error', text: '指令要求「连续中断两次就停」，但检查点里的计数来自上一次运行，排队时没有读到，第三次又排上了。' }]),
  ],
};
for (const r of ROUTINES) r.runs = RUNS[r.id] ?? [R(`R-${r.id.slice(3)}01`, '今天', r.triggers[0].human, 'ok', '0m 06s', 4, 0.01, r.version, '正常', [{ t: 0, kind: 'think', text: '按指令执行。' }, { t: 6, kind: 'done', text: '完成' }])];

/* ———— 维护：每个故障走完 诊断 → 修复 → 沙盒重放 → 人审上线 ———— */
export type DiffLine = { op: ' ' | '+' | '-'; text: string };
export type Incident = {
  id: string; routine: string; run: string; title: string; failStep: number;
  cause: string; evidence: string[]; confidence: number;
  fix: { where: string; why: string; diff: DiffLine[]; instruction?: string };
  replay: Step[]; regress: string[];
  /** 打开时已经走到哪一步（档案简报里 WF-08 已经生成了修复，等待沙盒试跑）。 */
  stage: number;
};
export const STAGES = ['诊断', '修复', '沙盒重放', '人审上线'];
export const INCIDENTS: Incident[] = [
  { id: 'INC-11', routine: 'WF-01', run: 'R-0810', title: 'arXiv RSS 超时，整次运行失败', failStep: 1, stage: 0, confidence: .86,
    cause: 'arXiv 的 RSS 出口在 08:30 前后常有排队，单次 30 秒超时、只重试 2 次不够；而且 RSS 失败时，本来不依赖它的 ~/Inbox 部分也一起被放弃了。',
    evidence: ['R-0810 · 08:30:30 TimeoutError: export.arxiv.org did not respond in 30000ms', '近 30 次中有 4 次在 08:30–08:32 超时，9:00 后重试都成功', '指令没有说明「一个来源失败时其他来源怎么办」'],
    fix: { where: '指令 + 工具配置', why: '加一句来源失败时的处理；超时放宽并改为退避重试。', diff: [
      { op: ' ', text: '每天早上收集 @arxiv_rss 和 @inbox 里的新论文与 PDF，跳过已经在 #R—014 里的。' },
      { op: '+', text: '某个来源取不到时，先处理其他来源，在结果里注明缺了哪个来源，10 分钟后只补那一个来源。' },
      { op: ' ', text: '对每份写三句话摘要，保留关键数字……' },
      { op: '-', text: 'arxiv_rss.timeout = 30s · retries = 2' },
      { op: '+', text: 'arxiv_rss.timeout = 60s · retries = 3 · backoff = 2× · 首次重试延后到 10 分钟后' },
    ], instruction: '每天早上收集 @arxiv_rss 和 @inbox 里的新论文与 PDF，跳过已经在 #R—014 里的。某个来源取不到时，先处理其他来源，在结果里注明缺了哪个来源，10 分钟后只补那一个来源。对每份写三句话摘要，保留关键数字，从 #标签表 里选 1–3 个标签。拿不准分类的放进待确认，等我看过再写入 #R—014。' },
    replay: [
      { t: 0, kind: 'think', text: '沙盒重放 R-0810 的输入（arXiv 模拟为超时，~/Inbox 2 个 PDF）。' },
      { t: 60, kind: 'error', tool: 'arxiv_rss', text: 'arxiv_rss 超时（60s）→ 按新指令先处理其他来源' },
      { t: 62, kind: 'tool', tool: 'inbox', text: '读 ~/Inbox', output: '2 个 PDF' }, { t: 70, kind: 'tool', tool: 'summarize', text: '摘要 2 份', output: '置信度 0.88 / 0.74' },
      { t: 72, kind: 'artifact', text: '结果注明「缺 arXiv，10 分钟后补」' }, { t: 672, kind: 'tool', tool: 'arxiv_rss', text: '10 分钟后补 arXiv', output: '19 条（沙盒回放的录制数据）' },
      { t: 680, kind: 'done', text: '通过 · 沙盒内 0 次真实写入' }],
    regress: ['R-0811', 'R-0809', 'R-0808', 'R-0807', 'R-0806'] },
  { id: 'INC-12', routine: 'WF-03', run: 'R-0041', title: '周报引用了未复核的实验', failStep: 1, stage: 0, confidence: .91,
    cause: '指令写的是「只引用本周的实验」，没有说复核状态；EXP-026 是本周的、但还没复核，Agent 按字面照引了。属于指令歧义，不是执行错误。',
    evidence: ['R-0041 · runs 查询返回 26 行，EXP-026 的 reviewed = false', '周报结论 4：「学习率预热缩短到 200 步更好（EXP-026）」', '解读时已标出「只引用本周的实验」有歧义，尚未处理'],
    fix: { where: '指令', why: '把歧义改成明确说法；未复核的放进单独一节。', diff: [
      { op: '-', text: '每条结论附实验编号。只引用本周的实验。' },
      { op: '+', text: '每条结论附实验编号。只引用本周已复核的实验；未复核的列在最后「待复核」一节，不作为结论依据。' },
    ], instruction: '每周五傍晚读取本周 #研究档案 的变动和 @runs 里的实验，按课题起草一份周报：先写结论，再列证据，每条结论附实验编号。只引用本周已复核的实验；未复核的列在最后「待复核」一节，不作为结论依据。写好后发给我确认，确认后存进 #研究档案。' },
    replay: [{ t: 0, kind: 'think', text: '沙盒重放 R-0041 的输入（26 行实验，EXP-026 未复核）。' }, { t: 6, kind: 'tool', tool: 'runs', text: '查本周实验', output: '26 行 · 25 行已复核' },
      { t: 180, kind: 'artifact', text: '周报草稿 · 6 条结论 · 「待复核」1 项（EXP-026）' }, { t: 182, kind: 'done', text: '通过 · 结论里不再出现 EXP-026' }],
    regress: ['R-0040', 'R-0039', 'R-0038'] },
  { id: 'INC-13', routine: 'WF-05', run: 'R-0013', title: '预览导出被当成定稿事件', failStep: 2, stage: 0, confidence: .78,
    cause: '创作台的「预览导出」也会发 creative.final 事件；指令只说「标记为定稿时」，没说遇到不是定稿的事件怎么办，于是直接失败。',
    evidence: ['R-0013 · status: draft（没有 final 标记）', '事件来源：creative.preview_export → 复用了 creative.final 通道', '过去两周 2 次失败都是同一原因'],
    fix: { where: '指令 + 触发', why: '不是定稿就安静跳过；触发只认带 final 标记的事件。', diff: [
      { op: ' ', text: '创作台有作品标记为定稿时，导出 PNG 和 PDF……' },
      { op: '+', text: '如果收到的作品没有定稿标记，不算失败：记一条「已跳过」，不要导出。' },
      { op: '-', text: 'trigger: creative.final' }, { op: '+', text: 'trigger: creative.final where work.status = "final"' },
    ], instruction: '创作台有作品标记为定稿时，导出 PNG 和 PDF，用 @cover_graph 按莱茵生命模板生成封面，连同设定卡一起归进 #C—008。归档前让我确认封面。如果收到的作品没有定稿标记，不算失败：记一条「已跳过」，不要导出。' },
    replay: [{ t: 0, kind: 'think', text: '沙盒重放 R-0013 的事件。' }, { t: 4, kind: 'tool', tool: 'creative_read', text: '读作品', output: 'status: draft' }, { t: 5, kind: 'done', text: '已跳过（不是定稿）· 通过' }],
    regress: ['R-0012', 'R-0010'] },
  { id: 'INC-14', routine: 'WF-08', run: 'R-0077', title: '同一任务被第三次排队', failStep: 3, stage: 2, confidence: .83,
    cause: '「连续中断两次就停」需要跨运行的计数，但例程每次运行只看当次输入，没有读检查点里的历史中断次数。',
    evidence: ['R-0077 · 检查点：已中断 2 次', '排队时没有比较中断次数', '研究台第 37 轮因此 OOM 了第三次'],
    fix: { where: '指令', why: '排队前先读中断次数；达到 2 次就停下并说明原因。', diff: [
      { op: ' ', text: '任何例程或工作台任务中断时，读它的检查点，' },
      { op: '-', text: '从断点重新排队；同一个任务连续中断两次就停下来告诉我原因，不要再试。' },
      { op: '+', text: '先看检查点里记录的中断次数：少于 2 次就从断点重新排队；已经 2 次就不要排队，把两次中断的原因整理给我。' },
    ], instruction: '任何例程或工作台任务中断时，读它的检查点，先看检查点里记录的中断次数：少于 2 次就从断点重新排队；已经 2 次就不要排队，把两次中断的原因整理给我。' },
    replay: [{ t: 0, kind: 'think', text: '沙盒重放 R-0077（第 37 轮，已中断 2 次）。' }, { t: 2, kind: 'tool', tool: 'checkpoint', text: '读检查点', output: '已中断 2 次 · 原因 OOM ×2' },
      { t: 4, kind: 'think', text: '达到 2 次，不排队。' }, { t: 6, kind: 'tool', tool: 'notify', text: '通知你', output: '「第 37 轮两次 OOM：batch 128 在 24G 卡上放不下」' }, { t: 7, kind: 'done', text: '通过 · 没有第三次排队' }],
    regress: ['R-0076', 'R-0075', 'R-0071'] },
];

/* ———— 一句话新建例程（关键词模拟） ———— */
/** 「把本周实验整理成周报」→「实验周报」；取不到就用前 8 个字。 */
const nameOf = (text: string) => {
  const m = text.match(/把(.+?)(?:整理成|汇总成|写成|做成|生成)(.+?)(?:[，,。]|发给|$)/);
  if (m) return `${m[1].replace(/^(本周|今天|每天|所有|新)的?/, '').slice(0, 6)}${m[2].slice(0, 4)}`;
  return text.replace(/^(每天|每周[一二三四五六日]?|每当|帮我|请)/, '').replace(/^[^\u4e00-\u9fa5]*?(早上|下午|晚上)?\s*\d*\s*[点:：]?\d*/, '').slice(0, 8) || '新例程';
};
export function draftRoutine(text: string, n: number): Routine {
  const weekly = /每周|周[一二三四五六日]/.test(text), fri = /周五/.test(text);
  const h = (text.match(/(\d{1,2})\s*[点:：]/)?.[1] ?? (/早/.test(text) ? '8' : /晚|睡前/.test(text) ? '22' : '9'));
  const hour = Math.min(23, +h + (/下午|晚上/.test(text) && +h < 12 ? 12 : 0));
  const mail = /邮件|邮箱/.test(text), git = /GitHub|PR|issue/i.test(text), data = /数据|实验|表/.test(text);
  const tools: Tool[] = [
    ...(mail ? [T('mail_read', '读邮箱', 'read', 'allow', '只读'), T('mail_send', '发邮件', 'write', 'ask', '发出前询问')] : []),
    ...(git ? [T('gh_read', '读 GitHub', 'read', 'allow', ''), T('gh_comment', '发评论', 'write', 'ask', '')] : []),
    ...(data ? [T('runs', '查 runs 表', 'read', 'allow', '只读账号')] : []),
    T('archive_read', '读档案', 'read', 'allow', ''), T('archive_write', '写入档案', 'write', 'ask', ''),
  ];
  return {
    id: `WF-${String(n).padStart(2, '0')}`, name: nameOf(text), file: -1, enabled: false, version: 'v0.1', owner: 'YOU', model: 'reinlab-default',
    instruction: `${text.replace(/[。.]$/, '')}。完成后把结果放进 #档案，需要写入或发出的内容先让我确认。`,
    ambs: [{ id: `n${n}`, phrase: text.match(/整理|汇总|总结|看看|处理/)?.[0] ?? text.slice(0, 2), question: '产出要什么形式？', options: ['一页要点摘要', '一张表格', '只在有异常时提醒我'] }],
    triggers: [{ kind: 'schedule', spec: weekly ? `cron 0 ${hour} * * ${fri ? 5 : 1}` : `cron 0 ${hour} * * *`, human: `${weekly ? (fri ? '每周五' : '每周一') : '每天'} ${String(hour).padStart(2, '0')}:00`, hours: [hour], days: weekly ? [fri ? 5 : 1] : [0, 1, 2, 3, 4, 5, 6] }],
    tools, output: '档案 · 待指定', budget: { minutes: 5, calls: 40 }, history: '--------------', runs: [], versions: [['v0.1', '刚才', '由一句话生成 · 草稿']],
  };
}
