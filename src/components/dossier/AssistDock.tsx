import { useEffect, useMemo, useState } from 'react';
import AgentDock, { type DockEvent } from '../workbenches/AgentDock';
import { assistSession, type AssistItem } from '../../data/assist-live';
import type { Dossier, OpenTarget } from '../../../packages/contracts/src/dossier';

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
