import { useState } from 'react';
import { DATE, KIND_LABEL, LOOKS, sunFor, walk, WEATHER, type Note, type Spot } from './model';
import { dayTimes, hm, lightOf } from './sun';
import KyotoMap from './KyotoMap';
import { PoseGlyph } from './Figures';

// 现场面（为 iPad 横屏设计）：左边「现在」——该拍哪个机位、倒计时、此刻的光、快速记录；右边今天的清单与「情况变了」。
// 情况变了（下雨 / 晚到 / 人多）由助手重排，先给出前后对照，你点「应用」才改计划。

export type Proposal = { kind: string; title: string; why: string; rows: { id: string; before: string; after: string }[] };
const SIT = [['rain', '下雨了'], ['late', '晚到 20 分钟'], ['crowd', '人太多']] as const;

export default function FieldFace({ spots, now, onNow, done, onDone, notes, onNote, onSituation, proposal, onApply, onDismiss, busy }: {
  spots: Spot[]; now: number; onNow: (t: number) => void; done: string[]; onDone: (id: string) => void;
  notes: Note[]; onNote: (text: string) => void; onSituation: (k: 'rain' | 'late' | 'crowd') => void;
  proposal: Proposal | null; onApply: () => void; onDismiss: () => void; busy: boolean;
}) {
  const [draft, setDraft] = useState('');
  const order = [...spots].sort((a, b) => a.start - b.start);
  const cur = order.find(s => now >= s.start && now < s.start + s.dur && !done.includes(s.id));
  const next = order.find(s => s.start > now && !done.includes(s.id));
  const focus = cur ?? next ?? order[order.length - 1];
  const sun = sunFor(focus, now), w = WEATHER.find(x => x.h === Math.floor(now / 60)) ?? WEATHER[0], dt = dayTimes(DATE);
  const prev = order.filter(s => s.start + s.dur <= now).at(-1);
  const pos = cur ? { x: cur.x, y: cur.y } : prev && next ? (() => { const k = Math.min(1, Math.max(0, (now - prev.start - prev.dur) / Math.max(1, next.start - prev.start - prev.dur))); return { x: prev.x + (next.x - prev.x) * k, y: prev.y + (next.y - prev.y) * k }; })() : { x: focus.x, y: focus.y };
  const toGold = dt.goldPm[0] - now;
  const status = (s: Spot) => done.includes(s.id) ? 'done' : s === cur ? 'now' : s === next ? 'next' : s.start + s.dur <= now ? 'missed' : 'later';
  const look = LOOKS.find(l => l.id === focus.look);
  return <div className="ex-center ex-field">
    <header className="ex-head">
      <span className="ex-id is-live">现场</span>
      <div className="ex-title"><strong>{hm(now)} · {cur ? `正在 ${cur.no} 号机位` : next ? `下一站 ${next.no} 号` : '今天的机位都过了'}</strong><span>{w.cond} {w.t}° <i>·</i> 降水 {w.rain}% <i>·</i> 风 {w.wind} 级 <i>·</i> {toGold > 0 ? `距傍晚金色时刻 ${Math.floor(toGold / 60)}:${String(toGold % 60).padStart(2, '0')}` : '金色时刻已开始'}</span></div>
      <label className="ex-clock"><small>模拟时间</small><input type="range" min={6 * 60} max={18 * 60} step={5} value={now} onChange={e => onNow(+e.target.value)} /><b>{hm(now)}</b></label>
    </header>
    <div className="ex-fieldbody">
      <div className="ex-now">
        <div className="ex-nowcard" data-state={cur ? 'now' : 'next'}>
          <span className="rh-micro">{cur ? 'NOW · 正在拍' : 'NEXT · 下一站'}</span>
          <h2><b>{focus.no}</b>{focus.name}</h2>
          <p>{cur ? `还剩 ${focus.start + focus.dur - now} 分钟` : next ? `${next.start - now} 分钟后开始 · ${prev ? `从 ${prev.no} 号步行约 ${walk(prev, next)} 分钟` : '从住处出发'}` : ''}</p>
          <div className="ex-nowfacts"><span><small>此刻的光</small><b>{sun.alt <= 0 ? '无直射光' : sun.blocked ? '被东山挡住' : lightOf(sun.az, sun.alt, focus.dir)}</b></span><span><small>镜头</small><b>{focus.lens} · {focus.ap}</b></span><span><small>服饰</small><b>{look ? `${look.id} ${look.name}` : '—'}</b></span></div>
          {focus.direct[0] && <p className="ex-nowline"><PoseGlyph pose={focus.direct[0].pose} />「{focus.direct[0].line}」</p>}
          <div className="ex-nowact">
            <button className="ex-go" onClick={() => onDone(focus.id)} disabled={done.includes(focus.id)}><i />{done.includes(focus.id) ? '已拍到' : '拍到了'}</button>
            <form onSubmit={e => { e.preventDefault(); if (draft.trim()) { onNote(draft.trim()); setDraft(''); } }}><input value={draft} onChange={e => setDraft(e.target.value)} placeholder="记一句：光、人、衣服、地方……" /><button className="rh-btn">记下</button></form>
          </div>
        </div>
        <div className="ex-fieldmap"><KyotoMap spots={spots} sel={focus.id} onSel={() => {}} t={now} done={done} pin={{ ...pos, label: '你在这里' }} /></div>
        <ol className="ex-notes">{notes.slice(-4).reverse().map((n, i) => <li key={i}><time>{hm(n.at)}</time><em>{n.tag}</em>{n.text}</li>)}{!notes.length && <li className="is-none">现场记下的话会出现在这里，回来后由助手整理。</li>}</ol>
      </div>
      <aside className="ex-today">
        <h3>今天 <small>{done.length} / {spots.length} 已拍</small></h3>
        <ol>{order.map(s => <li key={s.id} data-s={status(s)}><time>{hm(s.start)}</time><b>{s.no}</b><span>{s.name}<small>{KIND_LABEL[s.kind]}{s.look ? ` · 服饰 ${s.look}` : ''}</small></span><em>{({ done: '已拍', now: '正在', next: '下一站', missed: '错过', later: '' } as Record<string, string>)[status(s)]}</em></li>)}</ol>
        <h3>情况变了</h3>
        <div className="ex-sit">{SIT.map(([k, l]) => <button key={k} onClick={() => onSituation(k)} disabled={busy}>{l}</button>)}</div>
        {proposal && <div className="ex-proposal">
          <span className="rh-micro">助手的调整 · 应用前不会改计划</span><b>{proposal.title}</b><p>{proposal.why}</p>
          <table><tbody>{proposal.rows.map(r => <tr key={r.id + r.before}><td>{spots.find(s => s.id === r.id)?.no ?? '—'}</td><td><s>{r.before}</s></td><td>→</td><td>{r.after}</td></tr>)}</tbody></table>
          <div><button className="rh-btn is-solid" onClick={onApply}>应用</button><button className="rh-btn" onClick={onDismiss}>不用</button></div>
        </div>}
      </aside>
    </div>
  </div>;
}
