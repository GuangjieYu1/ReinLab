import { useEffect, useRef, useState } from 'react';
import type { Entity, WorldEvent } from '../../../../../packages/contracts/src/creative';
import { dur, nowLabel, type Pos } from './geo';

type Flag = 'hard' | 'suspect';
const SPEEDS: [string, number][] = [['10 分/秒', 10], ['1 小时/秒', 60], ['6 小时/秒', 360], ['1 天/秒', 1440]];

/** 下方的故事时间轴：每个人物一行（Campfire 式），事件是块，红黄挂在块上；拖动或播放。 */
export default function StoryTimeline({ persons, events, span, t, onT, flags, selEvent, onPickEvent, selPerson, onPickPerson, pos, live, onLive, marks }: {
  persons: Entity[]; events: WorldEvent[]; span: [number, number] | null;
  t: number; onT: (t: number) => void;
  flags: Map<string, Flag>; selEvent: string | null; onPickEvent: (id: string) => void;
  selPerson: string | null; onPickPerson: (id: string) => void;
  pos: Map<string, Pos>; reduced?: boolean;
  /** 地图是否在看「这一刻」；拖动或播放时打开，「全部路线」关掉。 */
  live: boolean; onLive: (on: boolean) => void;
  /** 1D：虚影（提议里的新人物、新事件、改后的事件）、被替代的旧块、AI 正在看的事件。 */
  marks?: { ghost: Set<string>; old: Set<string>; hi: Set<string>; ai: Set<string> };
}) {
  const mk = marks ?? { ghost: new Set<string>(), old: new Set<string>(), hi: new Set<string>(), ai: new Set<string>() };
  const full: [number, number] = span ? [span[0] - (span[1] - span[0]) * 0.03, span[1] + (span[1] - span[0]) * 0.03 + 1] : [0, 1];
  const [win, setWin] = useState<[number, number]>(full);
  const spanKey = span ? `${span[0]}-${span[1]}` : '';
  useEffect(() => { setWin(full); }, [spanKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(60);
  const track = useRef<HTMLDivElement>(null);
  const tRef = useRef(t); tRef.current = t;

  const [v0, v1] = win, w = Math.max(1, v1 - v0);
  const x = (m: number) => ((m - v0) / w) * 100;
  const atX = (clientX: number) => { const r = track.current!.getBoundingClientRect(); return v0 + ((clientX - r.left) / r.width) * w; };

  // 播放：按「故事分钟 / 真实秒」往前走，到窗口右端停
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      const next = tRef.current + ((now - last) / 1000) * speed; last = now;
      if (next >= v1) { onT(v1); setPlaying(false); return; }
      onT(next); raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step); return () => cancelAnimationFrame(raf);
  }, [playing, speed, v1]); // eslint-disable-line react-hooks/exhaustive-deps

  const wheel = (e: React.WheelEvent) => {
    if (!track.current) return;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / track.current.clientWidth) * w;
      setWin([v0 + d, v1 + d]); return;
    }
    const c = atX(e.clientX), k = Math.exp(e.deltaY * 0.0015);
    const nw = Math.min(full[1] - full[0], Math.max(30, w * k));
    const f = (c - v0) / w;
    setWin([c - f * nw, c - f * nw + nw]);
  };
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.cw-tl-ev')) return;
    const el = e.currentTarget as HTMLElement; el.setPointerCapture(e.pointerId);
    onT(atX(e.clientX)); setPlaying(false); onLive(true);
    const move = (ev: PointerEvent) => onT(atX(ev.clientX));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };

  const byPerson = (id: string) => events.filter(e => e.participants.some(p => p.entityId === id));
  // 人多时（> 6）默认只列窗口里有事件的人，可以搜名字；选中的人总在
  const many = persons.length > 6;
  const [who, setWho] = useState<'window' | 'all'>('window'), [q, setQ] = useState('');
  const inWin = (id: string) => byPerson(id).some(e => e.start.t != null && e.start.t <= v1 && (e.end.t ?? e.start.t) >= v0);
  const shown = !many ? persons : persons.filter(p => p.id === selPerson || mk.ghost.has(p.id) || ((who === 'all' || inWin(p.id)) && (!q.trim() || p.name.includes(q.trim()) || p.aliases.some(a => a.includes(q.trim())))));
  const now = nowLabel(events, t);
  const edge = (m: number) => { const n = nowLabel(events, m); return n ? `${n.label}${n.plus ? ` ＋${n.plus}` : ''}` : ''; };
  const zoomTo = (id: string) => {
    const e = events.find(x => x.id === id); if (!e || e.start.t == null) return;
    const a = e.start.t, b = e.end.t ?? a, pad = Math.max(60, (b - a) * 1.5);
    setWin([a - pad, b + pad]); onT(a); onLive(true);
  };

  return <section className="cw-tl" aria-label="故事时间轴">
    <header className="cw-tl-bar">
      <button className="cw-tl-play" aria-pressed={playing} onClick={() => { if (!playing && (t >= v1 - 1 || !live)) onT(Math.max(v0, span?.[0] ?? v0)); if (!playing) onLive(true); setPlaying(v => !v); }} disabled={!span}>{playing ? '❚❚ 暂停' : '▶ 播放'}</button>
      <select value={speed} onChange={e => setSpeed(Number(e.target.value))} aria-label="播放速度">{SPEEDS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}</select>
      <button className="rh-btn" aria-pressed={!live} onClick={() => { setPlaying(false); onLive(false); }} disabled={!span} title="地图上画出全部事件路线">全部路线</button>
      <div className="cw-tl-now">{!live ? <span>地图上是全部路线 · 拖动时间轴或播放，看每个时刻谁在哪</span> : now ? <><b>{now.label}</b>{now.plus && <span>＋{now.plus}</span>}</> : <span>{span ? '还没有事件开始' : '还没有带时间的事件'}</span>}</div>
      <span className="cw-tl-win rh-micro">{span ? `窗口 ${dur(w) || '1 分'}` : ''}</span>
      <button className="rh-btn" onClick={() => setWin(full)} disabled={!span}>全部</button>
      {selEvent && <button className="rh-btn" onClick={() => zoomTo(selEvent)}>放大到选中</button>}
    </header>
    {many && <div className="cw-tl-who"><select value={who} onChange={e => setWho(e.target.value as typeof who)} aria-label="列哪些人">
      <option value="window">只列窗口里有事件的人</option><option value="all">列全部人物</option></select>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜人物" aria-label="搜人物" />
      <small>显示 {shown.length} / {persons.length} 人{who === 'window' ? ' · 缩放时间轴会换人' : ''}</small></div>}
    <div className="cw-tl-body" onWheel={wheel}>
      <div className="cw-tl-names">{shown.map(p => {
        const ps = pos.get(p.id);
        return <button key={p.id} aria-current={selPerson === p.id || undefined} onClick={() => onPickPerson(p.id)} data-state={ps?.state} data-ghost={mk.ghost.has(p.id) || undefined}>
          <b>{p.name}</b><small>{ps?.state === 'unknown' ? `位置未定${ps.why ? ` · ${ps.why}` : ''}` : ps?.state === 'dead' ? '已故' : ps?.state === 'move' ? (ps.routeKind === 'inferred' ? '在路上 · 推断路线' : '在路上') : ps?.state === 'at' ? '在场' : '—'}</small></button>;
      })}{!persons.length ? <p className="cw-empty-row">还没有人物</p> : !shown.length && <p className="cw-empty-row">这段时间没有人有事件</p>}</div>
      <div className="cw-tl-track" ref={track} onPointerDown={drag}>
        <div className="cw-tl-edges rh-micro"><span>{edge(v0)}</span><span>{edge(v1)}</span></div>
        {shown.map(p => {
          const evs = byPerson(p.id), loose = evs.filter(e => e.start.t == null);
          return <div key={p.id} className="cw-tl-row" data-ghost={mk.ghost.has(p.id) || undefined} data-sel={selPerson === p.id || undefined} data-dead={pos.get(p.id)?.state === 'dead' || undefined}>
            {evs.filter(e => e.start.t != null).map(e => {
              const a = e.start.t!, b = Math.max(a, e.end.t ?? a), l = x(a), r = x(b);
              if (r < -5 || l > 105) return null;
              const f = flags.get(e.id);
              return <button key={e.id} className="cw-tl-ev" data-flag={f} data-sel={selEvent === e.id || undefined}
                data-ghost={mk.ghost.has(e.id) || undefined} data-old={mk.old.has(e.id) || undefined} data-hi={mk.hi.has(e.id) || undefined} data-ai={mk.ai.has(e.id) || undefined} data-narr={e.narrative !== 'fact' ? e.narrative : undefined}
                data-gap={e.gaps.length > 0 || undefined} style={{ left: `${l}%`, width: `max(10px, ${r - l}%)` }} title={`${e.title} · ${e.start.label}${e.end.t != null && e.end.t !== a ? ` → ${e.end.label}` : ''}`}
                onClick={() => onPickEvent(e.id)}><span>{e.title}</span></button>;
            })}
            {loose.length > 0 && <span className="cw-tl-loose">{loose.map(e => <button key={e.id} className="cw-tl-ev" data-flag={flags.get(e.id)} data-sel={selEvent === e.id || undefined} data-gap onClick={() => onPickEvent(e.id)}><span>{e.title} · 时间未定</span></button>)}</span>}
          </div>;
        })}
        {span && live && <div className="cw-tl-head" style={{ left: `${x(t)}%` }}><i /></div>}
      </div>
    </div>
  </section>;
}
