import { useEffect, useRef } from 'react';
import { scrollWithin } from '../scrollWithin';
import { STAGES, type Incident, type Routine, type Run } from './model';
import Steps from './Steps';

// 维护面：一次故障 = 四道工序。诊断（失败那一步 + 证据 + 原因）→ 修复（指令 / 配置的 diff）
// → 沙盒重放（用失败那次的输入重跑，再回放最近几次成功的运行防止改坏）→ 人审上线（只有你能批准，版本号 +0.1）。
// stage = 已完成几道；working = 正在做第几道。

export default function MaintainFace({ inc, r, run, stage, working, replayN, regressN, approved, onNext, onApprove, onReject }: {
  inc: Incident; r: Routine; run: Run | undefined; stage: number; working: number | null; replayN: number; regressN: number; approved: boolean | null;
  onNext: () => void; onApprove: () => void; onReject: () => void;
}) {
  // 每完成一道工序，把新展开的那一节滚到眼前。
  const body = useRef<HTMLDivElement>(null), seen = useRef(stage);
  useEffect(() => { if (stage > seen.current || working !== null) { const last = body.current?.querySelectorAll('.au-panel, .au-scan'); if (last?.length) scrollWithin(last[last.length - 1], 'start'); } seen.current = stage; }, [stage, working]);
  const next = ['开始诊断', '生成修复', '沙盒重放', '提交人审'][stage];
  const nextVer = `v${(parseFloat(r.version.slice(1)) + .1).toFixed(1)}`;
  return <div className="au-center">
    <header className="au-head">
      <span className="au-id is-inc">{inc.id}</span>
      <div className="au-title"><strong>{inc.title}</strong><span>{r.id} {r.name} <i>·</i> {inc.run} <i>·</i> {r.version}</span></div>
      <span className="au-state" data-state={approved ? 'ok' : approved === false ? 'warn' : 'fail'}>{approved ? `已上线 ${r.version}` : approved === false ? '已驳回' : '未解决'}</span>
      <div className="au-head-act">{stage < 4 && approved === null && <button className="au-run" onClick={onNext} disabled={working !== null}><i />{working !== null ? `${STAGES[working]}中` : next}</button>}</div>
    </header>
    <ol className="au-stages" aria-label="维护工序">
      {STAGES.map((s, i) => <li key={s} data-state={i < stage ? 'done' : i === working ? 'now' : i === stage ? 'next' : undefined}>
        <b>{String(i + 1).padStart(2, '0')}</b><span>{s}</span><small>{['DIAGNOSE', 'PATCH', 'SANDBOX', 'REVIEW'][i]}</small><i />
      </li>)}
    </ol>
    <div className="au-maint" ref={body}>
      {stage === 0 && working === null && <div className="au-empty"><b>{inc.title}</b><span>维护 Agent 会先读失败那次的记录，找出原因，再给出修复。点「开始诊断」。</span></div>}
      {working === 0 && <Scanning text="读取运行记录、对比最近 30 次运行" />}

      {stage >= 1 && <section className="au-panel" data-n="01">
        <header><b>诊断</b><small>失败在第 {inc.failStep + 1} 步 · 置信度 {Math.round(inc.confidence * 100)}%</small><span className="au-conf"><i style={{ width: `${inc.confidence * 100}%` }} /></span></header>
        <div className="au-diag">
          <div className="au-diag-run"><span className="rh-micro">{inc.run} · 原运行</span>{run && <Steps steps={run.steps} mark={inc.failStep} compact />}</div>
          <div className="au-diag-why"><p>{inc.cause}</p><ul>{inc.evidence.map(e => <li key={e}>{e}</li>)}</ul></div>
        </div>
      </section>}
      {working === 1 && <Scanning text="改写指令、检查有没有和其他句子冲突" />}

      {stage >= 2 && <section className="au-panel" data-n="02">
        <header><b>修复</b><small>改动：{inc.fix.where}</small></header>
        <p className="au-why">{inc.fix.why}</p>
        <pre className="au-diff">{inc.fix.diff.map((d, i) => <span key={i} data-op={d.op === ' ' ? undefined : d.op}><i>{d.op}</i>{d.text}{'\n'}</span>)}</pre>
      </section>}

      {(stage >= 3 || working === 2) && <section className="au-panel" data-n="03">
        <header><b>沙盒重放</b><small>用 {inc.run} 的输入重跑 · 外部写入全部拦截</small></header>
        <div className="au-replay">
          <div><span className="rh-micro">原运行 · {run?.version ?? r.version}</span>{run && <Steps steps={run.steps} mark={inc.failStep} compact />}</div>
          <div><span className="rh-micro">修复后 · 沙盒</span><Steps steps={inc.replay.slice(0, replayN)} compact live={working === 2} /></div>
        </div>
        <div className="au-regress"><span className="rh-micro">回归 · 重放最近成功的运行</span>
          {inc.regress.map((id, i) => <span key={id} data-s={i < regressN ? 'ok' : working === 2 && i === regressN ? 'now' : undefined}><i />{id}</span>)}
          {stage >= 3 && <b>{inc.regress.length} / {inc.regress.length} 通过 · 0 次真实写入</b>}
        </div>
      </section>}

      {stage >= 3 && <section className="au-panel au-review" data-n="04" data-done={approved !== null || undefined}>
        <header><b>人审上线</b><small>只有你能批准 · 例程不能批准自己的改动</small></header>
        <div className="au-ver"><span>{approved ? r.versions[1]?.[0] : r.version}</span><i>→</i><span data-new>{approved ? r.version : nextVer}</span></div>
        <ul><li>{inc.fix.where}：{inc.fix.why}</li><li>沙盒重放 {inc.run} 通过，回归 {inc.regress.length} 次全部通过</li><li>上线后从下一次触发开始生效；可以随时回滚到 {approved ? r.versions[1]?.[0] : r.version}</li></ul>
        {stage === 3 && approved === null && <div className="au-step-act"><button className="rh-btn is-solid" onClick={onApprove}>批准上线</button><button className="rh-btn" onClick={onReject}>驳回</button></div>}
        {approved && <span className="au-stamp">已上线 · {r.version}</span>}
        {approved === false && <span className="au-stamp is-no">已驳回 · 维持 {r.version}</span>}
      </section>}
    </div>
  </div>;
}

function Scanning({ text }: { text: string }) {
  return <div className="au-scan"><i /><span>{text}</span></div>;
}
