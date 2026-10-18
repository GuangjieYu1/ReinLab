import { DATE, DATE_LABEL, GEAR, KIND_LABEL, LOOKS, MODEL, sunFor, walk, WEATHER, type Spot } from './model';
import { dayTimes, hm, lightOf } from './sun';
import KyotoMap from './KyotoMap';
import DayLine from './DayLine';
import { Photo, PoseGlyph, SCENE_OF } from './Figures';

// 计划面：地图（机位、路线、太阳方位）+ 选中机位的摘要 + 一天的时间线；切到「计划书」看生成的拍照计划。

export const crowdBar = (n: number) => <span className="ex-crowd" aria-label={`人流 ${n}/5`}>{[1, 2, 3, 4, 5].map(i => <i key={i} data-on={i <= n || undefined} />)}</span>;

export default function PlanFace({ spots, sel, onSel, t, onT, view, onView, book, onOpenSpot, onGenerate, busy }: {
  spots: Spot[]; sel: string; onSel: (id: string) => void; t: number; onT: (t: number) => void;
  view: 'map' | 'doc'; onView: (v: 'map' | 'doc') => void; book: number; onOpenSpot: () => void; onGenerate: () => void; busy: boolean;
}) {
  const dt = dayTimes(DATE), s = spots.find(x => x.id === sel)!, sun = sunFor(s, t), look = LOOKS.find(l => l.id === s.look);
  const hi = Math.max(...WEATHER.map(w => w.t)), lo = Math.min(...WEATHER.map(w => w.t)), risk = WEATHER.filter(w => w.rain >= 30);
  return <div className="ex-center ex-plan" data-view={view}>
    <header className="ex-head">
      <span className="ex-id">X-061</span>
      <div className="ex-title"><strong>东山 · 秋日人像</strong><span>{DATE_LABEL} <i>·</i> 模特 {MODEL.name} <i>·</i> {spots.length} 个机位 <i>·</i> {LOOKS.length} 套服饰</span></div>
      <ul className="ex-facts">
        <li><small>傍晚金色时刻</small><b>{hm(dt.goldPm[0])}–{hm(dt.goldPm[1])}</b></li>
        <li><small>气温</small><b>{lo}–{hi}°</b></li>
        <li data-alert={risk.length > 0 || undefined}><small>降水风险</small><b>{risk.length ? `${risk[0].h}:00 阵雨 ${risk[0].rain}%` : '低'}</b></li>
      </ul>
      <div className="ex-seg"><button aria-pressed={view === 'map'} onClick={() => onView('map')}>地图</button><button aria-pressed={view === 'doc'} onClick={() => onView('doc')}>计划书{book > 0 && book < 6 && <i />}</button></div>
      <button className="ex-go" onClick={onGenerate} disabled={busy}><i />{book >= 6 ? '重新生成计划书' : '生成拍照计划书'}</button>
    </header>
    {view === 'map' ? <div className="ex-mapwrap">
      <KyotoMap spots={spots} sel={sel} onSel={onSel} t={t} />
      <aside className="ex-card">
        <header><b>{String(s.no).padStart(2, '0')}</b><div><strong>{s.name}</strong><small>{s.area} · {KIND_LABEL[s.kind]}</small></div></header>
        <dl className="ex-kv">
          <div><dt>时段</dt><dd>{hm(s.start)}–{hm(s.start + s.dur)}</dd></div>
          <div><dt>镜头</dt><dd>{s.lens} · {s.ap}</dd></div>
          <div><dt>{hm(t)} 的光</dt><dd data-warn={sun.blocked || undefined}>{sun.blocked ? '被东山挡住 · 无直射光' : lightOf(sun.az, sun.alt, s.dir)}</dd></div>
          <div><dt>太阳</dt><dd>方位 {Math.round(sun.az)}° · 高度 {sun.alt.toFixed(1)}°</dd></div>
          <div><dt>人流</dt><dd>{crowdBar(s.crowd)}</dd></div>
        </dl>
        {s.horizon && <p className="ex-warn">{s.horizon.note}</p>}
        <p className="ex-comp">{s.comp}</p>
        {look && <div className="ex-look-mini"><span>{look.palette.map(c => <i key={c} style={{ background: c }} />)}</span><b>服饰 {look.id} · {look.name}</b></div>}
        {s.direct[0] && <p className="ex-direct-mini"><PoseGlyph pose={s.direct[0].pose} />「{s.direct[0].line}」</p>}
        <button className="ex-open" onClick={onOpenSpot}>打开机位 →</button>
      </aside>
    </div> : <PlanBook spots={spots} book={book} />}
    <DayLine spots={spots} sel={sel} onSel={onSel} t={t} onT={onT} />
  </div>;
}

/** 生成的拍照计划书：按节逐步写出（book = 已写出的节数）。 */
function PlanBook({ spots, book }: { spots: Spot[]; book: number }) {
  const dt = dayTimes(DATE), order = [...spots].sort((a, b) => a.start - b.start);
  if (book === 0) return <div className="ex-book is-empty"><b>还没有计划书</b><span>点「生成拍照计划书」，助手会按机位、光线、天气和服饰写一份当天可以照着走的计划。</span></div>;
  const sec = (i: number) => book > i;
  return <article className="ex-book">
    <header className="ex-book-head"><span className="rh-micro">SHOOT PLAN · 拍照计划书 · X-061</span><h1>东山 · 秋日人像</h1><p>{DATE_LABEL} · 京都东山 · 模特 {MODEL.name}（{MODEL.height}cm）· 摄影 1 人</p></header>
    {sec(0) && <section data-n="01"><h2>概要</h2><div className="ex-book-facts">
      <div><small>日出 · 日落</small><b>{hm(dt.sunrise)} · {hm(dt.sunset)}</b></div><div><small>早晨金色时刻</small><b>{hm(dt.goldAm[0])}–{hm(dt.goldAm[1])}</b></div>
      <div><small>傍晚金色 · 蓝调</small><b>{hm(dt.goldPm[0])}–{hm(dt.bluePm[1])}</b></div><div><small>天气</small><b>晴转多云，14 时阵雨 35%</b></div></div>
      <p>早上用东山背后的逆光拍哲学之道，上午赶在团客前进银阁寺，中午前后拍水路阁和铁道（光偏硬，靠建筑遮挡和长焦压缩），傍晚留给祇园白川的金色时刻到蓝调。{MODEL.note}</p></section>}
    {sec(1) && <section data-n="02"><h2>时间表</h2><table className="ex-table"><thead><tr><th>时间</th><th>机位</th><th>镜头 · 参数</th><th>光线</th><th>人流</th><th>服饰</th></tr></thead><tbody>
      {order.map((s, i) => { const sun = sunFor(s, s.start + s.dur / 2); return <tr key={s.id}><td>{hm(s.start)}<small>{s.dur} 分{i > 0 ? ` · 步行 ${walk(order[i - 1], s)} 分` : ''}</small></td><td><b>{s.no} {s.name}</b><small>{KIND_LABEL[s.kind]}</small></td><td>{s.lens}<small>{s.ap} · {s.ss} · {s.iso}</small></td><td>{sun.blocked ? '山影' : lightOf(sun.az, sun.alt, s.dir)}</td><td>{crowdBar(s.crowd)}</td><td>{s.look ?? '—'}</td></tr>; })}
    </tbody></table></section>}
    {sec(2) && <section data-n="03"><h2>机位</h2>{order.map(s => <div key={s.id} className="ex-book-spot">
      <Photo seed={s.no * 31} scene={SCENE_OF[s.id]} palette={LOOKS.find(l => l.id === s.look)?.palette} person={s.kind === 'portrait'} night={s.id === 'P6'} />
      <div><h3>{s.no} · {s.name} <small>{hm(s.start)} · {s.lens}</small></h3><p>{s.comp}</p>
        {s.direct.length > 0 && <ol className="ex-lines">{s.direct.map(d => <li key={d.line}><PoseGlyph pose={d.pose} />{d.line}</li>)}</ol>}
        <code className="ex-prompt">{s.prompt}</code>
        {s.rules.length > 0 && <p className="ex-rules">规定：{s.rules.join('；')}</p>}
        {s.backup && <p className="ex-rules">备选：{s.backup.name}——{s.backup.why}</p>}</div>
    </div>)}</section>}
    {sec(3) && <section data-n="04"><h2>服饰</h2><div className="ex-looks">{LOOKS.map(l => <div key={l.id} className="ex-look"><Photo seed={l.id.charCodeAt(0) * 7} scene={SCENE_OF[l.spots[0]]} palette={l.palette} ratio={.75} night={l.id === 'C'} />
      <div><b>{l.id} · {l.name}</b><span className="ex-palette">{l.palette.map(c => <i key={c} style={{ background: c }} title={c} />)}</span><ul>{l.items.map(x => <li key={x}>{x}</li>)}</ul><p>{l.why}</p><p className="ex-avoid">避开：{l.avoid}</p>{l.change && <p className="ex-avoid">换装：{hm(l.change.at)} · {l.change.where}</p>}</div></div>)}</div></section>}
    {sec(4) && <section data-n="05"><h2>天气预案</h2><p>14:00 前后阵雨概率 35%，正好落在 4 号机位（蹴上铁道）。如果 13:30 时雷达上已有雨带：直接去<b>琵琶湖疏水纪念馆</b>拍室内砖拱，5 号冈崎疏水取消（雨后水面乱），16:00 后按原计划去祇园——雨后的石板路和灯笼倒影反而更好。</p></section>}
    {sec(5) && <section data-n="06"><h2>装备与清单</h2><ul className="ex-gear">{GEAR.map(g => <li key={g}>{g}</li>)}</ul><p className="ex-foot">太阳位置按京都经纬度计算；天气为模拟预报；开放时间与拍摄规定出发前请再核实。</p></section>}
    {book < 6 && <p className="ex-typing"><i /><i /><i /> 正在写第 {book + 1} 节</p>}
  </article>;
}
