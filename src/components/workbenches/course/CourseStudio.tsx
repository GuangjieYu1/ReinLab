import { useEffect, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../BenchFrame';
import AgentDock, { type DockDraft, type DockEvent } from '../AgentDock';
import Explorer, { Tree, type ExplorerSection, type ExplorerViewDef, type TreeNode } from '../engineering/Explorer';
import type { BenchProps } from '../WorkbenchStudio';
import { ACTS, BUDGET, JOBS, MODULES, RESOURCES, REVIEW_ROUNDS, STAGES, UNITS, type Act, type Job, type Q, type Res, type StageId, type StageState, type UnitState } from './model';
import PrepFace from './PrepFace';
import LearnFace, { grade, total, type ExamResult, type Tab } from './LearnFace';
import '../engineering/dev.css';
import './course.css';

// 课程台 CURR：OpenMAIC（课堂）× DeepTutor（备课链）。自学：你既是审批人，也是学生。
// 01 备课：门禁流水线（咨询 → 调研 → 侦查与适配 → 蓝图 → 单元备课 → 独立审查 → 开课）+ 审阅文档 + 动作画布（可导出审计）。
//    调研交给研究台，侦查与适配交给自动化台；课程台只发起、审批、收结果。
// 02 学习：单元地图 + 单元内标签（课堂 / 精读 / 练习 / 复习 / 考核 / 收尾）+ 带定位的学习工作区（每个单元一条会话）。
// 门禁对页面、工作区与接口一视同仁。全部为前端示例。

type Face = 'prep' | 'learn';
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const stamp = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock()}`; };
let seq = 0; const uid = () => `c${++seq}`;
const OPEN: UnitState[] = ['ready', 'learning', 'passed'];

const FILES: TreeNode[] = [{ name: 'study_plan', path: 'study_plan', children: [
  { name: 'goal.md', path: 'consult', ext: 'MD' }, { name: 'preflight_plan.md', path: 'consult#plan', ext: 'MD' },
  { name: 'research_findings.md', path: 'research', ext: 'MD' }, { name: 'scout_report.md', path: 'scout', ext: 'MD' },
  { name: 'adapt', path: 'adapt', children: JOBS.map(j => ({ name: `${j.id}_${j.res}.json`, path: `scout#${j.id}`, ext: 'JSON' })) },
  { name: 'blueprint.md', path: 'blueprint', ext: 'MD' },
  { name: 'units', path: 'units', children: [{ name: 'U1', path: 'u1', children: [{ name: 'pack.md', path: 'build', ext: 'MD' }, { name: 'review.md', path: 'review', ext: 'MD' }, { name: 'gate.json', path: 'open', ext: 'JSON' }] }] },
  { name: 'audit.jsonl', path: 'audit', ext: 'LOG' },
] }];

export default function CourseStudio({ file, reduced, chrome }: BenchProps) {
  const [face, setFace] = useState<Face>('prep');
  const [stage, setStage] = useState<StageId>('review');
  const [states, setStates] = useState<Record<StageId, StageState>>({ consult: 'approved', research: 'approved', scout: 'approved', blueprint: 'approved', build: 'approved', review: 'review', open: 'locked' });
  const [acts, setActs] = useState<Act[]>(ACTS);
  const [resources, setResources] = useState<Res[]>(RESOURCES);
  const [jobs, setJobs] = useState<Job[]>(JOBS);
  const [uploaded, setUploaded] = useState(false);
  const [units, setUnits] = useState<Record<string, UnitState>>(() => Object.fromEntries(UNITS.map(u => [u.id, u.id === 'U1' ? 'review-fail' : 'uncreated'])));
  const [round, setRound] = useState(0), [fixing, setFixing] = useState(false);
  const reviewPassed = REVIEW_ROUNDS[round].every(v => v.pass);
  const [unit, setUnit] = useState('U1'), [tab, setTab] = useState<Tab>('class'), [page, setPage] = useState(0);
  const [ans, setAns] = useState<Record<string, number | string>>({});
  const [result, setResult] = useState<ExamResult | null>(null);
  const [closed, setClosed] = useState(false), [profileVer, setProfileVer] = useState<0 | 1 | 2>(0);
  const [ctx, setCtx] = useState('课堂 · 第 1 页');
  const [audit, setAudit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [xpOpen, setXpOpen] = useState(true);
  const [ev, setEv] = useState<Record<string, DockEvent[]>>(() => ({
    prep: [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是备课顾问。「群论 · 对称与群」已经走到 U1 的独立审查：第 1 轮不通过，3 项——都是故意放进去测审查的错误。每轮只修失败项，最多三轮。另外侦查报告里还有一个核心缺口（Armstrong 正文），开课前要补上。</p> }],
    ...Object.fromEntries(UNITS.map(u => [u.id, [{ id: uid(), kind: 'agent', at: clock(), text: <p>这是 {u.id}「{u.name}」的学习工作区。从课堂、讲义或题目里发起的提问，会带上这个单元、对应资源和位置；切到别的单元是另一条会话。</p> } as DockEvent]])),
  }));
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? 30 : ms)); };
  const key = face === 'prep' ? 'prep' : unit;
  const keyRef = useRef(key); keyRef.current = key;
  const push = (e: DockDraft, k = keyRef.current) => { const id = e.id ?? uid(); setEv(m => ({ ...m, [k]: [...(m[k] ?? []), { ...e, id } as DockEvent] })); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => setEv(m => Object.fromEntries(Object.entries(m).map(([k, l]) => [k, l.map(e => e.id === id ? { ...e, ...p } as DockEvent : e)])));
  const say = (text: ReactNode, k?: string) => push({ kind: 'agent', text, at: clock() }, k);
  const act = (a: Omit<Act, 'at'>) => setActs(l => [...l, { ...a, at: stamp() }]);
  const tool = (action: string, label: string, ms: number, detail: string, then: () => void, k?: string, failed = false) => {
    setBusy(true); const id = push({ kind: 'tool', action, label, state: 'running' }, k); const t0 = performance.now();
    later(ms, () => { setBusy(false); patch(id, { state: failed ? 'failed' : 'done', ms: performance.now() - t0, detail } as Partial<DockEvent>); then(); });
  };

  /* ———— 备课 ———— */
  const approve = (s: StageId) => {
    const i = STAGES.findIndex(x => x.id === s), next = STAGES[i + 1];
    setStates(m => ({ ...m, [s]: 'approved', ...(next && m[next.id] === 'locked' ? { [next.id]: 'ready' } : {}) }));
    act({ stage: s, who: '你', act: `批准${STAGES[i].name}`, cost: 0, result: next ? `只放行「${next.name}」` : '—' });
    say(<p>已批准「{STAGES[i].name}」。{next ? <>只放行「{next.name}」，不会自动开始。</> : null}</p>, 'prep');
  };
  const discuss = (s: StageId) => {
    setStates(m => ({ ...m, [s]: 'discuss' }));
    push({ kind: 'user', text: `「${STAGES.find(x => x.id === s)!.name}」我想再讨论一下`, at: clock() }, 'prep');
    tool('plan.revise', '按讨论意见修改，不改变批准状态', 1200, '已修改 · 仍待批准', () => { setStates(m => ({ ...m, [s]: 'review' })); act({ stage: s, who: '你', act: '讨论修改', cost: .3, result: '修改后仍待批准（讨论 ≠ 批准）' }); say(<p>改好了，状态仍是「待批准」——讨论修改不等于批准。</p>, 'prep'); }, 'prep');
  };
  const upload = () => {
    if (uploaded) return;
    push({ kind: 'user', text: '上传了我自己的 Armstrong 副本（扫描版 PDF）', at: clock() }, 'prep');
    setResources(l => l.map(r => r.id === 'R1' ? { ...r, open: ['ok', '你已有副本'], read: ['ok', '你上传的扫描版 · OCR'], status: 'usable', unknown: '—' } : r));
    setJobs(l => l.map(j => j.id === 'A3' ? { ...j, state: 'partial', check: 'OCR 进行中…' } : j));
    tool('automation.graph.run 扫描页 OCR', '只处理这一个缺口：R1 第 1–2 章 OCR（保留页码）', 1800, '抽样核验 4/4 页码一致 · ¥1.8', () => {
      setUploaded(true); setJobs(l => l.map(j => j.id === 'A3' ? { ...j, state: 'done', check: 'OCR 第 1–2 章完成；抽样核验 4/4：p.3、p.9、p.12、p.17 与原页一致', cost: 1.8 } : j));
      act({ stage: 'scout', who: '自动化台 · 节点图', act: 'R1 OCR（只补这一个缺口）', cost: 1.8, result: '核心缺口已补；其他未解决项不变' });
      say(<p>R1 的缺口补上了。只解决了这一项：R2 仍是受限、A2 第 7 集仍缺字幕——这两项照样留在报告里，不算「全部通过」。</p>, 'prep');
    }, 'prep');
  };
  const createUnit = (id: string) => {
    push({ kind: 'user', text: `创建 ${id}`, at: clock() }, 'prep');
    tool(`POST /units/${id}`, `创建单元 ${id}`, 600, units.U1 === 'passed' ? '409 · 首轮之后的单元需要先回到备课：为 U2 生成备课包' : '409 · 拒绝：首轮只创建第一个单元；U1 通过前不能创建后续单元', () => say(units.U1 === 'passed' ? <p>接口拒绝了：U1 虽然通过了，但 {id} 还没有备课包，要先在备课面为它生成备课包并通过独立审查。</p> : <p>接口拒绝了：首轮只创建 U1。这不是把按钮藏起来，而是创建接口本身不放行。</p>, 'prep'), 'prep', true);
  };
  const fix = () => {
    if (round >= 2 || fixing) return;
    const fails = REVIEW_ROUNDS[round].filter(v => !v.pass).map(v => v.id);
    setFixing(true); setStates(m => ({ ...m, review: 'running' }));
    tool('pack.patch', `备课 · 只修失败项 ${fails.join('、')}`, 1100, `${fails.length} 项`, () => {
      act({ stage: 'build', who: '备课', act: `只修失败项 ${fails.join('、')}`, cost: .8, result: '其余部分不动' });
      tool('review.run', `审查（独立）· 第 ${round + 2} 轮 · 只重审失败项`, 1200, '', () => {
        const r = round + 1, pass = REVIEW_ROUNDS[r].every(v => v.pass);
        setRound(r); setFixing(false); setStates(m => ({ ...m, review: pass ? 'approved' : 'review', ...(pass ? { open: 'ready' } : {}) }));
        if (pass) setUnits(m => ({ ...m, U1: 'created' }));
        act({ stage: 'review', who: '审查（独立）', act: `第 ${r + 1} 轮审查`, cost: .6, result: pass ? '通过' : `不通过 · ${REVIEW_ROUNDS[r].filter(v => !v.pass).length} 项` });
        say(pass ? <p>第 {r + 1} 轮通过。rubric 锁定为 v1.2。开课门禁还要检查材料是否齐全。</p> : <p>第 {r + 1} 轮还剩 {REVIEW_ROUNDS[r].filter(v => !v.pass).length} 项不通过：{REVIEW_ROUNDS[r].filter(v => !v.pass).map(v => v.note).join('')} 我不会把这条检查放宽。</p>, 'prep');
      }, 'prep');
    }, 'prep');
  };
  const openUnit = () => {
    if (!reviewPassed || !uploaded) return;
    setUnits(m => ({ ...m, U1: 'ready' })); setStates(m => ({ ...m, open: 'approved' }));
    act({ stage: 'open', who: '你', act: '开课 · U1', cost: 0, result: '门禁检查 4/4' });
    say(<p>U1 开课了。去「学习」面上课；U2 之后的单元要等 U1 通过后再备课。</p>, 'prep');
  };

  /* ———— 学习 ———— */
  const gateWhy = (id: string) => {
    if (units[id] === 'uncreated') return ['未创建：首轮只创建 U1', ...(units.U1 !== 'passed' ? ['前一单元 U1 还没通过——页面、工作区、接口都不会放行'] : [])];
    const w: string[] = [];
    if (!reviewPassed) w.push(`独立审查未通过：第 ${round + 1} 轮还有 ${REVIEW_ROUNDS[round].filter(v => !v.pass).length} 项`);
    if (!uploaded) w.push('核心材料缺口：R1 Armstrong 第 1–2 章');
    if (reviewPassed && uploaded) w.push('还没有在开课门禁点「开课」');
    return w;
  };
  const pickUnit = (id: string) => { setUnit(id); setTab('class'); setCtx(id === 'U1' ? '课堂 · 第 1 页' : '单元页'); if (id === 'U1' && units.U1 === 'ready') setUnits(m => ({ ...m, U1: 'learning' })); };
  useEffect(() => { if (face === 'learn' && unit === 'U1' && units.U1 === 'ready') setUnits(m => ({ ...m, U1: 'learning' })); }, [face, unit, units.U1]);
  const ask = (c: string, q?: string) => {
    setCtx(c);
    if (!OPEN.includes(units[unit])) return tool('tutor.answer', `回答 · ${unit}`, 400, `403 · ${unit} 未开课`, () => say(<p>{unit} 还没开课，学习工作区不会开始正式教学。</p>, unit), unit, true);
    if (!q) return say(<p>好，定位到「{c}」。你想问什么？</p>, unit);
    push({ kind: 'user', text: q, at: clock() }, unit);
    const answers: [RegExp, ReactNode][] = [
      [/封闭/, <p>在 R4 p.2 的写法里，运算被定义成「G × G → G」的映射——结果一定落在 G 里，所以封闭性已经包含在「运算」这个词里了。有的书（比如 Armstrong 第 2 章）会把它单独列出来，两种写法等价。<cite>R4 · p.2</cite></p>],
      [/F·R|R³/, <p>把左上角跟着走一遍：先 R（逆时针 90°）把它送到左下，再 F（竖直轴翻折）送到右下；而 R³F 也把左上角送到右下、右上角送到右上，两者完全一致，所以 F·R = R³·F。课堂第 5 页的两个小正方形就是这个对比。<cite>R4 · p.4 · 例 1.6</cite></p>],
      [/阶/, <p>R 自乘 4 次才回到不动，所以 R 的阶是 4；而 D₄ 这个群的阶是 8（元素个数）。别把两个「阶」混在一起。<cite>R4 · p.6 · 定义 1.9</cite></p>],
      [/提示|卡住/, <p>提示（不给答案）：先写出你要证明的东西用到的定义，再看哪一步需要「结合律」把括号挪个位置。</p>],
    ];
    const hit = answers.find(([r]) => r.test(q + c));
    later(500, () => say(hit ? hit[1] : <p>就「{c}」来说：先回到定义，逐条检查。需要的话我可以出一道同类的小题让你试。</p>, unit));
  };
  const sendLearn = (text: string) => {
    push({ kind: 'user', text, at: clock() }, unit);
    if (/U[2-8]|下一单元|第[二三四五六七八]单元|跳|直接学|期末/.test(text)) {
      const target = text.match(/U[2-8]/)?.[0] ?? (/期末/.test(text) ? '期末' : 'U2');
      return tool('POST /learning/advance', `推进到 ${target}`, 500, units.U1 === 'passed' ? `409 · ${target} 未创建，需先备课` : '403 · 前一单元 U1 未通过：页面、聊天与接口都不放行', () => say(<p>{units.U1 === 'passed' ? `${target} 还没有创建，要先回到备课面生成备课包并通过审查。` : '换个入口也一样：U1 没通过之前，后面的正式学习都不会开始。'}</p>, unit), unit, true);
    }
    if (/降低|放宽|去掉.*检查|直接通过/.test(text)) return later(400, () => say(<p>不行：没有靠降低标准换取通过的出口。</p>, unit));
    ask(ctx, text);
  };
  const submit = () => {
    const r = grade(ans); setResult(r); setUnits(m => ({ ...m, U1: r.pass ? 'passed' : 'learning' }));
    act({ stage: 'open', who: '你', act: 'U1 单元考核提交', cost: 0, result: `${r.total}/${r.max} · ${r.pass ? '通过' : '未通过'}` });
    say(<p>按 rubric v1.2 评完了：{r.total} / {r.max}，{r.pass ? '通过' : '未通过'}。{!r.pass && '单次考试失败不会触发收尾，也不会锁死——可以按补救安排复习后再考。'}如果你觉得哪题判错了，可以提异议，由独立角色按同一版 rubric 复核。</p>, 'U1');
  };
  const dispute = (q: Q) => {
    if (!result) return;
    setResult(r => r && { ...r, items: { ...r.items, [q.id]: { ...r.items[q.id], disputed: 'pending' } } });
    push({ kind: 'user', text: `对 ${q.id} 提异议`, at: clock() }, 'U1');
    tool('grading.review', `复核（独立角色）· ${q.id} · 同一版 rubric v1.2 与材料`, 1500, '保留原判与更正', () => {
      setResult(r => {
        if (!r) return r;
        const g = r.items[q.id], fixedOk = q.refWrong && ans[q.id] === q.refFixed;
        const corrected = fixedOk ? { got: q.pts, note: '参考答案有误：0 在模 6 乘法下没有逆元，ℤ₆ 不构成群。你的答案正确，不计为你的错误。' } : { got: g.got, note: '复核维持原判：理由同上。' };
        const next = total({ ...r.items, [q.id]: { ...g, disputed: 'done', corrected } });
        setUnits(m => ({ ...m, U1: next.pass ? 'passed' : m.U1 }));
        return next;
      });
      act({ stage: 'open', who: '复核（独立）', act: `${q.id} 评分复核`, cost: .2, result: q.refWrong ? '参考答案更正 · 原判保留' : '维持原判' });
      say(q.refWrong ? <p>复核结论：{q.id} 的参考答案错了。原判和更正都保留在记录里，这题不计为你的错误。</p> : <p>复核维持原判。</p>, 'U1');
    }, 'U1');
  };
  const closeUnit = () => tool('unit.close', 'U1 正式收尾 · 生成学习者侧写与能力掌握档案', 1600, '2 份档案 · 每条可追溯到原始对话与作答', () => { setClosed(true); setProfileVer(1); act({ stage: 'open', who: '课程', act: 'U1 正式收尾', cost: .9, result: '双档案 v1' }); }, 'U1');
  const reanalyze = () => {
    const id = uid();
    push({ id, kind: 'approval', title: '用更强模型重新分析 U1 档案', effects: ['范围：U1 全部对话、练习与考核作答', '预算：¥3（剩余 ¥' + (BUDGET - acts.reduce((s, a) => s + a.cost, 0)).toFixed(1) + '）', '采用前保留 v1，可随时切回'], action: 'profile.reanalyze', risk: 'write', state: 'pending',
      onApprove: () => { patch(id, { state: 'approved' } as Partial<DockEvent>); tool('profile.reanalyze', '更强模型重新分析', 1400, 'v2 · v1 已保留', () => { setProfileVer(2); act({ stage: 'open', who: '课程', act: '档案重新分析', cost: 2.6, result: 'v2（v1 保留）' }); }, 'U1'); },
      onReject: () => patch(id, { state: 'rejected' } as Partial<DockEvent>) }, 'U1');
  };

  /* ———— 资源管理器与助手 ———— */
  const VIEWS: ExplorerViewDef[] = face === 'prep'
    ? [{ id: 'files', label: 'study_plan', icon: <svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3z" /></svg> }]
    : [{ id: 'units', label: '单元地图', icon: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="6" /><rect x="15" y="4" width="6" height="6" /><rect x="9" y="14" width="6" height="6" /><path d="M6 10v2h12v-2M12 12v2" /></svg> }];
  const sections: ExplorerSection[] = face === 'prep'
    ? [{ id: 'tree', title: 'study_plan/', grow: true, body: <Tree nodes={FILES} active={stage} defaultOpen={() => true} onOpen={path => { const s = path.split('#')[0]; if (STAGES.some(x => x.id === s)) setStage(s as StageId); if (path === 'audit') setAudit(true); }} /> }]
    : [...MODULES.map(m => ({ id: m.id, title: `${m.id} · ${m.name}`, count: m.units.length, body: <div className="cu-umap">{m.units.map(u => <button key={u.id} aria-current={u.id === unit || undefined} data-s={units[u.id]} onClick={() => pickUnit(u.id)}>
      <i /><span><b>{u.id} · {u.name}</b><small>{{ uncreated: '未创建', created: '已创建 · 未开课', 'review-fail': '审查未通过', ready: '可开课', learning: '学习中', passed: '已通过' }[units[u.id]]} · {u.hours}h</small></span></button>)}</div> })),
      { id: 'final', title: '期末', body: <div className="cu-umap"><button data-s="uncreated" onClick={() => sendLearn('我想直接去期末')}><i /><span><b>独立期末考试</b><small>全部单元通过后开放 · 不用 U8 考核兼作</small></span></button></div> }];
  const cur = STAGES.findIndex(s => states[s.id] !== 'approved');
  const plan = face === 'prep' ? { stages: STAGES.map(s => s.name), current: cur < 0 ? STAGES.length - 1 : cur }
    : { stages: ['课堂', '练习', '考核', '收尾'], current: closed ? 3 : result ? (result.pass ? 3 : 2) : tab === 'practice' || tab === 'review' ? 1 : tab === 'exam' ? 2 : 0 };
  const suggestions = face === 'prep' ? [
    ...(!reviewPassed ? [{ id: 'f', label: '只修失败项', onClick: () => { setStage('review'); fix(); } }] : []),
    ...(!uploaded ? [{ id: 'u', label: '上传教材副本', onClick: () => { setStage('scout'); upload(); } }] : []),
    { id: 'c', label: '试着创建 U2', onClick: () => createUnit('U2') }, { id: 'a', label: '导出审计', onClick: () => setAudit(true) },
  ] : [
    { id: 'e', label: '解释这一页', onClick: () => ask(ctx, `解释一下${ctx}`) }, { id: 's', label: '我卡住了', onClick: () => ask(ctx, '我卡住了，给个提示') }, { id: 'j', label: '直接去学 U3', onClick: () => sendLearn('我想直接学 U3') },
  ];
  const spent = acts.reduce((s, a) => s + a.cost, 0);

  return <BenchFrame code="CURR" section="001" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as Face)}
    faces={[{ id: 'prep', label: '备课', en: 'PREPARE', badge: (reviewPassed ? 0 : 1) + (uploaded ? 0 : 1) || undefined }, { id: 'learn', label: '学习', en: 'LEARN' }]}
    strip={<>群论 · 对称与群 <i>·</i> 4 模块 8 单元 <i>·</i> 已创建 {Object.values(units).filter(s => s !== 'uncreated').length} <i>·</i> ¥{spent.toFixed(1)} / ¥{BUDGET}</>}
    shutterLines={f => [`> mount ${f.en.toLowerCase()} · study_plan/`, f.id === 'prep' ? `> gates ${STAGES.filter(s => states[s.id] === 'approved').length}/${STAGES.length} open` : `> unit ${unit} · ${units[unit]}`, '> ready']}
    status={<><span><i className="en-sq" />群论 · 对称与群</span><span>自学</span><span data-alert={!reviewPassed || undefined}>U1 审查 {reviewPassed ? '通过' : `第 ${round + 1} 轮不通过`}</span><span data-alert={!uploaded || undefined}>核心缺口 {uploaded ? 0 : 1}</span><span>费用 ¥{spent.toFixed(1)} / ¥{BUDGET}</span><span>示例数据 · 不连接模型</span></>}>
    <div className="cu" data-face={face}>
      <Explorer code="CURR" open={xpOpen} view={face === 'prep' ? 'files' : 'units'} onView={() => {}} onToggle={() => setXpOpen(v => !v)} views={VIEWS} key={face} title={face === 'prep' ? 'study_plan/' : '蓝图 · 8 单元'} sections={sections} />
      {face === 'prep' ? <PrepFace stage={stage} onStage={setStage} states={states} acts={acts} resources={resources} jobs={jobs} uploaded={uploaded} onUpload={upload}
        units={units} onCreateUnit={createUnit} round={round} fixing={fixing} onFix={fix} onOpenUnit={openUnit} reviewPassed={reviewPassed}
        onApprove={approve} onDiscuss={discuss} onAudit={() => setAudit(true)} delegated={b => { window.location.assign(`${window.location.pathname}?preview=workbench&studio=${b}&file=${b === 'research' ? 0 : 3}`); }} />
        : <LearnFace unit={unit} state={units[unit]} tab={tab} onTab={t => { setTab(t); setCtx({ class: `课堂 · 第 ${page + 1} 页`, read: '精读 · R4 讲义', practice: '练习', review: '复习卡', exam: '单元考核', close: '收尾' }[t]); }}
          page={page} onPage={n => { setPage(n); setCtx(`课堂 · 第 ${n + 1} 页`); }} onAsk={ask} reduced={reduced} ans={ans} onAns={(id, v) => setAns(m => ({ ...m, [id]: v }))} result={result} onSubmit={submit} onDispute={dispute}
          closed={closed} onClose={closeUnit} profileVer={profileVer} onReanalyze={reanalyze} onGoPrep={() => { setFace('prep'); setStage(units[unit] === 'uncreated' ? 'blueprint' : !reviewPassed ? 'review' : !uploaded ? 'scout' : 'open'); }} gateWhy={gateWhy(unit)} />}
      <AgentDock name={face === 'prep' ? '备课顾问' : '学习工作区'} target={face === 'prep' ? `study_plan · ${STAGES.find(s => s.id === stage)!.name}` : `${unit} · ${ctx}`}
        plan={plan} suggestions={suggestions} events={ev[key] ?? []} busy={busy}
        onSend={text => { if (face === 'learn') return sendLearn(text); push({ kind: 'user', text, at: clock() }, 'prep'); if (/降低|放宽|去掉/.test(text)) return later(400, () => say(<p>不行：每轮只修失败项，没有靠降低标准换取通过的出口。</p>, 'prep')); if (/创建/.test(text)) return createUnit(text.match(/U[1-8]/)?.[0] ?? 'U2'); later(400, () => say(<p>当前在「{STAGES.find(s => s.id === stage)!.name}」：{STAGES.find(s => s.id === stage)!.who}负责。需要我做什么？</p>, 'prep')); }}
        placeholder={face === 'prep' ? '讨论这一段，或「创建 U2」试试门禁' : `问 ${unit} · 会带上当前位置`} footnote={face === 'learn' ? `会话：${unit} · 位置：${ctx}` : '批准只放行下一段 · 讨论 ≠ 批准'} />
      {audit && <div className="cu-modal" onClick={() => setAudit(false)}><div onClick={e => e.stopPropagation()}>
        <header><b>审计导出 · audit.jsonl</b><button onClick={() => setAudit(false)}>×</button></header>
        <p>按时间顺序 {acts.length} 个动作，复建同一执行顺序与费用汇总。</p>
        <pre>{acts.map(a => JSON.stringify({ at: a.at, stage: a.stage, who: a.who, act: a.act, cost: a.cost })).join('\n')}</pre>
        <table className="cu-table"><tbody>{STAGES.map(s => { const c = acts.filter(a => a.stage === s.id); return c.length ? <tr key={s.id}><td>{s.no} {s.name}</td><td>{c.length} 个动作</td><td><b>¥{c.reduce((x, a) => x + a.cost, 0).toFixed(1)}</b></td></tr> : null; })}<tr><td><b>合计</b></td><td>{acts.length}</td><td><b>¥{spent.toFixed(1)} / ¥{BUDGET}</b></td></tr></tbody></table>
        <p className="cu-small">■ 复建校验：顺序与画布一致，费用合计一致。（演示中不下载文件。）</p>
      </div></div>}
    </div>
  </BenchFrame>;
}
