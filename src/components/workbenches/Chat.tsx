import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

export type Tool = { kind: 'read' | 'edit' | 'run' | 'search' | 'plan' | 'map' | 'query'; label: string; detail?: string };
export type Msg = { id: string; who: 'me' | 'ai' | 'sys'; text?: ReactNode; tools?: Tool[]; card?: ReactNode; at?: string; kind?: string };
let seq = 0;
export const msgId = () => `m${++seq}-${Date.now().toString(36)}`;
export const now = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const TOOL_MARK: Record<Tool['kind'], string> = { read: 'READ', edit: 'EDIT', run: 'RUN', search: 'FIND', plan: 'PLAN', map: 'MAP', query: 'SQL' };

/** One conversation column, shared by the workbenches. The host decides what a reply is. */
export default function Chat({ title, agent, messages, onSend, suggestions = [], placeholder = '给智能体发消息', note, busy = false, chips, className = '' }: {
  title: string; agent: string; messages: Msg[]; onSend: (text: string) => void; suggestions?: string[]; placeholder?: string; note?: string; busy?: boolean; chips?: ReactNode; className?: string;
}) {
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = list.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [messages.length, busy]);
  function submit(event?: FormEvent, text = draft) { event?.preventDefault(); if (!text.trim() || busy) return; onSend(text.trim()); setDraft(''); }
  return <section className={`p chat ${className}`}>
    <header className="p-h"><b>{title}</b><span>{agent}</span></header>
    <div className="chat-list" ref={list}>
      {messages.map(m => <div key={m.id} className="chat-msg" data-who={m.who}>
        {m.who !== 'me' && m.who !== 'sys' && <span className="chat-who"><i />{agent}{m.at && <time>{m.at}</time>}</span>}
        {m.tools && <ul className="chat-tools">{m.tools.map((t, i) => <li key={i} data-kind={t.kind}><em>{TOOL_MARK[t.kind]}</em><span>{t.label}</span>{t.detail && <small>{t.detail}</small>}</li>)}</ul>}
        {m.text && <div className="chat-text">{m.text}</div>}
        {m.card}
      </div>)}
      {busy && <div className="chat-msg" data-who="ai"><span className="chat-who"><i />{agent}</span><div className="chat-typing"><i /><i /><i /></div></div>}
    </div>
    {suggestions.length > 0 && <div className="chat-suggest">{suggestions.map(s => <button key={s} onClick={() => submit(undefined, s)} disabled={busy}>{s}</button>)}</div>}
    <form className="chat-input" onSubmit={submit}>
      {chips}
      <textarea rows={2} value={draft} placeholder={placeholder} aria-label={placeholder} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
      <div className="chat-input-foot"><span>{note ?? '本地预演 · 回复为预设脚本，不连接模型'}</span><button type="submit" disabled={!draft.trim() || busy} aria-label="发送">↑</button></div>
    </form>
  </section>;
}
