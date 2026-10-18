import { useState } from 'react';
import { EXAM, PACK, READING, REVIEW_CARDS, RUBRIC_VERSION, UNITS, type Q, type UnitState } from './model';
import Classroom from './Classroom';

// 学习面：单元内的标签——课堂（OpenMAIC）/ 精读（原文 + 批注）/ 练习 / 复习 / 考核 / 收尾。
// 单元没通过开课门禁时，这里只显示门禁原因；考核按锁定的 rubric 评分，异议由独立角色复核，原判与更正都保留。

export type Tab = 'class' | 'read' | 'practice' | 'review' | 'exam' | 'close';
export const TABS: [Tab, string][] = [['class', '课堂'], ['read', '精读'], ['practice', '练习'], ['review', '复习'], ['exam', '考核'], ['close', '收尾']];
export type Graded = { got: number; ok: boolean; note: string; disputed?: 'pending' | 'done'; corrected?: { got: number; note: string } };
export type ExamResult = { items: Record<string, Graded>; total: number; max: number; pass: boolean };

/** 按锁定的 rubric v1.2 评分（Q4 的参考答案有误——复核前会错判）。 */
export function grade(ans: Record<string, number | string>): ExamResult {
  const items: Record<string, Graded> = {};
  for (const q of EXAM) {
    const a = ans[q.id];
    if (q.kind !== '证明') { const ok = a === q.ref; items[q.id] = { got: ok ? q.pts : 0, ok, note: ok ? '正确' : `参考答案：${q.options![q.ref as number]}` }; continue; }
    const t = String(a ?? '');
    const hyp = /设|假设|任意/.test(t), axiom = q.id === 'Q5' ? /单位元/.test(t) && /e′|e'|e1|另一个/.test(t) : /逆/.test(t) && /交换|b·a|ba/.test(t), concl = axiom && /[=＝]/.test(t);
    const got = (hyp ? 1 : 0) + (axiom ? 2 : 0) + (concl ? 1 : 0);
    items[q.id] = { got, ok: got >= 3, note: `明确假设 ${hyp ? 1 : 0}/1 · 推理并注明公理 ${axiom ? 2 : 0}/2 · 结论与推理一致 ${concl ? 1 : 0}/1` };
  }
  return total(items);
}
export function total(items: Record<string, Graded>): ExamResult {
  const max = EXAM.reduce((s, q) => s + q.pts, 0), sum = EXAM.reduce((s, q) => s + (items[q.id].corrected?.got ?? items[q.id].got), 0);
  const proofOk = EXAM.filter(q => q.kind === '证明').some(q => (items[q.id].corrected?.got ?? items[q.id].got) >= 3);
  return { items, total: sum, max, pass: sum / max >= .7 && proofOk };
}

export default function LearnFace({ unit, state, tab, onTab, page, onPage, onAsk, reduced, ans, onAns, result, onSubmit, onDispute, closed, onClose, profileVer, onReanalyze, onGoPrep, gateWhy }: {
  unit: string; state: UnitState; tab: Tab; onTab: (t: Tab) => void; page: number; onPage: (n: number) => void; onAsk: (ctx: string, q?: string) => void; reduced: boolean;
  ans: Record<string, number | string>; onAns: (id: string, v: number | string) => void; result: ExamResult | null; onSubmit: () => void; onDispute: (q: Q) => void;
  closed: boolean; onClose: () => void; profileVer: 1 | 2 | 0; onReanalyze: () => void; onGoPrep: () => void; gateWhy: string[];
}) {
  const u = UNITS.find(x => x.id === unit)!;
  const open = ['ready', 'learning', 'passed'].includes(state);
  return <div className="cu-center cu-learn">
    <header className="cu-head">
      <span className="cu-id">{u.id}</span>
      <div className="cu-title"><strong>{u.name}</strong><span>{u.module} <i>·</i> {u.hours} 小时 <i>·</i> {u.res.join(' · ')}</span></div>
      <span className="cu-state" data-s={state}>{{ uncreated: '未创建', created: '已创建 · 未审查', 'review-fail': '审查未通过', ready: '可开课', learning: '学习中', passed: '已通过' }[state]}</span>
      {open && <div className="cu-tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{l}</button>)}</div>}
    </header>
    {!open ? <div className="cu-locked">
      <b>{state === 'uncreated' ? '这个单元还没有创建' : '这个单元还不能开课'}</b>
      <ul>{gateWhy.map(w => <li key={w}>{w}</li>)}</ul>
      <p>门禁对页面、学习工作区和接口一视同仁，换入口也绕不过去。</p>
      <button className="rh-btn is-solid" onClick={onGoPrep}>去备课面处理</button>
    </div> : <div className="cu-tabbody">
      {tab === 'class' && <Classroom page={page} onPage={onPage} onAsk={ctx => onAsk(ctx)} reduced={reduced} />}
      {tab === 'read' && <div className="cu-read">{READING.map(r => <article key={r.page}>
        <header><cite>{r.page}</cite><b>{r.head}</b></header><p>{r.body}</p>
        <aside><span className="rh-micro">批注</span>{r.note}<button onClick={() => onAsk(`精读 · ${r.page} · ${r.head}`, r.ask)}>就这一段提问：{r.ask}</button></aside>
      </article>)}<p className="cu-small">原文为 MIT 18.703 讲义的中文转述（适配任务 A1），页码可回到原 PDF。</p></div>}
      {tab === 'practice' && <Practice onAsk={onAsk} />}
      {tab === 'review' && <Cards />}
      {tab === 'exam' && <Exam ans={ans} onAns={onAns} result={result} onSubmit={onSubmit} onDispute={onDispute} />}
      {tab === 'close' && <Close passed={state === 'passed'} closed={closed} onClose={onClose} ver={profileVer} onReanalyze={onReanalyze} />}
    </div>}
  </div>;
}

function Practice({ onAsk }: { onAsk: (ctx: string, q?: string) => void }) {
  const [txt, setTxt] = useState<Record<string, string>>({}), [shown, setShown] = useState<Record<string, boolean>>({});
  return <div className="cu-practice">{PACK.exercises.map(x => <article key={x.id}>
    <header><b>{x.id}</b><p>{x.q}</p></header>
    <textarea value={txt[x.id] ?? ''} onChange={e => setTxt(m => ({ ...m, [x.id]: e.target.value }))} placeholder="先自己写，再看参考" rows={3} />
    <div><button className="rh-btn is-solid" disabled={!txt[x.id]?.trim()} onClick={() => setShown(m => ({ ...m, [x.id]: true }))}>提交并看参考</button><button className="rh-btn" onClick={() => onAsk(`练习 · ${x.id}`, '给我一个提示，不要直接给答案')}>要提示</button></div>
    {shown[x.id] && <p className="cu-ref">参考：{x.wrong ? x.fixed : x.ref}</p>}
  </article>)}<p className="cu-small">参考解答只在你作答后显示。练习不计分，也不会触发单元收尾。</p></div>;
}

function Cards() {
  const [flip, setFlip] = useState<number[]>([]);
  return <div className="cu-cards"><p className="cu-small">快速复习：面向已有基础的人。卡片不包含单元考核的题目与答案。</p>
    <div>{REVIEW_CARDS.map((c, i) => <button key={i} data-flip={flip.includes(i) || undefined} onClick={() => setFlip(f => f.includes(i) ? f.filter(x => x !== i) : [...f, i])}><span>{c.front}</span><em>{c.back}</em></button>)}</div></div>;
}

function Exam({ ans, onAns, result, onSubmit, onDispute }: { ans: Record<string, number | string>; onAns: (id: string, v: number | string) => void; result: ExamResult | null; onSubmit: () => void; onDispute: (q: Q) => void }) {
  const done = EXAM.every(q => ans[q.id] !== undefined && String(ans[q.id]).trim() !== '');
  return <div className="cu-exam">
    <header><b>U1 单元考核</b><span>6 题 · 满分 {EXAM.reduce((s, q) => s + q.pts, 0)} · 通过线 70% 且至少一道证明题达标 · 评分依据 {RUBRIC_VERSION}</span>
      {result && <em data-pass={result.pass || undefined}>{result.total} / {result.max} · {result.pass ? '通过' : '未通过'}</em>}</header>
    <ol>{EXAM.map(q => { const g = result?.items[q.id]; return <li key={q.id} data-ok={g ? (g.corrected ? g.corrected.got >= q.pts * .75 : g.ok) : undefined}>
      <header><b>{q.id}</b><i>{q.kind} · {q.pts} 分</i><p>{q.q}</p></header>
      {q.options ? <div className="cu-opts">{q.options.map((o, k) => <button key={o} aria-pressed={ans[q.id] === k} disabled={!!result} onClick={() => onAns(q.id, k)}>{o}</button>)}</div>
        : <textarea rows={3} value={String(ans[q.id] ?? '')} disabled={!!result} onChange={e => onAns(q.id, e.target.value)} placeholder="写出完整证明，每一步注明依据" />}
      {g && <div className="cu-grade">
        <span data-ok={g.ok || undefined}><b>{g.corrected ? '原判' : '评分'}</b>{g.got} / {q.pts} · {g.note}</span>
        {g.corrected && <span data-ok><b>复核更正</b>{g.corrected.got} / {q.pts} · {g.corrected.note}</span>}
        {!g.ok && !g.disputed && <button onClick={() => onDispute(q)}>对这题提异议</button>}
        {g.disputed === 'pending' && <small>独立复核中…</small>}
      </div>}
    </li>; })}</ol>
    {!result && <button className="cu-open" onClick={onSubmit} disabled={!done}><i />{done ? '提交考核' : '答完 6 题才能提交'}</button>}
    {result && <p className="cu-small">提交后评分依据不会被静默改动；复核由独立角色按同一版 rubric 与材料完成，错误参考答案复核后不计为你的错误。</p>}
  </div>;
}

const PROFILE = {
  learner: [['证明时先写假设', 'Q5、Q6 都从「设」开始', '考核 Q5 作答'], ['遇到抽象概念先要例子', '工作区里 3 次问「举个例子」', '学习工作区 · 10-17'], ['对 D₄ 的乘法顺序曾经混淆', '练习 E2 第一次作答写成相等', '练习 E2']],
  skill: [['判断群公理', '掌握', '考核 Q1、Q2、Q4（复核后）'], ['D₄ 的元素与乘法', '掌握', '考核 Q3 · 课堂第 5 页提问'], ['证明：单位元 / 逆元唯一', '基本掌握', '考核 Q5 4/4 · Q6 3/4']],
};
function Close({ passed, closed, onClose, ver, onReanalyze }: { passed: boolean; closed: boolean; onClose: () => void; ver: 0 | 1 | 2; onReanalyze: () => void }) {
  if (!passed) return <div className="cu-locked is-soft"><b>考核通过后才能正式收尾</b><p>普通点击、退出、单次考试失败都不会触发收尾。</p></div>;
  if (!closed) return <div className="cu-locked is-soft"><b>U1 已通过</b><p>正式收尾会生成两份档案：学习者侧写与能力掌握档案，都能追溯到原始对话与作答。总结失败不会改写通过成绩。</p><button className="cu-open" onClick={onClose}><i />正式收尾 · U1</button></div>;
  return <div className="cu-close">
    <section><h4>学习者侧写 <small>v{ver}{ver === 2 ? ' · 更强模型 · 已采用' : ''}</small></h4><ul>{PROFILE.learner.map(([a, b, c]) => <li key={a}><b>{a}</b><span>{b}</span><cite>{c}</cite></li>)}{ver === 2 && <li data-new><b>需要先例再定义</b><span>新版本补充：课堂第 2、3 页停留最久，提问都在要例子</span><cite>课堂 · 第 2–3 页</cite></li>}</ul></section>
    <section><h4>能力掌握档案 <small>v{ver}</small></h4><ul>{PROFILE.skill.map(([a, b, c]) => <li key={a}><b>{a}</b><em data-l={b}>{b}</em><cite>{c}</cite></li>)}</ul></section>
    {ver === 1 && <button className="rh-btn" onClick={onReanalyze}>用更强模型重新分析（需批准范围与预算）</button>}
  </div>;
}
