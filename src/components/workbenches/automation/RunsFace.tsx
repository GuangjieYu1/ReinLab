import { STATE_LABEL, type Routine, type Run } from './model';
import Steps from './Steps';

// 运行面：上面是所有例程近 14 天的运行矩阵（一格一天），下面是选中那次运行的逐步记录。
// 运行中的会一步步长出来；需要写入的步骤停在「等你确认」，就地批准。

const DAY0 = new Date(2026, 9, 18);
const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(DAY0); d.setDate(d.getDate() - 13 + i); return d; });
const CELL: Record<string, string> = { o: 'ok', w: 'warn', x: 'fail', W: 'waiting', R: 'running', '-': 'none' };

export default function RunsFace({ routines, r, run, live, onPick, onRun, onApprove, onReject, onRunNow }: {
  routines: Routine[]; r: Routine; run: Run | undefined; live: boolean;
  onPick: (id: string) => void; onRun: (id: string) => void; onApprove: (i: number) => void; onReject: (i: number) => void; onRunNow: () => void;
}) {
  return <div className="au-center">
    <header className="au-head">
      <span className="au-id">{r.id}</span>
      <div className="au-title"><strong>{r.name}</strong><span>{run ? <>{run.id} <i>·</i> {run.at} <i>·</i> {run.trigger} <i>·</i> {run.version}</> : '还没有运行过'}</span></div>
      {run && <span className="au-state" data-state={run.state}>{STATE_LABEL[run.state]}</span>}
      {run && <dl className="au-metrics"><div><dt>用时</dt><dd>{run.took}</dd></div><div><dt>工具调用</dt><dd>{run.calls}<small>/{r.budget.calls}</small></dd></div><div><dt>花费</dt><dd>¥{run.cost.toFixed(2)}</dd></div></dl>}
      <div className="au-head-act"><button className="au-run" onClick={onRunNow} disabled={live}><i />{live ? '运行中' : '立即运行'}</button></div>
    </header>
    <div className="au-runs">
      <section className="au-matrix" aria-label="近 14 天运行">
        <div className="au-mx-head"><span className="rh-micro">近 14 天 · 一格一天</span>{days.map((d, i) => <em key={i} data-today={i === 13 || undefined}>{i % 2 === 1 || i === 13 ? `${d.getMonth() + 1}-${d.getDate()}` : ''}</em>)}</div>
        {routines.map(x => <button key={x.id} className="au-mx-row" aria-current={x.id === r.id || undefined} onClick={() => onPick(x.id)} data-off={!x.enabled || undefined}>
          <span><code>{x.id}</code>{x.name}</span>
          {x.history.padStart(14, '-').slice(-14).split('').map((c, i) => <i key={i} data-s={CELL[c]} />)}
        </button>)}
        <div className="au-mx-legend">{(['ok', 'warn', 'fail', 'waiting'] as const).map(s => <span key={s}><i data-s={s} />{STATE_LABEL[s]}</span>)}<span><i data-s="none" />没有运行</span></div>
      </section>
      <section className="au-trace">
        <div className="au-trace-tabs">{r.runs.slice(0, 6).map(x => <button key={x.id} aria-pressed={x === run} data-state={x.state} onClick={() => onRun(x.id)}><i />{x.id}<small>{x.at}</small></button>)}</div>
        {run ? <>
          <p className="au-trace-note"><b>{run.note}</b>{run.sandbox && <em>沙盒</em>}</p>
          <Steps key={run.id} steps={run.steps} live={live && run.state === 'running'} onApprove={onApprove} onReject={onReject} />
        </> : <div className="au-empty"><b>还没有运行记录</b><span>点「立即运行」跑一次，或者等下一次触发。</span></div>}
      </section>
    </div>
  </div>;
}
