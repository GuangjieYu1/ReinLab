import { useState } from 'react';
import type { Step } from './model';

// 一次运行的逐步记录：左边是相对时间，右边是 Agent 的思考 / 工具调用 / 产出 / 审批 / 错误。
// 工具调用点开看输入与输出；审批就地批准或驳回。运行中的最后一步带闪烁的光标。

const KIND: Record<Step['kind'], string> = { think: '思考', tool: '工具', approval: '审批', artifact: '产出', error: '错误', done: '完成' };
export const fmtT = (t: number) => t < 60 ? `+${t}s` : `+${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s`;

export default function Steps({ steps, live, mark, compact, onApprove, onReject }: {
  steps: Step[]; live?: boolean; mark?: number; compact?: boolean;
  onApprove?: (i: number) => void; onReject?: (i: number) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  return <ol className="au-steps" data-compact={compact || undefined}>
    {steps.map((s, i) => {
      const expandable = !compact && (s.input || s.output);
      return <li key={i} data-kind={s.kind} data-mark={mark === i || undefined} data-live={live && i === steps.length - 1 || undefined} style={{ animationDelay: compact ? undefined : `${Math.min(i, 8) * 40}ms` }}>
        <time>{fmtT(s.t)}</time>
        <i className="au-step-k">{KIND[s.kind]}</i>
        <div className="au-step-body">
          <button className="au-step-line" disabled={!expandable} aria-expanded={expandable ? open === i : undefined} onClick={() => setOpen(o => o === i ? null : i)}>
            {s.tool && <code>{s.tool}</code>}<span>{s.text}</span>{expandable && <em>{open === i ? '收起' : '输入 / 输出'}</em>}
            {compact && s.output && <small>→ {s.output}</small>}
          </button>
          {expandable && open === i && <div className="au-io">
            {s.input && <div><b>IN</b><pre>{s.input}</pre></div>}
            {s.output && <div><b>OUT</b><pre>{s.output}</pre></div>}
          </div>}
          {!expandable && !compact && s.output && <small className="au-step-out">→ {s.output}</small>}
          {s.kind === 'approval' && !compact && (s.state === 'pending'
            ? <div className="au-step-act"><span className="rh-micro">写入 · 需要你确认</span><button className="rh-btn is-solid" onClick={() => onApprove?.(i)}>批准</button><button className="rh-btn" onClick={() => onReject?.(i)}>驳回</button></div>
            : <span className="au-step-done">{s.state === 'approved' ? '■ 已批准' : '已驳回'}</span>)}
        </div>
      </li>;
    })}
  </ol>;
}
