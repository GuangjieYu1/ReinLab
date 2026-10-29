import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Mobius } from '../rhine/RhineMark';
import { SignalDot } from '../rhine/primitives';
import './agent-dock.css';

// Agent 坞 · 所有工作台共用（设计语言 §7）。
// 自上而下：头部（维护对象）→ 计划 → 建议动作 → 对话流（消息、折叠成一行的工具调用、审批卡）→ 输入框。
// 按钮与 Agent 共用动作表：宿主把动作的执行过程写成事件，这里只负责呈现。

export type Risk = 'read' | 'write' | 'danger';
export type DockEvent =
  | { id: string; kind: 'user'; text: string; at: string }
  | { id: string; kind: 'agent'; text: ReactNode; at: string }
  | { id: string; kind: 'tool'; action: string; label: string; detail?: string; state: 'running' | 'done' | 'failed'; ms?: number }
  | { id: string; kind: 'approval'; action: string; title: string; effects: string[]; risk: Risk; state: 'pending' | 'approved' | 'rejected' | 'expired'; onApprove: () => void; onReject: () => void }
  | { id: string; kind: 'card'; body: ReactNode }
  /** 操作提示：用户在页面上做了什么（改名、删除、移除材料……）。一行灰字，不是聊天，不算「你说」。 */
  | { id: string; kind: 'note'; text: string; at: string };

/** 新事件（id 可省略，由宿主生成）。对联合类型逐个去掉 id。 */
export type DockDraft = DockEvent extends infer E ? E extends DockEvent ? Omit<E, 'id'> & { id?: string } : never : never;

/** 建议动作：onClick 直接执行；给了 fill 就只把这段文字填进输入框，等你补全后再发。 */
export type Suggestion = { id: string; label: string; onClick?: () => void; fill?: string; hint?: string };

const RISK_LABEL: Record<Risk, string> = { read: '只读', write: '写入 · 需审批', danger: '危险 · 只能你点' };

export default function AgentDock({ name, target, plan, suggestions, events, busy, loop, onSend, placeholder = '对助手说，或用 / 调用动作', footnote }: {
  name: string; target: string;
  plan: { stages: string[]; current: number };
  suggestions: Suggestion[];
  events: DockEvent[];
  busy: boolean;
  /** 循环正在运行时显示莫比乌斯（设计语言 §6.2）。 */
  loop?: { stages: string[]; current: number } | null;
  onSend: (text: string) => void;
  placeholder?: string; footnote?: string;
}) {
  const [draft, setDraft] = useState('');
  const [planOpen, setPlanOpen] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const use = (s: Suggestion) => { if (s.fill !== undefined) { setDraft(s.fill); requestAnimationFrame(() => { const el = input.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); } else s.onClick?.(); };
  useEffect(() => { const el = list.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [events.length, busy]);
  const submit = (event?: FormEvent) => { event?.preventDefault(); const text = draft.trim(); if (!text) return; onSend(text); setDraft(''); };
  return (
    <aside className="ad rh-panel" data-wb-panel aria-label={`${name} · Agent 坞`}>
      <header className="ad-head">
        <span className="ad-block">AGENT<i /></span>
        <div><strong>{name}</strong><span className="rh-micro" title={target}>{target}</span></div>
        <SignalDot state={busy ? 'wait' : 'on'} label={busy ? '工作中' : '在线'} />
      </header>

      <section className="ad-plan">
        <button className="ad-plan-head" onClick={() => setPlanOpen(v => !v)} aria-expanded={planOpen}>
          <span className="rh-micro">PLAN · 计划</span><b>{plan.current + 1} / {plan.stages.length}</b><em>{planOpen ? '收起' : '展开'}</em>
        </button>
        <div className="rh-rail" aria-hidden="true">{plan.stages.map((_, i) => <i key={i} className={i < plan.current ? 'is-done' : i === plan.current ? 'is-now' : ''} />)}</div>
        {planOpen && <ol className="ad-plan-list">{plan.stages.map((s, i) => <li key={s} data-state={i < plan.current ? 'done' : i === plan.current ? 'now' : undefined}><em>{String(i + 1).padStart(2, '0')}</em>{s}</li>)}</ol>}
      </section>

      {loop && <div className="ad-loop"><Mobius stages={loop.stages} current={loop.current} running width={200} /></div>}

      <div className="ad-suggest" role="group" aria-label="建议动作">
        {suggestions.map(s => <button key={s.id} className="rh-btn is-ghost" onClick={() => use(s)} title={s.hint} disabled={busy && s.fill === undefined}>{s.label}</button>)}
      </div>

      <div className="ad-stream" ref={list} aria-live="polite">
        {events.map(e => <Event key={e.id} e={e} />)}
        {busy && <div className="ad-typing"><i /><i /><i /></div>}
      </div>

      <form className="ad-input" onSubmit={submit}>
        <textarea ref={input} value={draft} onChange={e => setDraft(e.target.value)} placeholder={placeholder} rows={2}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <div><span className="rh-micro">{footnote ?? '@ 引用对象 · / 调用动作 · 写入需审批'}</span><button type="submit" className="rh-btn is-solid" disabled={!draft.trim()}>发送</button></div>
      </form>
    </aside>
  );
}

function Event({ e }: { e: DockEvent }) {
  if (e.kind === 'user') return <div className="ad-msg is-user rh-enter"><span className="ad-who">你</span><p>{e.text}</p><time className="rh-micro">{e.at}</time></div>;
  if (e.kind === 'agent') return <div className="ad-msg is-agent rh-enter"><span className="ad-who">AI</span><div>{e.text}</div><time className="rh-micro">{e.at}</time></div>;
  if (e.kind === 'tool') return (
    <div className="ad-tool rh-enter" data-state={e.state}>
      <span className="ad-tool-k">▸</span><code>{e.action}</code><span>{e.label}</span>
      <em>{e.state === 'running' ? '运行中' : e.state === 'failed' ? '失败' : `${((e.ms ?? 0) / 1000).toFixed(1)}s`}</em>
      {e.detail && <small>{e.detail}</small>}
    </div>
  );
  if (e.kind === 'approval') return (
    <div className="ad-approval rh-approval rh-enter" data-state={e.state}>
      <span className="rh-micro">待审批 · {RISK_LABEL[e.risk]}</span>
      <strong>{e.title}</strong>
      <ul>{e.effects.map(x => <li key={x}>{x}</li>)}</ul>
      <code className="rh-micro">{e.action}</code>
      {e.state === 'pending'
        ? <div className="ad-approval-act"><button className="rh-btn is-solid" onClick={e.onApprove}>批准</button><button className="rh-btn" onClick={e.onReject}>驳回</button></div>
        : <span className="ad-approval-done">{e.state === 'approved' ? '■ 已批准' : e.state === 'expired' ? '已过期' : '已驳回'}</span>}
    </div>
  );
  if (e.kind === 'note') return <div className="ad-note rh-enter" role="note"><span>·</span>{e.text}<time className="rh-micro">{e.at}</time></div>;
  return <div className="ad-card rh-enter">{e.body}</div>;
}
