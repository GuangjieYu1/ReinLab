import { KIND_LABEL, LOOKS, sunFor, type Spot } from './model';
import { hm, lightOf } from './sun';
import SpotView from './SpotView';
import { Photo, PoseGlyph, SCENE_OF } from './Figures';
import { crowdBar } from './PlanFace';

// 机位面：左边 2.5D 白模（环绕 / 机位视角，影子跟着时间走），右边是这个机位的一切：
// 参数与光线 · 构图 · 给模特的引导词（配姿势简图）· 出图提示词与样片 · 服饰 · 规定与备选。

export default function SpotFace({ spots, s, onSel, t, onT, mode, onMode, samples, onSample, onSendGraph, onCopy, lineSet }: {
  spots: Spot[]; s: Spot; onSel: (id: string) => void; t: number; onT: (t: number) => void; mode: 'orbit' | 'camera'; onMode: (m: 'orbit' | 'camera') => void;
  samples: number[]; onSample: () => void; onSendGraph: () => void; onCopy: (text: string) => void; lineSet: number;
}) {
  const sun = sunFor(s, t), look = LOOKS.find(l => l.id === s.look), lo = s.start - 60, hi = s.start + s.dur + 60;
  const lines = lineSet % 2 ? [...s.direct].reverse() : s.direct;
  return <div className="ex-center ex-spot">
    <header className="ex-head">
      <span className="ex-id">{String(s.no).padStart(2, '0')}</span>
      <div className="ex-title"><strong>{s.name}</strong><span>{s.area} <i>·</i> {KIND_LABEL[s.kind]} <i>·</i> {hm(s.start)}–{hm(s.start + s.dur)}</span></div>
      <div className="ex-spots">{[...spots].sort((a, b) => a.start - b.start).map(x => <button key={x.id} aria-pressed={x.id === s.id} data-kind={x.kind} onClick={() => onSel(x.id)}>{x.no}</button>)}</div>
      <div className="ex-seg"><button aria-pressed={mode === 'orbit'} onClick={() => onMode('orbit')}>环绕</button><button aria-pressed={mode === 'camera'} onClick={() => onMode('camera')}>机位视角</button></div>
    </header>
    <div className="ex-spotbody">
      <div className="ex-view">
        <SpotView spot={s} t={t} palette={look?.palette} mode={mode} />
        <div className="ex-sunchip" data-blocked={sun.blocked || undefined}>
          <b>{hm(t)}</b><span>{sun.alt <= 0 ? '太阳在地平线下' : sun.blocked ? '太阳被东山挡住' : lightOf(sun.az, sun.alt, s.dir)}</span><small>方位 {Math.round(sun.az)}° · 高度 {sun.alt.toFixed(1)}°</small>
        </div>
        <label className="ex-scrub"><span>{hm(lo)}</span><input type="range" min={lo} max={hi} step={5} value={Math.max(lo, Math.min(hi, t))} onChange={e => onT(+e.target.value)} /><span>{hm(hi)}</span>
          <i style={{ left: `${(s.start - lo) / (hi - lo) * 100}%`, width: `${s.dur / (hi - lo) * 100}%` }} /></label>
        {mode === 'orbit' && <p className="ex-hint">拖动旋转 · 滚轮缩放 · 橙色虚线是取景范围</p>}
      </div>
      <aside className="ex-side">
        <section><h3>参数与光线</h3>
          <div className="ex-exif"><b>{s.lens}</b><b>{s.ap}</b><b>{s.ss}</b><b>{s.iso}</b></div>
          <dl className="ex-kv"><div><dt>朝向</dt><dd>{s.dir}° · 距模特 {s.dist}m</dd></div><div><dt>人流</dt><dd>{crowdBar(s.crowd)}</dd></div></dl>
          {s.horizon && <p className="ex-warn">{s.horizon.note}</p>}
          <p className="ex-small">{s.crowdNote}</p></section>
        <section><h3>构图</h3><p>{s.comp}</p></section>
        {s.direct.length > 0 ? <section><h3>给模特的引导词 <small>按顺序说</small></h3>
          <ol className="ex-lines is-big">{lines.map((d, i) => <li key={d.line} style={{ animationDelay: `${i * 60}ms` }}><PoseGlyph pose={d.pose} /><span>{d.line}</span><button onClick={() => onCopy(d.line)} aria-label="复制">复制</button></li>)}</ol></section>
          : <section><h3>给模特的引导词</h3><p className="ex-small">风光机位，不安排模特。可以让模特在这段时间休息、补妆或换装。</p></section>}
        <section><h3>出图提示词 <small>用来生成样片预览</small></h3>
          <code className="ex-prompt">{s.prompt}</code>
          <div className="ex-acts"><button className="rh-btn is-solid" onClick={onSample}>生成样片</button><button className="rh-btn" onClick={onSendGraph}>交给节点图出图</button><button className="rh-btn" onClick={() => onCopy(s.prompt)}>复制</button></div>
          {samples.length > 0 && <div className="ex-samples">{samples.map(seed => <Photo key={seed} seed={seed} scene={SCENE_OF[s.id]} palette={look?.palette} person={s.kind === 'portrait'} night={s.id === 'P6'} />)}</div>}</section>
        {look && <section><h3>服饰 · {look.id} {look.name}</h3>
          <div className="ex-look is-side"><Photo seed={look.id.charCodeAt(0) * 7} scene={SCENE_OF[s.id]} palette={look.palette} ratio={.75} night={s.id === 'P6'} />
            <div><span className="ex-palette">{look.palette.map(c => <i key={c} style={{ background: c }} title={c} />)}</span><ul>{look.items.map(x => <li key={x}>{x}</li>)}</ul><p>{look.why}</p><p className="ex-avoid">避开：{look.avoid}</p></div></div></section>}
        <section><h3>规定与备选</h3><ul className="ex-rulelist">{s.rules.map(r => <li key={r}>{r}</li>)}</ul>{s.backup && <p className="ex-backup"><b>雨天备选</b>{s.backup.name}——{s.backup.why}</p>}</section>
      </aside>
    </div>
  </div>;
}
