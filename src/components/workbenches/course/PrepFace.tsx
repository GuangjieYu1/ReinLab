import { useState } from 'react';
import { BUDGET, CONSULT, GOAL, METHODS, MODULES, NEGATIVES, PACK, PREFLIGHT, REVIEW_ROUNDS, ROUTES, RUBRIC_VERSION, STAGES, STATUS_LABEL, type Act, type Check, type Job, type Res, type StageId, type StageState, type UnitState } from './model';

// 备课面：上面是门禁流水线（每段之间都是一道门：讨论修改 ≠ 批准；只批准了上一段，不会自动往下做），
// 中间是当前段的审阅文档，底部是动作画布——每个实际动作、谁做的、花了多少，可以导出审计复建同一顺序与费用。

export const STATE_LABEL: Record<StageState, string> = { locked: '锁定', ready: '可开始', running: '执行中', review: '待批准', discuss: '讨论中', approved: '已批准' };
const CHECK: Record<Check, string> = { ok: '✓', no: '✕', part: '◐', unknown: '?' };

export type PrepProps = {
  stage: StageId; onStage: (s: StageId) => void; states: Record<StageId, StageState>;
  acts: Act[]; resources: Res[]; jobs: Job[]; uploaded: boolean; onUpload: () => void;
  units: Record<string, UnitState>; onCreateUnit: (id: string) => void;
  round: number; fixing: boolean; onFix: () => void; onOpenUnit: () => void; reviewPassed: boolean;
  onApprove: (s: StageId) => void; onDiscuss: (s: StageId) => void; onAudit: () => void; delegated: (bench: string) => void;
};

export default function PrepFace(p: PrepProps) {
  const [canvasOpen, setCanvasOpen] = useState(true);
  const spent = p.acts.reduce((s, a) => s + a.cost, 0);
  const st = STAGES.find(s => s.id === p.stage)!;
  return <div className="cu-center cu-prep" data-canvas={canvasOpen || undefined}>
    <header className="cu-head">
      <span className="cu-id">G-01</span>
      <div className="cu-title"><strong>群论 · 对称与群</strong><span>自学 <i>·</i> 8 周 · 每周 5 小时 <i>·</i> 预算 ¥{BUDGET} · 已用 ¥{spent.toFixed(1)}</span></div>
      <div className="cu-bounds" aria-label="三道边界">
        <span data-on>蓝图已批准</span><i>≠</i><span data-on={p.units.U1 !== 'uncreated' || undefined}>U1 已创建</span><i>≠</i><span data-on={['ready', 'learning', 'passed'].includes(p.units.U1) || undefined}>U1 可开课</span>
      </div>
    </header>
    <ol className="cu-pipe" aria-label="备课流水线">
      {STAGES.map((s, i) => <li key={s.id} data-state={p.states[s.id]} aria-current={s.id === p.stage || undefined}>
        {i > 0 && <i className="cu-gate" data-open={p.states[STAGES[i - 1].id] === 'approved' || undefined} title={p.states[STAGES[i - 1].id] === 'approved' ? '门已打开' : '门关着：上一段未批准'} />}
        <button onClick={() => p.onStage(s.id)}><b>{s.no}</b><span>{s.name}<small>{s.who}</small></span><em>{STATE_LABEL[p.states[s.id]]}</em></button>
      </li>)}
    </ol>
    <div className="cu-doc" key={p.stage}>
      <div className="cu-docpath"><span className="rh-micro">{st.file}</span><b>{st.no} · {st.name}</b><em>{st.who}</em></div>
      {p.stage === 'consult' && <Consult />}
      {p.stage === 'research' && <Research delegated={p.delegated} />}
      {p.stage === 'scout' && <Scout resources={p.resources} jobs={p.jobs} uploaded={p.uploaded} onUpload={p.onUpload} delegated={p.delegated} />}
      {p.stage === 'blueprint' && <Blueprint units={p.units} onCreate={p.onCreateUnit} />}
      {p.stage === 'build' && <Pack round={p.round} />}
      {p.stage === 'review' && <Review round={p.round} fixing={p.fixing} onFix={p.onFix} passed={p.reviewPassed} />}
      {p.stage === 'open' && <Gate passed={p.reviewPassed} uploaded={p.uploaded} unit={p.units.U1} onOpen={p.onOpenUnit} />}
      <GateCard stage={p.stage} state={p.states[p.stage]} onApprove={p.onApprove} onDiscuss={p.onDiscuss} />
    </div>
    <section className="cu-canvas">
      <header><button onClick={() => setCanvasOpen(v => !v)} aria-expanded={canvasOpen}>{canvasOpen ? '▾' : '▸'} 动作画布 · 每个实际动作可追溯</button><small>{p.acts.length} 个动作 · ¥{spent.toFixed(1)} / ¥{BUDGET}</small><button className="rh-btn" onClick={p.onAudit}>导出审计</button></header>
      {canvasOpen && <ol>{p.acts.map((a, i) => <li key={i} data-stage={a.stage} data-you={a.who === '你' || undefined} data-cur={a.stage === p.stage || undefined}>
        <time>{a.at}</time><b>{STAGES.find(s => s.id === a.stage)!.no}</b><em>{a.who}</em><span>{a.act}</span><small>{a.result}</small><code>{a.cost ? `¥${a.cost.toFixed(1)}` : '—'}</code></li>)}</ol>}
    </section>
  </div>;
}

/** 每段文档底部的门：批准 / 讨论修改（讨论不算批准）。 */
function GateCard({ stage, state, onApprove, onDiscuss }: { stage: StageId; state: StageState; onApprove: (s: StageId) => void; onDiscuss: (s: StageId) => void }) {
  if (stage === 'review' || stage === 'open') return null;
  const next = STAGES[STAGES.findIndex(s => s.id === stage) + 1];
  if (state === 'approved') return <div className="cu-gatecard" data-state="approved"><b>■ 已批准</b><span>只放行下一段「{next.name}」。下一段需要你手动开始，不会自动往下做。</span></div>;
  if (state === 'locked') return <div className="cu-gatecard" data-state="locked"><b>门关着</b><span>上一段还没批准，这一段的接口会直接拒绝。</span></div>;
  return <div className="cu-gatecard" data-state={state}>
    <b>{state === 'discuss' ? '讨论中 · 还没有批准' : '待你批准'}</b><span>批准后只放行「{next.name}」。「讨论修改」会让助手按你的意见改，改完仍要你批准。</span>
    <div><button className="rh-btn is-solid" onClick={() => onApprove(stage)}>批准</button><button className="rh-btn" onClick={() => onDiscuss(stage)}>讨论修改</button></div>
  </div>;
}

function Consult() {
  return <div className="cu-cols">
    <ol className="cu-chat">{CONSULT.map((c, i) => <li key={i}><p className="cu-q"><i>顾问</i>{c.q}</p>
      {c.card && <div className="cu-answercard">{c.card.options.map((o, k) => <span key={o} data-on={c.card!.picked.includes(k) || undefined}>{o}</span>)}</div>}
      {c.a && <p className="cu-a"><i>你</i>{c.a}</p>}</li>)}</ol>
    <div className="cu-goal">
      <section><h4>学习目标</h4><p className="cu-big">{GOAL.goal}</p></section>
      <section><h4>成功标准</h4><ol>{GOAL.success.map(s => <li key={s}>{s}</li>)}</ol></section>
      <section className="cu-two"><div><h4>基础</h4><ul>{GOAL.base.map(s => <li key={s}>{s}</li>)}</ul></div><div><h4>约束</h4><ul>{GOAL.limits.map(s => <li key={s}>{s}</li>)}</ul></div></section>
      <section><h4>Preflight Plan <small>study_plan/preflight_plan.md</small></h4>
        <table className="cu-table"><thead><tr><th>阶段</th><th>做什么</th><th>预算</th><th>交回</th></tr></thead><tbody>{PREFLIGHT.map(r => <tr key={r.stage}><td><b>{r.stage}</b></td><td>{r.what}</td><td>{r.budget}</td><td>{r.out}</td></tr>)}</tbody></table></section>
    </div>
  </div>;
}

function Research({ delegated }: { delegated: (b: string) => void }) {
  return <div className="cu-stack">
    <p className="cu-delegate">由<b>研究台</b>执行：群研广搜 32 个 Agent，精读 2 篇关键文献。这一步只研究方法与路线，不找具体教材。<button onClick={() => delegated('research')}>打开研究台 ↗</button></p>
    <section><h4>学习方法 <small>{METHODS.length} 种</small></h4><div className="cu-methods">{METHODS.map(m => <div key={m.id}><header><b>{m.id}</b><strong>{m.name}</strong><em data-c={m.conf}>置信度 {m.conf}</em></header><p>{m.claim}</p><small>证据：{m.evidence}</small><small>为什么适合你：{m.fit}</small></div>)}</div></section>
    <section><h4>学习路线 <small>选 A</small></h4><div className="cu-routes">{ROUTES.map(r => <div key={r.id} data-pick={r.pick || undefined}><b>{r.id} · {r.name}</b><ol>{r.steps.map(s => <li key={s}>{s}</li>)}</ol><p>{r.why}</p></div>)}</div></section>
    <section className="cu-neg"><h4>负结果 <small>没找到也记录</small></h4><ul>{NEGATIVES.map(n => <li key={n}>{n}</li>)}</ul></section>
    <section><h4>交回的下一阶段 Plan · 侦查与适配</h4><p>候选资源 7 个，按「你能不能打开 · AI 能不能读 · 价格 · 未知项 · 替代」逐个核实；适配预算 ¥15，只转换选定资源。</p></section>
  </div>;
}

function Scout({ resources, jobs, uploaded, onUpload, delegated }: { resources: Res[]; jobs: Job[]; uploaded: boolean; onUpload: () => void; delegated: (b: string) => void }) {
  const used = jobs.reduce((s, j) => s + j.cost, 0);
  return <div className="cu-stack">
    <p className="cu-delegate">由<b>自动化台</b>执行：核实用例程 WF-10，适配用节点图（PDF 图文解析、扫描页 OCR、转录）。失效的来源留下尝试记录；补缺只换路线、复用已有效的成果，不重跑整轮。<button onClick={() => delegated('automation')}>打开自动化台 ↗</button></p>
    {!uploaded && <div className="cu-coregap"><b>核心缺口</b><span>R1 Armstrong 教材正文——U1 需要第 1–2 章。上传你自己的副本，只会解决这一个缺口；其他未解决项照样显示。</span><button className="rh-btn is-solid" onClick={onUpload}>上传我的副本</button></div>}
    <section><h4>侦查 · 逐个核实 <small>{resources.length} 个候选</small></h4>
      <table className="cu-table cu-res"><thead><tr><th>资源</th><th>你能打开</th><th>AI 能读</th><th>价格</th><th>未知项</th><th>替代</th><th>状态</th></tr></thead>
        <tbody>{resources.map(r => <tr key={r.id} data-s={r.status}><td><b>{r.id}</b> {r.name}<small>{r.kind}</small>{r.tries && <details><summary>尝试记录 {r.tries.length}</summary>{r.tries.map(t => <code key={t}>{t}</code>)}</details>}</td>
          <td><i data-c={r.open[0]}>{CHECK[r.open[0]]}</i>{r.open[1]}</td><td><i data-c={r.read[0]}>{CHECK[r.read[0]]}</i>{r.read[1]}</td><td>{r.price}</td><td>{r.unknown}</td><td>{r.alt}</td><td><span className="cu-pill" data-s={r.status}>{STATUS_LABEL[r.status]}</span></td></tr>)}</tbody></table></section>
    <section><h4>适配 · 转成教学可用内容 <small>预算 ¥15 · 已用 ¥{used.toFixed(1)}</small></h4>
      <div className="cu-budget"><i style={{ width: `${used / 15 * 100}%` }} /></div>
      <ol className="cu-jobs">{jobs.map(j => <li key={j.id} data-s={j.state}><b>{j.id}</b><span><strong>{j.what}</strong><small>{j.res} · {j.how}</small></span><p>{j.check}</p><em>{{ done: '完成', partial: j.optional ? '部分完成 · 可选项失败' : '部分完成', wait: '等待', fail: '失败' }[j.state]}</em></li>)}</ol>
      <p className="cu-small">可选项失败不升级成全局失败；核心缺口不会被「整体完成率」掩盖。</p></section>
  </div>;
}

function Blueprint({ units, onCreate }: { units: Record<string, UnitState>; onCreate: (id: string) => void }) {
  const total = MODULES.reduce((s, m) => s + m.hours, 0);
  return <div className="cu-stack">
    <section><h4>全程能力模块 <small>{MODULES.length} 模块 · {MODULES.reduce((s, m) => s + m.units.length, 0)} 单元 · 约 {total + 2} 小时（含期末 2 小时）</small></h4>
      <div className="cu-bp">{MODULES.map(m => <div key={m.id} className="cu-mod"><header><b>{m.id}</b><strong>{m.name}</strong><small>{m.hours}h{m.pre.length ? ` · 先修 ${m.pre.join('、')}` : ''}</small></header>
        {m.units.map(u => <div key={u.id} className="cu-unit" data-s={units[u.id]}><b>{u.id}</b><span>{u.name}<small>{u.hours}h · {u.res.join(' · ')}</small></span>
          {units[u.id] === 'uncreated' ? <button onClick={() => onCreate(u.id)}>创建</button> : <em>已创建</em>}</div>)}
        <p>期末覆盖：{m.final}</p></div>)}
        <div className="cu-mod is-final"><header><b>期末</b><strong>独立期末考试</strong><small>2h · 覆盖 M1–M4</small></header><p>不能用最后一个单元的考核兼作期末。</p></div></div></section>
    <p className="cu-small">首轮只创建第一个单元，其余标为「未创建」。在 U1 通过前点「创建」，接口会直接拒绝——不是把按钮藏起来。</p>
  </div>;
}

function Pack({ round }: { round: number }) {
  // 第 2 轮修好了 C3（E2 错解）与 C4（缺出处），第 3 轮修好 C5（rubric）。
  const e2 = round >= 1, src = round >= 1, rub = round >= 2;
  const rubric = rub ? PACK.rubric.fixed : round >= 1 ? [['推理过程', 2], ['注明公理', 1], ['写出结论', 1]] as [string, number][] : PACK.rubric.wrong;
  return <div className="cu-stack cu-pack">
    <section><h4>单元目标 <small>U1 · {PACK.hours} 小时</small></h4><ol>{PACK.goals.map(g => <li key={g}>{g}</li>)}</ol><p className="cu-small">考核：{PACK.exam}</p></section>
    <section><h4>知识与先修</h4><div className="cu-prereq">{PACK.prereq.map(([a, b]) => <span key={a + b}>{a}<i>→</i>{b}</span>)}</div></section>
    <section><h4>可溯源讲解</h4><ol className="cu-explain">{PACK.explain.map((e, i) => { const s = e.src ?? (src ? 'R4 讲义 p.6 · 定义 1.9' : null); return <li key={i} data-miss={!s || undefined} data-fixed={!e.src && src || undefined}><span>{e.text}</span>{s ? <cite>{s}</cite> : <cite className="is-miss">缺出处</cite>}</li>; })}</ol></section>
    <section><h4>自解练习</h4><ol className="cu-ex">{PACK.exercises.map(x => <li key={x.id} data-wrong={x.wrong && !e2 || undefined} data-fixed={x.wrong && e2 || undefined}><b>{x.id}</b><span>{x.q}<small>参考：{x.wrong && e2 ? x.fixed : x.ref}</small></span></li>)}</ol></section>
    <section><h4>评分依据 · 证明题 <small>{rub ? RUBRIC_VERSION : `草稿 r${round + 1}`}</small></h4><table className="cu-table" data-wrong={!rub || undefined}><tbody>{rubric.map(([k, v]) => <tr key={k}><td>{k}</td><td><b>{v} 分</b></td></tr>)}</tbody></table></section>
    <section className="cu-two"><div><h4>常见误区</h4><ul>{PACK.misconceptions.map(m => <li key={m}>{m}</li>)}</ul></div><div><h4>补救安排</h4><p>{PACK.remedy}</p></div></section>
    <section className="cu-neg"><h4>未确定项</h4><ul>{PACK.unknowns.map(u => <li key={u}>{u}</li>)}</ul></section>
  </div>;
}

function Review({ round, fixing, onFix, passed }: { round: number; fixing: boolean; onFix: () => void; passed: boolean }) {
  const fails = REVIEW_ROUNDS[round].filter(v => !v.pass).length;
  return <div className="cu-stack">
    <p className="cu-delegate">审查由<b>独立 AI 角色</b>完成：看不到备课时的对话，只看备课包与资源原文。故意放进去的错误解题、缺出处、错 rubric 必须明确不通过。</p>
    <div className="cu-rounds">{REVIEW_ROUNDS.slice(0, round + 1).map((r, i) => <section key={i} data-pass={r.every(v => v.pass) || undefined}>
      <header><b>第 {i + 1} 轮</b><em>{r.every(v => v.pass) ? '通过' : `不通过 · ${r.filter(v => !v.pass).length} 项`}</em>{i > 0 && <small>只重审上一轮的失败项</small>}</header>
      <ol>{r.map(v => <li key={v.id} data-pass={v.pass || undefined}><i>{v.pass ? '✓' : '✕'}</i><b>{v.id}</b><span>{v.check}<small>{v.note}</small></span></li>)}</ol>
    </section>)}{fixing && <section className="is-running"><header><b>第 {round + 2} 轮</b><em>修正失败项并重审中…</em></header></section>}</div>
    {!passed && <div className="cu-fix"><span>每轮只修失败项；到第 3 轮或预算用完就停。没有靠降低标准换取通过的出口。</span><button className="rh-btn is-solid" onClick={onFix} disabled={fixing || round >= 2}>{round >= 2 ? '已到 3 轮上限' : `只修 ${fails} 个失败项 · 进入第 ${round + 2} 轮`}</button></div>}
    {passed && <div className="cu-gatecard" data-state="approved"><b>■ 审查通过</b><span>三轮内通过。rubric 版本锁定为 {RUBRIC_VERSION}，提交后的考核不会被静默改动。</span></div>}
  </div>;
}

function Gate({ passed, uploaded, unit, onOpen }: { passed: boolean; uploaded: boolean; unit: UnitState; onOpen: () => void }) {
  const checks: [string, boolean, string][] = [['U1 已创建', unit !== 'uncreated', '蓝图批准后创建'], ['独立审查通过', passed, '见 05 · 独立审查'], ['核心材料齐全', uploaded, 'R1 Armstrong 第 1–2 章（侦查报告里的核心缺口）'], ['评分依据已锁定', passed, RUBRIC_VERSION]];
  const ok = checks.every(c => c[1]);
  const open = ['ready', 'learning', 'passed'].includes(unit);
  return <div className="cu-stack">
    <section><h4>开课门禁 · U1</h4><ol className="cu-checks">{checks.map(([k, v, n]) => <li key={k} data-ok={v || undefined}><i>{v ? '✓' : '✕'}</i><b>{k}</b><small>{n}</small></li>)}</ol></section>
    <p className="cu-small">「项目已创建 ≠ 单元可开课」。未审查、审查失败、待补材料的单元，页面、学习工作区和接口都不能开始正式教学。</p>
    {open ? <div className="cu-gatecard" data-state="approved"><b>■ U1 已开课</b><span>去「学习」面上课。</span></div>
      : <button className="cu-open" onClick={onOpen} disabled={!ok}><i />{ok ? '开课 · U1' : `还差 ${checks.filter(c => !c[1]).length} 项`}</button>}
  </div>;
}
