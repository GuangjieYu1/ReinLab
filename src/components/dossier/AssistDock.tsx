import { useEffect, useMemo, useState } from 'react';
import AgentDock, { type DockEvent } from '../workbenches/AgentDock';
import { assistSession, type AssistItem } from '../../data/assist-live';
import type { Confirmation, Dossier, OpenTarget } from '../../../packages/contracts/src/dossier';
import { dossiers } from './store';

/** 非研究台的侧边会话：档案助手。只会管档案（建、找、改、归档、删除确认、加课程），不做这个台的专业工作。 */
export default function AssistDock({ dossier, onOpen }: { dossier: Dossier; onOpen: (o: OpenTarget) => void }) {
  const [items, setItems] = useState<AssistItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const session = useMemo(() => assistSession(dossier.id, (xs, b) => { setItems([...xs]); setBusy(b); }), [dossier.id]);
  useEffect(() => { void session.load().catch(() => {}); return () => session.stop(); }, [session]);

  const events: DockEvent[] = items.map((x): DockEvent => {
    if (x.kind === 'user') return { id: x.id, kind: 'user', text: x.text, at: '' };
    if (x.kind === 'agent') return { id: x.id, kind: 'agent', text: x.text, at: '' };
    if (x.kind === 'note') return { id: x.id, kind: 'note', text: x.text, at: '' };
    if (x.kind === 'tool') return { id: x.id, kind: 'tool', action: x.name, label: x.label, state: x.state };
    if (x.kind === 'confirm') return { id: x.id, kind: 'card', body: <ConfirmCard c={x.confirmation} /> };
    return { id: x.id, kind: 'card', body: <button className="ad-opencard" disabled={x.open.to === 'none'} onClick={() => onOpen(x.open)}><em>{x.open.to === 'course' ? '课程' : '档案'}</em><b>{x.title}</b><span>打开 →</span></button> };
  });
  const send = (text: string) => { setErr(null); void session.send(text).catch(e => { setBusy(false); setErr(e instanceof Error ? e.message : '没有发出去'); }); };

  return <>
    <AgentDock name="档案助手" target={dossier.title} plan={{ stages: ['档案'], current: 0 }}
      suggestions={[
        { id: 'where', label: '这个档案做到哪了', onClick: () => send('这个档案做到哪了？') },
        { id: 'find', label: '找我最近的档案', onClick: () => send('列出我在这个工作台最近的档案') },
        { id: 'new', label: '新建一个档案', fill: '帮我新建一个档案：' },
      ]}
      events={events} busy={busy} onSend={send} placeholder="对档案助手说：找、建、改名、归档、删除档案" footnote="只管档案 · 删除前会请你确认一次" />
    {err && <p className="dm-msg" role="alert">{err}</p>}
  </>;
}

/** 对话里的确认卡：和弹窗、收件箱是同一张（同一个 id）。点过以后显示结果。 */
function ConfirmCard({ c }: { c: Confirmation }) {
  const [state, setState] = useState<Confirmation['state']>(c.state);
  const [err, setErr] = useState<string | null>(null);
  const del = c.kind === 'dossier.delete';
  const decide = (approve: boolean) => dossiers().decide(c.id, approve).then(() => setState(approve ? 'approved' : 'rejected'), e => setErr(e instanceof Error ? e.message : '没有成功'));
  return <div className="ad-approval rh-approval" data-state={state === 'pending' ? 'pending' : state}>
    <span className="rh-micro">待你确认 · {del ? '删除档案' : '归档档案'}</span>
    <b>{del ? '删除' : '归档'}《{c.target.title}》</b>
    <small>{c.impact.note}</small>
    {state === 'pending'
      ? <div className="ad-approval-act"><button className="rh-btn is-solid" onClick={() => void decide(true)}>确认{del ? '删除' : '归档'}</button><button className="rh-btn" onClick={() => void decide(false)}>不{del ? '删除' : '归档'}</button></div>
      : <span className="ad-approval-done">{state === 'approved' ? '■ 已确认' : state === 'rejected' ? '没有执行' : '已过期'}</span>}
    {err && <small className="dm-msg">{err}</small>}
  </div>;
}
