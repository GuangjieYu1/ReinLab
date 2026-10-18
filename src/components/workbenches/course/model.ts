// 课程台 CURR 的示例：自学「群论 · 对称与群」。来自 OpenMAIC（课堂）与 DeepTutor（备课链）的构思，前端模拟。
// 备课链：咨询 → 调研（交给研究台）→ 侦查与适配（交给自动化台）→ 蓝图 → 单元备课 → 独立审查 → 开课。每段之间是门禁：
// 「讨论修改」不等于「批准」；只批准了上一段，不会自动往下做；蓝图 ≠ 单元已创建 ≠ 可以开课。
// 页码、时间戳与费用均为示例数据。

export type StageId = 'consult' | 'research' | 'scout' | 'blueprint' | 'build' | 'review' | 'open';
export type StageState = 'locked' | 'ready' | 'running' | 'review' | 'discuss' | 'approved';
export const STAGES: { id: StageId; no: string; name: string; en: string; who: string; file: string }[] = [
  { id: 'consult', no: '00', name: '咨询', en: 'CONSULT', who: '课程顾问', file: 'study_plan/preflight_plan.md' },
  { id: 'research', no: '01', name: '调研', en: 'RESEARCH', who: '研究台 · 群研 + 精读', file: 'study_plan/research_findings.md' },
  { id: 'scout', no: '02', name: '侦查与适配', en: 'SCOUT · ADAPT', who: '自动化台 · 例程 + 节点图', file: 'study_plan/scout_report.md' },
  { id: 'blueprint', no: '03', name: '课程蓝图', en: 'BLUEPRINT', who: '备课', file: 'study_plan/blueprint.md' },
  { id: 'build', no: '04', name: '单元备课', en: 'UNIT PACK', who: '备课', file: 'study_plan/units/U1/pack.md' },
  { id: 'review', no: '05', name: '独立审查', en: 'REVIEW', who: '审查（独立角色）', file: 'study_plan/units/U1/review.md' },
  { id: 'open', no: '06', name: '开课门禁', en: 'GATE', who: '门禁', file: 'study_plan/units/U1/gate.json' },
];

/* ———— 00 咨询：多轮对话 + 回答卡 → 学习目标与 Preflight Plan ———— */
export const CONSULT: { q: string; card?: { options: string[]; picked: number[] }; a?: string }[] = [
  { q: '你想学群论，是为了什么？', card: { options: ['读懂一本群论入门书', '为后面的抽象代数 / 物理打基础', '准备考试', '纯兴趣'], picked: [0, 1] } },
  { q: '读哪本书？或者有没有想读懂的具体内容？', a: 'Armstrong 的《Groups and Symmetry》，至少前 12 章。' },
  { q: '证明写得怎么样？', card: { options: ['能独立写完整证明', '看得懂，但自己写容易卡住', '基本没写过'], picked: [1] } },
  { q: '每周能投入多少时间？想多久学完？', card: { options: ['每周 3 小时', '每周 5 小时', '每周 8 小时以上'], picked: [1] }, a: '8 周左右。' },
  { q: '学完时，怎样算「学会了」？', a: '不看书能证明拉格朗日定理；给一个图形，能写出它的对称群并判断交不交换。' },
  { q: 'AI 费用和资料费的上限？', card: { options: ['¥30 以内', '¥60 以内', '不设上限，每段问我'], picked: [1] } },
];
export const GOAL = {
  goal: '读懂 Armstrong《Groups and Symmetry》前 12 章，能用群的语言描述对称。',
  success: ['不看书写出拉格朗日定理的完整证明，每一步注明依据', '给定平面图形，写出它的对称群、阶与乘法表，并判断是否交换', '期末独立考试正确率 ≥ 80%，证明题不低于 70%'],
  base: ['集合与映射、函数复合：熟练', '证明：看得懂，自己写容易卡住', '线性代数：学过矩阵乘法'],
  limits: ['每周约 5 小时，共 8 周', 'AI 与资料费用上限 ¥60', '中文讲解，原书为英文', '主要在 iPad 上学'],
};
export const PREFLIGHT = [
  { stage: '调研', what: '研究适合你的学习方法与学习路线；这一步不找具体教材。', budget: '¥8 · 研究台', out: '结构化调研结果（含负结果）+ 下一阶段 Plan' },
  { stage: '侦查与适配', what: '逐个核实候选资源能否打开、能否读取、价格与替代；在预算内转成可教学内容。', budget: '¥15 · 自动化台', out: '侦查报告 + 可回到页码 / 时间戳的适配内容' },
  { stage: '蓝图', what: '组织成全程能力模块大纲：先修顺序、用时、核心资源、期末覆盖。', budget: '¥4', out: '蓝图；首轮只创建第一个单元' },
];

/* ———— 01 调研（研究台） ———— */
export const METHODS = [
  { id: 'M1', name: '先例后定义', claim: '先从正方形的对称操作出发，再抽象出群公理。', evidence: 'Carter《Visual Group Theory》第 1–2 章的组织方式；APOS 理论（Dubinsky）关于抽象概念形成的研究', fit: '你有几何直觉、证明写作弱', conf: '高' },
  { id: 'M2', name: '证明脚手架', claim: '先给证明骨架填空，再逐步撤掉骨架独立写。', evidence: 'Velleman《How to Prove It》第 3 章；Selden & Selden 关于证明构造的研究', fit: '针对「看得懂，自己写容易卡住」', conf: '中' },
  { id: 'M3', name: '检索练习 + 间隔复习', claim: '定义与定理做间隔复习卡；每周一次不看书回忆证明。', evidence: 'Roediger & Karpicke（2006）检索练习研究', fit: '8 周、每周 5 小时，需要防遗忘', conf: '高' },
  { id: 'M4', name: '可视化工具辅助', claim: '用 Cayley 图与乘法表看结构，但不替代证明。', evidence: 'Group Explorer（免费，Carter 维护）', fit: '辅助理解，不作为考核依据', conf: '中' },
];
export const ROUTES = [
  { id: 'A', name: '对称直观 → 公理', steps: ['对称操作', '群公理', '循环群与二面体群', '子群与陪集', '拉格朗日定理', '置换群', '同态与商群'], why: '顺序与 Armstrong 前 12 章一致，先例后定义。', pick: true },
  { id: 'B', name: '公理先行', steps: ['群公理', '基本性质', '子群', '同态', '例子'], why: '更快，但对证明写作要求高，和你的基础不匹配。', pick: false },
  { id: 'C', name: '计算驱动（GAP / SymPy）', steps: ['用代码枚举群', '验证性质', '再看证明'], why: '适合程序背景，作为补充练习，不作主线。', pick: false },
];
export const NEGATIVES = [
  '没找到带证明脚手架的中文群论入门视频（检索 B 站、中国大学 MOOC，4 组关键词）。',
  '没找到 Armstrong 的官方习题答案；网上流传的答案集来源不明，不采用。',
  '「8 周学完群论」类经验帖 12 篇，均无可核实的学习效果，不作为依据。',
];

/* ———— 02 侦查与适配（自动化台） ———— */
export type Check = 'ok' | 'no' | 'part' | 'unknown';
export type Res = { id: string; name: string; kind: string; open: [Check, string]; read: [Check, string]; price: string; unknown: string; alt: string; status: 'usable' | 'limited' | 'dead' | 'gap' | 'skip'; core?: boolean; tries?: string[] };
export const RESOURCES: Res[] = [
  { id: 'R1', name: 'Armstrong《Groups and Symmetry》', kind: '教材 · Springer 1988', open: ['no', '需购买（电子版或纸书）'], read: ['no', '没有合法可读文本，需要你上传自己的副本'], price: '约 €40', unknown: '你手上是否已有纸质书', alt: 'R4 MIT 讲义可覆盖约 60% 内容', status: 'gap', core: true },
  { id: 'R2', name: 'Carter《Visual Group Theory》', kind: '教材 · MAA 2009', open: ['no', '需购买'], read: ['no', '无可读文本'], price: '约 $60', unknown: '—', alt: 'R3 Group Explorer + 公开讲座', status: 'limited' },
  { id: 'R3', name: 'Group Explorer 3', kind: '可视化工具 · 网页', open: ['ok', '免费网页'], read: ['ok', '可导出 Cayley 图与乘法表'], price: '免费', unknown: '—', alt: '—', status: 'usable' },
  { id: 'R4', name: 'MIT OCW 18.703 Modern Algebra 讲义', kind: '讲义 PDF · CC BY-NC-SA', open: ['ok', '公开下载'], read: ['ok', 'PDF 有文本层'], price: '免费', unknown: '—', alt: '—', status: 'usable' },
  { id: 'R5', name: 'Socratica · Abstract Algebra', kind: '视频 · YouTube 10 集', open: ['ok', '可以观看'], read: ['part', '英文字幕可取，第 7 集缺字幕'], price: '免费', unknown: '—', alt: '第 7 集内容由 R4 第 3 节覆盖', status: 'usable' },
  { id: 'R6', name: 'B 站「近世代数」系列', kind: '视频', open: ['no', '链接 404'], read: ['no', '—'], price: '—', unknown: '是否换了地址', alt: 'R5', status: 'dead', tries: ['10-13 09:12 GET → 404', '10-13 09:40 搜索同名系列 → 无结果'] },
  { id: 'R7', name: 'Dummit & Foote《Abstract Algebra》', kind: '教材', open: ['no', '需购买'], read: ['no', '—'], price: '约 $90', unknown: '—', alt: '难度高于目标，不采用', status: 'skip' },
];
export const STATUS_LABEL: Record<Res['status'], string> = { usable: '可用', limited: '受限 · 可选', dead: '失效', gap: '核心缺口', skip: '不采用' };
export type Job = { id: string; res: string; what: string; how: string; state: 'done' | 'partial' | 'wait' | 'fail'; check: string; optional?: boolean; cost: number };
export const JOBS: Job[] = [
  { id: 'A1', res: 'R4', what: '讲义 PDF → 图文解析', how: '自动化台 · 例程 WF-11 + 节点图「PDF 图文解析」', state: 'done', check: '抽样核验 5/5：定义 1.1、定理 2.3 与原文页码一致；图 3 已截取', cost: 3.6 },
  { id: 'A2', res: 'R5', what: '视频 → 转录（带时间戳）', how: '自动化台 · 例程 WF-12', state: 'partial', check: '9/10 集完成；第 7 集缺字幕（可选项失败，不影响全局）', optional: true, cost: 4.1 },
  { id: 'A3', res: 'R1', what: '教材 → OCR（保留页码）', how: '自动化台 · 节点图「扫描页 OCR」', state: 'wait', check: '等你上传自己的副本——这是核心缺口', cost: 0 },
  { id: 'A4', res: 'R3', what: 'Cayley 图与乘法表截图（C₄、D₃、D₄）', how: '自动化台 · 例程 WF-13', state: 'done', check: '3/3 与 Group Explorer 原图一致', cost: 2.1 },
];

/* ———— 03 蓝图 ———— */
export type UnitState = 'uncreated' | 'created' | 'review-fail' | 'ready' | 'learning' | 'passed';
export type Unit = { id: string; name: string; hours: number; res: string[] };
export const MODULES: { id: string; name: string; hours: number; pre: string[]; units: Unit[]; final: string }[] = [
  { id: 'M1', name: '对称与群', hours: 10, pre: [], final: '群公理与基本性质', units: [{ id: 'U1', name: '对称操作与群的定义', hours: 5, res: ['R4 §1', 'R1 第 1–2 章', 'R5 第 1–3 集'] }, { id: 'U2', name: '循环群与二面体群', hours: 5, res: ['R4 §2', 'R1 第 4 章'] }] },
  { id: 'M2', name: '子群与陪集', hours: 10, pre: ['M1'], final: '拉格朗日定理（证明）', units: [{ id: 'U3', name: '子群与生成元', hours: 5, res: ['R1 第 5 章'] }, { id: 'U4', name: '陪集与拉格朗日定理', hours: 5, res: ['R1 第 11 章', 'R4 §4'] }] },
  { id: 'M3', name: '置换群', hours: 8, pre: ['M1'], final: '轮换分解与奇偶性', units: [{ id: 'U5', name: '置换与轮换分解', hours: 4, res: ['R1 第 6 章'] }, { id: 'U6', name: '凯莱定理', hours: 4, res: ['R1 第 8 章'] }] },
  { id: 'M4', name: '同态与商群', hours: 10, pre: ['M2', 'M3'], final: '第一同构定理（陈述与应用）', units: [{ id: 'U7', name: '同态、同构与核', hours: 5, res: ['R1 第 7 章'] }, { id: 'U8', name: '正规子群与商群', hours: 5, res: ['R1 第 12 章'] }] },
];
export const UNITS = MODULES.flatMap(m => m.units.map(u => ({ ...u, module: m.id })));

/* ———— 04 单元备课包（U1） ———— */
export const PACK = {
  goals: ['判断一个集合与运算是否构成群：逐条检查四条公理', '写出正方形对称群 D₄ 的 8 个元素与乘法表中的任意一格', '证明单位元唯一、逆元唯一，每一步注明所用公理'],
  hours: 5, exam: '单元考核 6 题（判断 2 · 计算 2 · 证明 2），通过线 70%，且至少一道证明题达标',
  prereq: [['集合与映射', '函数复合'], ['函数复合', '二元运算'], ['二元运算', '群公理'], ['群公理', 'D₄ 与 C₄'], ['群公理', '单位元 / 逆元唯一']] as [string, string][],
  explain: [
    { text: '群是一个非空集合 G 和一个二元运算，满足封闭、结合、有单位元、每个元素有逆元。', src: 'R4 讲义 p.2 · 定义 1.1' },
    { text: '正方形有 8 个对称操作：4 个旋转（含不动）和 4 个翻折，合起来记作 D₄。', src: 'R1 Armstrong 第 1 章 · p.3' },
    { text: '对称操作的「乘法」就是先做一个、再做另一个；顺序不同，结果可能不同。', src: 'R5 第 2 集 03:40–05:10' },
    { text: '群的阶是元素个数；元素的阶是它自乘多少次回到单位元。', src: null as string | null },
    { text: '交换律不是群公理；D₄ 是不交换的群。', src: 'R4 讲义 p.4 · 例 1.6' },
  ],
  exercises: [
    { id: 'E1', q: '整数集 ℤ 配上减法，是群吗？说明哪一条公理不满足。', ref: '不是。减法不满足结合律：(1−2)−3 ≠ 1−(2−3)。' },
    { id: 'E2', q: '在 D₄ 中，R 是 90° 旋转、F 是沿竖直轴翻折。R·F 与 F·R 相等吗？', ref: '相等，R·F = F·R。', wrong: true, fixed: '不相等。R·F 与 F·R 是两条不同对角线方向的翻折，所以 D₄ 不交换。' },
    { id: 'E3', q: '证明：群的逆元是唯一的。', ref: '设 b、c 都是 a 的逆元。b = b·e = b·(a·c) = (b·a)·c = e·c = c。每一步依次用了单位元、逆元、结合律。' },
  ],
  rubric: { wrong: [['写出结论', 3], ['推理过程', 1]] as [string, number][], fixed: [['明确假设（设 b、c 都是逆元）', 1], ['推理链完整，每步注明所用公理', 2], ['结论与推理一致', 1]] as [string, number][] },
  misconceptions: ['把交换律当作群公理', '以为单位元可以因元素而异', '把「每个元素有逆元」写成「每个元素是自己的逆」', '证明时从结论倒推，再假装它成立'],
  remedy: '若证明题未达标：证明脚手架练习 3 题（逐步撤掉骨架）+ 重看 R5 第 3 集 02:10–06:40。',
  unknowns: ['Armstrong 与 MIT 讲义的记号不同（r/s 与 R/F），已统一为 R/F，待你确认', 'R5 第 7 集缺字幕，相关内容只用 R4 讲义'],
};

/* ———— 05 独立审查：三处故意放入的错误必须判为不通过；每轮只修失败项，最多三轮 ———— */
export type Verdict = { id: string; check: string; pass: boolean; note: string };
export const REVIEW_ROUNDS: Verdict[][] = [
  [
    { id: 'C1', check: '单元目标可考核', pass: true, note: '3 个目标都对应考核题' },
    { id: 'C2', check: '先修关系完整', pass: true, note: '集合与映射 → 二元运算 → 公理' },
    { id: 'C3', check: '练习参考解答正确', pass: false, note: 'E2 的参考解答写成 R·F = F·R——在 D₄ 中二者不相等。错误答案会被当作标准。' },
    { id: 'C4', check: '每条讲解可溯源', pass: false, note: '第 4 条「群的阶与元素的阶」没有出处，不能只看检索到的来源数量。' },
    { id: 'C5', check: '评分依据与目标一致', pass: false, note: '证明题 rubric 给「写出结论」3 分、推理 1 分：权重颠倒，只抄结论就能拿大半分。' },
    { id: 'C6', check: '常见误区覆盖目标', pass: true, note: '4 条误区都对应目标' },
    { id: 'C7', check: '补救安排可执行', pass: true, note: '时间戳可定位' },
  ],
  [
    { id: 'C3', check: '练习参考解答正确', pass: true, note: 'E2 已改：R·F ≠ F·R，并说明是两条不同对角线方向的翻折。' },
    { id: 'C4', check: '每条讲解可溯源', pass: true, note: '补上出处：R4 讲义 p.6 · 定义 1.9；原文核对一致。' },
    { id: 'C5', check: '评分依据与目标一致', pass: false, note: '权重已改为推理 2 分，但「结论 1 分」在推理错误时仍可拿到：结论必须与推理一致才给分。' },
  ],
  [
    { id: 'C5', check: '评分依据与目标一致', pass: true, note: '改为「结论与推理一致」才给 1 分；rubric 版本锁定为 v1.2。' },
  ],
];

/* ———— 学习：课堂（OpenMAIC 幻灯片）、精读、练习、复习、考核 ———— */
export const LESSON = [
  { title: '对称操作与群', sub: 'U1 · 第 1 讲', say: '今天从一个正方形开始。我们不先背定义，而是先问：有哪些动作，做完之后正方形看起来没变？', src: 'R1 第 1 章' },
  { title: '正方形的 8 个对称操作', sub: '4 个旋转 + 4 个翻折', say: '转 0°、90°、180°、270°，再加上四条对称轴的翻折，一共 8 个。注意「不动」也算一个操作，它就是单位元。', src: 'R1 p.3' },
  { title: '操作的「乘法」', sub: '先做一个，再做另一个', say: '把两个操作接着做，就得到第三个操作。我们把它写成乘法，但要记住：顺序可能有关系。', src: 'R5 第 2 集 03:40' },
  { title: '群的四条公理', sub: '封闭 · 结合 · 单位元 · 逆元', say: '把刚才看到的性质抽象出来，就是群的定义。注意，这里没有交换律。', src: 'R4 p.2 定义 1.1' },
  { title: 'R·F ≠ F·R', sub: 'D₄ 不交换', say: '先转 90° 再翻折，和先翻折再转 90°，得到的是两条不同对角线方向的翻折。所以 D₄ 是不交换的群。', src: 'R4 p.4 例 1.6' },
  { title: '小结', sub: '下一步：练习与考核', say: '记住：定义只要求四条公理。用例子理解，用定义判断。接下来做三道练习，有不懂的就在右边问我。', src: '' },
];
export const READING = [
  { page: 'R4 · p.2', head: '定义 1.1（群）', body: '群是一个集合 G，连同一个把 G 中任意两个元素 a、b 对应到 G 中元素 a·b 的运算，满足：（1）对所有 a、b、c，(a·b)·c = a·(b·c)；（2）存在 e，使得对所有 a，e·a = a·e = a；（3）对每个 a，存在 a⁻¹，使得 a·a⁻¹ = a⁻¹·a = e。', note: '封闭性藏在「运算把两个元素对应到 G 中元素」这句话里，不是漏掉了。', ask: '封闭性为什么没有单独列出来？' },
  { page: 'R4 · p.4', head: '例 1.6（D₄）', body: '正方形的对称群有 8 个元素。设 R 为逆时针旋转 90°，F 为关于竖直轴的翻折，则 R⁴ = e，F² = e，且 F·R = R³·F。特别地，R·F ≠ F·R。', note: '这一行是「D₄ 不交换」的直接证据，考核会用到。', ask: '为什么 F·R = R³·F？' },
  { page: 'R4 · p.6', head: '定义 1.9（阶）', body: '群 G 的阶是 G 中元素的个数，记作 |G|。元素 a 的阶是使 aⁿ = e 的最小正整数 n；若不存在这样的 n，则称 a 的阶为无穷。', note: '「群的阶」和「元素的阶」是两件事，常被混用。', ask: 'D₄ 中 R 的阶是多少？' },
];
export const D4 = ['e', 'R', 'R²', 'R³', 'F', 'RF', 'R²F', 'R³F'];
export const REVIEW_CARDS = [
  { front: '群的四条公理是？', back: '封闭、结合、单位元、逆元（交换律不是）。' },
  { front: 'D₄ 有多少个元素？', back: '8 个：4 个旋转 + 4 个翻折。' },
  { front: '「群的阶」与「元素的阶」的区别？', back: '前者是元素个数；后者是自乘回到单位元的最小次数。' },
  { front: '证明逆元唯一时，关键用了哪条公理？', back: '结合律：把 b·(a·c) 改写成 (b·a)·c。' },
];
export type Q = { id: string; kind: '判断' | '计算' | '证明'; q: string; options?: string[]; ref: number | string; pts: number; refWrong?: boolean; refFixed?: number };
export const EXAM: Q[] = [
  { id: 'Q1', kind: '判断', q: '交换律是群的公理之一。', options: ['对', '错'], ref: 1, pts: 1 },
  { id: 'Q2', kind: '判断', q: '{1, −1} 在普通乘法下构成群。', options: ['对', '错'], ref: 0, pts: 1 },
  { id: 'Q3', kind: '计算', q: 'D₄ 中，元素 R（90° 旋转）的阶是？', options: ['2', '4', '8'], ref: 1, pts: 1 },
  { id: 'Q4', kind: '计算', q: 'ℤ₆ = {0,1,2,3,4,5} 在模 6 乘法下构成群吗？', options: ['构成', '不构成'], ref: 0, pts: 1, refWrong: true, refFixed: 1 },
  { id: 'Q5', kind: '证明', q: '证明：群的单位元是唯一的。', ref: '设 e、e′ 都是单位元。e = e·e′（e′ 是单位元）= e′（e 是单位元）。', pts: 4 },
  { id: 'Q6', kind: '证明', q: '证明：若群 G 中每个元素都满足 a·a = e，则 G 是交换群。', ref: '对任意 a、b：a·b = (a·b)⁻¹ = b⁻¹·a⁻¹ = b·a，因为每个元素都是自己的逆。', pts: 4 },
];
export const RUBRIC_VERSION = 'v1.2 · 10-16 锁定';

/* ———— 动作画布（审计） ———— */
export type Act = { at: string; stage: StageId; who: string; act: string; cost: number; result: string };
export const ACTS: Act[] = [
  { at: '10-12 20:14', stage: 'consult', who: '课程顾问', act: '多轮咨询 · 6 张回答卡', cost: .6, result: '学习目标 + Preflight Plan' },
  { at: '10-12 20:31', stage: 'consult', who: '你', act: '批准 Preflight Plan', cost: 0, result: '只批准「调研」' },
  { at: '10-13 08:02', stage: 'research', who: '研究台 · 群研', act: '32 个 Agent 检索学习方法与路线', cost: 4.8, result: '4 种方法 · 3 条路线 · 3 条负结果' },
  { at: '10-13 08:40', stage: 'research', who: '研究台 · 精读', act: '精读 Velleman 第 3 章、Roediger 2006', cost: 1.9, result: '2 条证据' },
  { at: '10-13 09:05', stage: 'research', who: '你', act: '讨论修改：路线 B 为什么不选', cost: .3, result: '补充理由（不是批准）' },
  { at: '10-13 09:10', stage: 'research', who: '你', act: '批准调研 · 交回侦查 Plan', cost: 0, result: '只批准「侦查与适配」' },
  { at: '10-13 09:12', stage: 'scout', who: '自动化台 · 例程', act: '逐个核实 7 个候选资源', cost: 1.2, result: '可用 3 · 受限 1 · 失效 1 · 缺口 1 · 不采用 1' },
  { at: '10-13 10:30', stage: 'scout', who: '自动化台 · 节点图', act: '适配 A1 / A2 / A4', cost: 9.8, result: 'A2 第 7 集失败（可选）' },
  { at: '10-14 21:00', stage: 'blueprint', who: '备课', act: '组织蓝图 · 4 模块 8 单元', cost: 1.4, result: '只创建 U1' },
  { at: '10-14 21:20', stage: 'blueprint', who: '你', act: '批准蓝图', cost: 0, result: '允许创建 U1' },
  { at: '10-16 19:02', stage: 'build', who: '备课', act: '生成 U1 备课包', cost: 2.7, result: '7 部分' },
  { at: '10-16 19:30', stage: 'review', who: '审查（独立）', act: '第 1 轮审查', cost: 1.1, result: '不通过 · 3 项' },
];
export const BUDGET = 60;
