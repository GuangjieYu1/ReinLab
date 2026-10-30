import type { ExplorePlan, RefImage, Stop, WeatherView } from '../../../../../packages/contracts/src/explore';
import { center, stopLabels } from './overlays';
import { KIND_TEXT, RefTile } from './StopPanel';
import { dateToLocal, dayLight, hm } from './sunlive';

// 计划书网页（契约 7.1 的结构）：精简 / 详细两版，同一份计划修订。手机宽度单栏；「打印」只打印这一块（A4）。
// PDF 由 DSH 生成，这里不排 PDF，只负责网页和打印。

const KIND_SHOOT: Record<string, string> = { portrait: '人像', landscape: '风光', travel: '旅行', street: '街拍' };
const win = (s: Stop, tz: string) => s.window ? `${hm(dateToLocal(s.window.start, s.day, tz))}–${hm(dateToLocal(s.window.end, s.day, tz))}` : '时段未定';
const unknown = <em className="exl-unk">未知</em>;

export default function BookView({ plan, title, refs, weather, variant, onVariant, onPdf, pdfState }: {
  plan: ExplorePlan; title: string; refs: RefImage[]; weather: WeatherView | null;
  variant: 'brief' | 'full'; onVariant: (v: 'brief' | 'full') => void;
  onPdf: (v: 'brief' | 'full') => void; pdfState: { variant: 'brief' | 'full'; state: 'working' | 'done' | 'failed'; text: string } | null;
}) {
  const tz = plan.destination?.timezone ?? 'UTC';
  const stops = plan.stops.filter(s => s.state === 'confirmed').sort((a, b) => (a.window?.start ?? '~').localeCompare(b.window?.start ?? '~'));
  const labels = stopLabels(plan), draft = plan.state === 'draft';
  const people = plan.people.filter(p => p.data.type === 'model');
  const gear = plan.gear.map(g => g.data.name);
  const day = plan.days[0];
  const at = plan.destination?.center ?? (stops[0] ? center(stops[0]) : null);
  const dl = day && at ? dayLight(day, tz, at[0], at[1]) : null;
  const fetched = weather?.fetchedAt ? new Date(weather.fetchedAt).toLocaleString('zh-CN', { timeZone: tz, hour12: false }) : null;
  const wxLine = (s: Stop) => {
    const hrs = weather?.byStop.find(g => g.stopId === s.id)?.hours.filter(h => s.window && h.at >= s.window.start && h.at <= s.window.end) ?? [];
    if (!hrs.length) return null;
    const max = (k: 'precipProb' | 'cloud') => Math.max(...hrs.map(h => h[k] ?? 0));
    return `云 ${max('cloud')}% · 降水 ${max('precipProb')}%`;
  };

  const head = <header className="ex-book-head">
    <span className="rh-micro">SHOOT PLAN · 旅拍计划书 · 第 {plan.revision} 版{draft ? ' · 草稿' : ''}</span>
    <h1>{title}</h1>
    <p>{plan.destination?.name ?? '目的地未定'} · {plan.days.join('、') || '日期未定'}（当地时间 {tz}）· {plan.kinds.map(k => KIND_SHOOT[k]).join(' / ') || '拍法未定'}{people.length ? ` · 模特 ${people.map(p => p.data.name).join('、')}` : ''}</p>
  </header>;

  const timetable = <table className="ex-table"><thead><tr><th>#</th><th>停留点</th><th>时段</th><th>焦段</th><th>要点</th></tr></thead><tbody>
    {stops.map(s => <tr key={s.id}><td><b>{labels[s.id]}</b></td><td><b>{s.name}</b><small>{KIND_TEXT[s.kind]}</small></td><td>{win(s, tz)}</td><td>{s.focal?.length ? s.focal.map(f => `${f}`).join('/') + 'mm' : '—'}</td>
      <td>{s.detail?.guidance?.[0] ?? s.detail?.composition ?? s.reason ?? '—'}</td></tr>)}
  </tbody></table>;

  const facts = <div className="ex-book-facts">
    <div><small>日出 · 日落</small><b>{dl?.sunrise != null ? hm(dl.sunrise) : '—'} · {dl?.sunset != null ? hm(dl.sunset) : '—'}</b></div>
    <div><small>金色时刻</small><b>{dl?.goldPm ? `${hm(dl.goldPm[0])}–${hm(dl.goldPm[1])}` : '—'}</b></div>
    <div><small>天气</small><b>{weather?.state === 'ok' ? `已取 · ${fetched}` : weather?.state === 'out_of_range' ? '还没进入预报范围' : '未知'}</b></div>
    <div><small>装备</small><b>{gear.length ? gear.join('、') : '未选器材'}</b></div>
  </div>;

  return <div className="exl-bookwrap">
    <div className="exl-book-bar">
      <div className="ex-seg"><button aria-pressed={variant === 'brief'} onClick={() => onVariant('brief')}>精简版</button><button aria-pressed={variant === 'full'} onClick={() => onVariant('full')}>详细版</button></div>
      <button className="rh-btn" onClick={() => window.print()}>打印</button>
      <button className="rh-btn is-solid" disabled={pdfState?.state === 'working' || stops.length === 0} onClick={() => onPdf(variant)}>生成 PDF · {variant === 'brief' ? '精简' : '详细'}</button>
      {pdfState && <span className="exl-pdf" data-state={pdfState.state}>{pdfState.text}</span>}
    </div>
    {stops.length === 0 ? <div className="ex-book is-empty"><b>还没有已确认的停留点</b><span>在地图或对话里把候选点「留下」，或者确认整份计划，计划书就会出现在这里。</span></div>
    : <article className="ex-book exl-book" data-variant={variant}>
      {draft && <p className="exl-draft">草稿：计划还没确认，内容可能还会变。</p>}
      {head}
      {variant === 'brief' ? <>
        <section data-n="01"><h2>时间表</h2>{timetable}</section>
        <section data-n="02"><h2>光线 · 天气 · 装备</h2>{facts}</section>
      </> : <>
        <section data-n="01"><h2>总览</h2>{facts}{timetable}</section>
        {plan.feel && <section data-n="02"><h2>想要的感觉</h2><ul>{plan.feel.observations.map((o, i) => <li key={i}>{o.text}</li>)}{plan.feel.guesses.map((g, i) => <li key={`g${i}`}>{g.text} <em className="exl-unk">推测</em></li>)}</ul></section>}
        {stops.map((s, i) => <section key={s.id} data-n={String(i + 3).padStart(2, '0')} className="exl-book-stop">
          <h2>{labels[s.id]} · {s.name} <small>{KIND_TEXT[s.kind]} · {win(s, tz)}</small></h2>
          <dl className="ex-kv">
            <div><dt>光线</dt><dd>{s.light?.lit ? (s.light.lit.length ? `地形见光 ${s.light.lit.map(x => `${hm(dateToLocal(x.start, s.day, tz))}–${hm(dateToLocal(x.end, s.day, tz))}`).join('，')}` : '全天被山挡') : unknown}</dd></div>
            <div><dt>构图</dt><dd>{s.detail?.composition ?? unknown}{s.facing !== undefined ? ` · 朝向 ${Math.round(s.facing)}°` : ''}</dd></div>
            <div><dt>焦段</dt><dd>{s.focal?.length ? s.focal.map(f => `${f}mm`).join(' · ') : unknown}</dd></div>
            {people.length > 0 && <div><dt>引导词</dt><dd>{s.detail?.guidance?.length ? <ol className="ex-lines">{s.detail.guidance.map(x => <li key={x}>{x}</li>)}</ol> : unknown}</dd></div>}
            {people.length > 0 && <div><dt>服饰</dt><dd>{s.detail?.outfit ? <>{s.detail.outfit.palette && <span className="ex-palette">{s.detail.outfit.palette.map(c => <i key={c} style={{ background: c }} />)}</span>}{s.detail.outfit.notes}</> : unknown}</dd></div>}
            <div><dt>天气</dt><dd>{wxLine(s) ?? unknown}</dd></div>
            <div><dt>规定</dt><dd>{s.detail?.rules?.length ? s.detail.rules.map(r => r.text).join('；') : unknown}</dd></div>
            <div><dt>雨天备选</dt><dd>{s.detail?.fallback ?? unknown}</dd></div>
          </dl>
          {refs.some(r => s.refs.includes(r.id)) && <div className="exl-refs">{refs.filter(r => s.refs.includes(r.id)).slice(0, 3).map(r => <RefTile key={r.id} r={r} />)}</div>}
        </section>)}
        <section data-n="99"><h2>参考来源</h2><ul className="exl-sources">{refs.filter(r => r.page).map(r => <li key={r.id}>{[r.author, r.platform].filter(Boolean).join(' · ')} — <a href={r.page!.url} target="_blank" rel="noreferrer">{r.page!.title ?? r.page!.url}</a></li>)}</ul>
          {fetched && <p className="ex-foot">天气取自 {weather?.source.name}，获取于 {fetched}（当地时间）。</p>}</section>
      </>}
    </article>}
  </div>;
}
