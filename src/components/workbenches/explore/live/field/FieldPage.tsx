import { useEffect, useMemo, useState } from 'react';
import type { PendingChange, WeatherView } from '../../../../../../packages/contracts/src/explore';
import type { ChatItem, ExploreAdapter, ExploreSnapshot, MapConfig } from '../adapter';
import { RichBlocks } from '../../../richText';
import LiveField from './LiveField';
import '../../explore.css';
import '../live.css';

/**
 * 手机全屏现场（在线）：工作台三栏不适合手机，手机打开探索台直接进这里。
 * "情况变了"发给助手后，回复和前后对照卡就显示在本页，可以直接"应用 / 不用"。
 */
export default function FieldPage({ adapter, title, dossierId, accountId, onLeave }: {
  adapter: ExploreAdapter; title: string; dossierId: string; accountId: string; onLeave?: () => void;
}) {
  const [snap, setSnap] = useState<ExploreSnapshot | null>(null);
  const [cfg, setCfg] = useState<MapConfig | null>(null);
  const [weather, setWeather] = useState<WeatherView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState<Record<string, boolean>>({});
  const session = useMemo(() => adapter.chat((items, b) => { setChat([...items]); setBusy(b); }), [adapter]);

  const load = () => adapter.load().then(setSnap, e => setErr(e instanceof Error ? e.message : '读不到计划'));
  useEffect(() => {
    void load(); adapter.mapConfig().then(setCfg, () => {}); adapter.weather().then(setWeather, () => {});
    return adapter.subscribe(ev => { if (ev.type === 'explore.op') void load(); });
  }, [adapter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => session.stop(), [session]);

  if (!snap) return <div className="de"><p>{err ?? '正在打开现场…'}</p></div>;
  const lastAgent = [...chat].reverse().find((c): c is Extract<ChatItem, { kind: 'agent' }> => c.kind === 'agent');
  const pendings = chat.filter((c): c is Extract<ChatItem, { kind: 'pending' }> => c.kind === 'pending').map(c => c.change).filter(c => !(c.approvalId in decided));
  const decide = async (c: PendingChange, ok: boolean) => {
    try { await adapter.decide(c.approvalId, ok); setDecided(d => ({ ...d, [c.approvalId]: ok })); await load(); } catch (e) { setErr(e instanceof Error ? e.message : '没有成功'); }
  };

  return <main className="wb wb-exploration exl-fieldpage">
    <header className="wb-strip" data-wb-bar>{onLeave ? <a className="wb-back" onClick={onLeave}>←</a> : <a className="wb-back" href="/">←</a>}<span className="wb-strip-bench"><b>EXPL</b>现场 · {title}</span></header>
    <div className="wb-body exl-fieldwrap">
      <LiveField plan={snap.plan} title={title} weather={weather} adapter={adapter} accountId={accountId} dossierId={dossierId} mapCfg={cfg}
        offlinePack={null} serverRevision={snap.plan.revision} onSituation={text => void session.send(text).catch(e => setErr(e instanceof Error ? e.message : '没发出去'))} />
      {(busy || lastAgent || pendings.length > 0) && <aside className="exf-agent">
        <span className="exf-kicker">助手{busy ? ' · 正在想…' : ''}</span>
        {lastAgent && <div className="exf-agent-text"><RichBlocks text={lastAgent.text} /></div>}
        {pendings.map(c => <div key={c.approvalId} className="exf-change">
          <b>{c.summary}</b>
          <ul>{c.changes.map(ch => <li key={ch.stopId}>{(ch as { stopName?: string }).stopName ?? ch.stopId}：{ch.after === null ? '删除' : Object.keys(ch.after).join('、')}</li>)}</ul>
          <div><button className="exf-big is-solid" onClick={() => void decide(c, true)}>应用</button><button className="exf-big" onClick={() => void decide(c, false)}>不用</button></div>
        </div>)}
      </aside>}
      {err && <p className="dm-msg">{err}</p>}
    </div>
  </main>;
}
