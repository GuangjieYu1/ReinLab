import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import Chat, { msgId, now, type Msg } from './Chat';
import type { BenchProps } from './WorkbenchStudio';
import './bench-exploration.css';

/* ── StarMap: places are stars, the day's route is a constellation, and the
   plan plays back over a day so the map shows where you are and the light. ── */
type Kind = 'sight' | 'photo' | 'food' | 'move';
interface Stop { id: string; name: string; kind: Kind; x: number; y: number; t: number; dur: number; mag: 1 | 2 | 3; note: string; photo?: { dir: number; fov: number; best: string; lens: string; tip: string }; added?: boolean }
interface Trip { title: string; area: string; date: string; river: string; hills: boolean; stops: Stop[]; actions: Action[] }
interface Action { ask: string; reply: string; add?: Stop; shift?: [string, number]; tools: string[] }
const KIND: Record<Kind, string> = { sight: '景点', photo: '拍摄点', food: '餐饮', move: '交通' };
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const H = (h: number, m = 0) => h * 60 + m;

const TRIPS: Trip[] = [
  { title: '京都 · 秋日观察', area: '左京 · 东山', date: '10 月下旬 · 第 1 天', river: 'M330 0 C 318 120 352 230 336 330 C 322 430 296 520 312 640', hills: true,
    stops: [
      { id: 'S1', name: '出町柳 · 鸭川三角洲', kind: 'photo', x: 336, y: 150, t: H(6, 20), dur: 50, mag: 2, note: '两条河在这里汇合，踏石上的人会停顿。', photo: { dir: 95, fov: 70, best: '日出 · 晨光', lens: '35mm', tip: '面向东侧，逆光拍踏石上的剪影。' } },
      { id: 'S2', name: '糺之森', kind: 'sight', x: 372, y: 70, t: H(7, 25), dur: 45, mag: 2, note: '林间小路的宽度与步速。' },
      { id: 'S3', name: '银阁寺', kind: 'sight', x: 720, y: 190, t: H(8, 40), dur: 70, mag: 3, note: '砂堆与建筑之间的空地。开门后的第一个小时人最少。' },
      { id: 'S4', name: '哲学之道', kind: 'sight', x: 730, y: 360, t: H(10, 5), dur: 80, mag: 3, note: '沿水渠的长椅间距，红叶初期。' },
      { id: 'S5', name: '南禅寺 · 水路阁', kind: 'photo', x: 690, y: 500, t: H(13, 40), dur: 55, mag: 3, note: '拱下的阴影与穿行的节奏。', photo: { dir: 200, fov: 50, best: '午后侧光', lens: '24mm', tip: '低机位沿拱廊纵深，等人走出拱门。' } },
      { id: 'S6', name: '冈崎 · 疏水', kind: 'sight', x: 540, y: 455, t: H(15, 0), dur: 50, mag: 1, note: '开阔水面旁，人们选择在哪里停留。' },
      { id: 'S7', name: '祇园 · 白川', kind: 'photo', x: 452, y: 560, t: H(17, 25), dur: 50, mag: 2, note: '傍晚亮灯后的石板路。', photo: { dir: 300, fov: 60, best: '蓝调时刻', lens: '50mm', tip: '亮灯与天光平衡的十几分钟最好。' } },
    ],
    actions: [
      { ask: '加一个日落拍摄点', tools: ['查询地形 · 东山西坡视野', '计算 10 月下旬日落方位 ≈ 255°'], reply: '东山西坡视野开阔，可以俯瞰市区并面向日落方向。我加在冈崎之后：16:05 出发上山，16:40 前到位，看完再下到祇园。路线和时间是示意，上山方式与开放时间出发前请再确认。', add: { id: 'S8', name: '东山西坡 · 远眺', kind: 'photo', x: 800, y: 575, t: H(16, 30), dur: 45, mag: 2, note: '俯瞰市区，太阳落在西山。', photo: { dir: 255, fov: 80, best: '日落 · 金色时刻', lens: '70–200mm', tip: '压缩远景，把京都塔放进西山的剪影里。' }, added: true } },
      { ask: '午饭安排在哲学之道附近', tools: ['沿路线搜索 · 步行 5 分钟内'], reply: '在哲学之道南段留了一个午饭位置，12:00–13:00，饭后正好走到南禅寺。具体店铺需要你出发前选，营业时间请再核实。', add: { id: 'S9', name: '哲学之道南段 · 午餐', kind: 'food', x: 712, y: 430, t: H(12, 0), dur: 60, mag: 1, note: '在这里留一个小时午饭（店铺待定）。', added: true } },
      { ask: '银阁寺挪到人少的时候', tools: ['比较停留时段'], reply: '把银阁寺移到 8:30。我的依据是开门后不久通常人较少，这只是经验判断，没有查实时人流。后面的安排顺延了 10 分钟以内。', shift: ['S3', -10] },
    ] },
  { title: '城市漫步路线', area: '河岸 · 旧街区', date: '半日', river: 'M0 420 C 240 400 520 470 1000 410', hills: false,
    stops: [{ id: 'S1', name: '河岸起点', kind: 'sight', x: 160, y: 400, t: H(15), dur: 20, mag: 1, note: '记录第一眼看到的三样东西。' }, { id: 'S2', name: '旧市场', kind: 'sight', x: 360, y: 250, t: H(15, 35), dur: 40, mag: 2, note: '摊位之间的通道宽度。' }, { id: 'S3', name: '坡道街区', kind: 'photo', x: 600, y: 170, t: H(16, 30), dur: 30, mag: 2, note: '台阶与坡道的交替。', photo: { dir: 240, fov: 60, best: '斜光', lens: '35mm', tip: '从坡顶向下拍纵深。' } }, { id: 'S4', name: '小公园', kind: 'sight', x: 760, y: 330, t: H(17, 15), dur: 30, mag: 1, note: '黄昏时谁会留下。' }],
    actions: [{ ask: '加一个拍黄昏的位置', tools: ['查找开阔视野'], reply: '在小公园西侧的桥上加了一个黄昏位置（示意）。', add: { id: 'S5', name: '西桥 · 黄昏', kind: 'photo', x: 860, y: 430, t: H(17, 50), dur: 25, mag: 2, note: '桥面与河面的反光。', photo: { dir: 260, fov: 70, best: '日落', lens: '50mm', tip: '低角度拍河面倒影。' }, added: true } }] },
  { title: '建筑与街区观察', area: '旧城区', date: '一日', river: 'M0 560 C 300 540 600 590 1000 540', hills: false,
    stops: [{ id: 'S1', name: '街角立面', kind: 'photo', x: 200, y: 180, t: H(9), dur: 30, mag: 2, note: '立面开窗的比例。', photo: { dir: 60, fov: 50, best: '东光', lens: '24mm', tip: '正对立面，保持垂直线。' } }, { id: 'S2', name: '内院', kind: 'sight', x: 380, y: 300, t: H(9, 40), dur: 40, mag: 2, note: '从街道进入内院的三次转折。' }, { id: 'S3', name: '连廊', kind: 'sight', x: 600, y: 230, t: H(10, 35), dur: 30, mag: 1, note: '廊下的停留点。' }, { id: 'S4', name: '屋顶平台', kind: 'photo', x: 760, y: 420, t: H(11, 20), dur: 40, mag: 3, note: '从高处看街区的空隙。', photo: { dir: 180, fov: 90, best: '顶光', lens: '16mm', tip: '俯拍屋顶的节奏。' } }],
    actions: [{ ask: '加一个午饭', tools: ['沿路线搜索'], reply: '在连廊附近留了午饭时间（店铺待定）。', add: { id: 'S5', name: '午餐（待定）', kind: 'food', x: 640, y: 320, t: H(12, 10), dur: 50, mag: 1, note: '店铺待定。', added: true } }] },
  { title: '交通与停留安排', area: '站前 · 资料室', date: '第 1 天', river: 'M420 0 C 440 220 400 420 440 640', hills: false,
    stops: [{ id: 'S1', name: '车站', kind: 'move', x: 220, y: 520, t: H(8), dur: 20, mag: 2, note: '寄存行李。' }, { id: 'S2', name: '住处', kind: 'move', x: 280, y: 330, t: H(8, 35), dur: 25, mag: 1, note: '确认入住时间。' }, { id: 'S3', name: '资料室', kind: 'sight', x: 600, y: 230, t: H(9, 15), dur: 120, mag: 3, note: '开放时间请出发前核实。' }, { id: 'S4', name: '展览', kind: 'sight', x: 720, y: 450, t: H(11, 30), dur: 90, mag: 3, note: '带着资料室里的问题进入展览。' }],
    actions: [{ ask: '算一下步行时间', tools: ['计算站点间距离（示意比例）'], reply: '按示意图比例估算，每段步行 8–15 分钟；真实距离需要接入地图服务后才能计算。' }] },
];

// Light model for late October around Kyoto (approximate, for planning only).
const SUNRISE = H(6, 8), SUNSET = H(17, 18);
const bands = [{ from: SUNRISE - 25, to: SUNRISE, kind: 'blue' }, { from: SUNRISE, to: SUNRISE + 45, kind: 'gold' }, { from: SUNSET - 50, to: SUNSET, kind: 'gold' }, { from: SUNSET, to: SUNSET + 25, kind: 'blue' }];
function sun(t: number) { const p = (t - SUNRISE) / (SUNSET - SUNRISE); return { up: p >= 0 && p <= 1, az: 108 + p * 147, el: Math.sin(Math.max(0, Math.min(1, p)) * Math.PI) * 40 }; }
function night(t: number) { if (t < SUNRISE - 25 || t > SUNSET + 25) return 1; if (t < SUNRISE) return (SUNRISE - t) / 25; if (t > SUNSET) return (t - SUNSET) / 25; return 0; }
const star = (x: number, y: number, r: number) => { const k = r * .32; return `M${x} ${y - r} L${x + k} ${y - k} L${x + r} ${y} L${x + k} ${y + k} L${x} ${y + r} L${x - k} ${y + k} L${x - r} ${y} L${x - k} ${y - k} Z`; };

export default function ExplorationBench({ file, reduced }: BenchProps) {
  const trip = TRIPS[file];
  const [stops, setStops] = useState<Stop[]>(trip.stops);
  const [used, setUsed] = useState<string[]>([]);
  const [sel, setSel] = useState(stops[0].id);
  const [layers, setLayers] = useState<Record<Kind | 'route' | 'cones', boolean>>({ sight: true, photo: true, food: true, move: true, route: true, cones: true });
  const plan = useMemo(() => [...stops].sort((a, b) => a.t - b.t), [stops]);
  const startT = Math.min(...plan.map(s => s.t)) - 40, endT = Math.max(...plan.map(s => s.t + s.dur)) + 40;
  const span = Math.max(H(5), Math.floor(startT / 60) * 60), spanEnd = Math.min(H(21), Math.ceil(endT / 60) * 60);
  const [t, setT] = useState(plan[0].t + 10);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Msg[]>(() => [
    { id: msgId(), who: 'me', text: `${trip.title}：想拍点东西，也想慢慢走。` },
    { id: msgId(), who: 'ai', at: '21:10', tools: [{ kind: 'map', label: `标记 ${trip.stops.length} 个地点` }, { kind: 'plan', label: '按光线排顺序' }], text: <p>我把地点排成了一条线：早上拍河边的晨光，上午走人少的寺院，午后拍有侧光的建筑，傍晚等亮灯。地图下方的时间轴可以拖动或播放，看每个时刻你会在哪、光从哪边来。</p> },
  ]);
  const stop = stops.find(s => s.id === sel) ?? plan[0];
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setT(v => { if (v >= spanEnd) { setPlaying(false); return spanEnd; } return v + (reduced ? 10 : 2); }), 40);
    return () => window.clearInterval(id);
  }, [playing, spanEnd, reduced]);

  // Where you are at time t: at a stop during its stay, otherwise between two stops.
  const here = useMemo(() => {
    const at = plan.find(s => t >= s.t && t <= s.t + s.dur);
    if (at) return { x: at.x, y: at.y, label: `在 ${at.name}`, stop: at.id };
    const next = plan.findIndex(s => s.t > t);
    if (next <= 0) { const s = next === 0 ? plan[0] : plan[plan.length - 1]; return { x: s.x, y: s.y, label: next === 0 ? '尚未出发' : '行程结束', stop: '' }; }
    const a = plan[next - 1], b = plan[next]; const p = (t - (a.t + a.dur)) / Math.max(1, b.t - (a.t + a.dur));
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, label: `前往 ${b.name}`, stop: '' };
  }, [plan, t]);
  const s = sun(t); const dark = night(t);
  const inBand = (st: Stop) => !!st.photo && Math.abs(t - (st.t + st.dur / 2)) < st.dur;

  function onSend(text: string) {
    setMessages(m => [...m, { id: msgId(), who: 'me', text }]);
    const action = trip.actions.find(a => a.ask === text) ?? trip.actions.find(a => !used.includes(a.ask) && [...a.ask].filter(ch => text.includes(ch)).length >= 3);
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      if (!action) { setMessages(m => [...m, { id: msgId(), who: 'ai', at: now(), text: <p>本地预演里我只会几种预设调整（见下方建议）。接入地图与规划服务后，可以按你的话直接改路线。</p> }]); return; }
      setUsed(u => [...u, action.ask]);
      if (action.add) { setStops(list => list.some(x => x.id === action.add!.id) ? list : [...list, action.add!]); setSel(action.add.id); setT(action.add.t + 5); }
      if (action.shift) { const [id, d] = action.shift; setStops(list => list.map(x => x.id === id ? { ...x, t: x.t + d } : x)); setSel(id); }
      setMessages(m => [...m, { id: msgId(), who: 'ai', at: now(), tools: action.tools.map(l => ({ kind: 'map' as const, label: l })), text: <p>{action.reply}</p> }]);
    }, reduced ? 0 : 800);
  }

  return <div className="ex" data-dark={dark > .55 || undefined} style={{ '--night': dark } as CSSProperties}>
    <Chat className="ex-chat" title="旅程规划" agent="FIELD PLANNER" messages={messages} onSend={onSend} busy={busy} suggestions={trip.actions.filter(a => !used.includes(a.ask)).map(a => a.ask)} placeholder="比如：最佳拍摄点、午饭、避开人多" />

    <section className="ex-map">
      <div className="ex-map-bar">
        <b>{trip.title}</b><span>{trip.area} · {trip.date}</span>
        <span className="ex-layers">{(['sight', 'photo', 'food', 'move'] as Kind[]).map(k => <button key={k} aria-pressed={layers[k]} data-k={k} onClick={() => setLayers(l => ({ ...l, [k]: !l[k] }))}><i />{KIND[k]}</button>)}<button aria-pressed={layers.route} onClick={() => setLayers(l => ({ ...l, route: !l.route }))}>星座连线</button><button aria-pressed={layers.cones} onClick={() => setLayers(l => ({ ...l, cones: !l.cones }))}>取景方向</button></span>
      </div>
      <svg className="ex-svg" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid meet" aria-label={`${trip.title} 星图`}>
        <defs>
          <pattern id="ex-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" className="ex-gridline" /></pattern>
          <radialGradient id="ex-glow"><stop offset="0" stopColor="#e9d6a6" stopOpacity=".9" /><stop offset="1" stopColor="#e9d6a6" stopOpacity="0" /></radialGradient>
        </defs>
        <rect x="-400" y="-300" width="1800" height="1240" fill="url(#ex-grid)" />
        {trip.hills && <g className="ex-hills">{[0, 1, 2, 3, 4].map(i => <path key={i} d={`M${880 - i * 34} -20 C ${840 - i * 40} 160 ${900 - i * 30} 320 ${830 - i * 36} 480 S ${860 - i * 30} 640 ${820 - i * 30} 700`} />)}<text x="900" y="300" transform="rotate(90 900 300)">東 山</text></g>}
        <path d={trip.river} className="ex-river" /><path d={trip.river} className="ex-river-line" />
        <rect x="-400" y="-300" width="1800" height="1240" className="ex-night" />
        {Array.from({ length: 22 }, (_, i) => <circle key={i} className="ex-bgstar" cx={(i * 263) % 1000} cy={(i * 151) % 640} r={(i % 3) * .5 + .6} />)}
        {layers.route && <path className="ex-route" d={plan.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')} />}
        {layers.route && <path className="ex-route-done" d={plan.filter(p => p.t <= t).map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ') + (plan.some(p => p.t <= t) ? ` L${here.x} ${here.y}` : '')} />}
        {layers.cones && stops.filter(x => x.photo && layers.photo).map(x => { const a = (x.photo!.dir - x.photo!.fov / 2) * Math.PI / 180, b = (x.photo!.dir + x.photo!.fov / 2) * Math.PI / 180, r = 62; return <path key={x.id + 'c'} className="ex-cone" data-live={inBand(x) || undefined} d={`M${x.x} ${x.y} L${x.x + Math.sin(a) * r} ${x.y - Math.cos(a) * r} A${r} ${r} 0 0 1 ${x.x + Math.sin(b) * r} ${x.y - Math.cos(b) * r} Z`} />; })}
        {stops.filter(x => layers[x.kind]).map(x => { const r = 7 + x.mag * 4; const order = plan.indexOf(x) + 1; return <g key={x.id} className="ex-star" data-kind={x.kind} data-on={x.id === sel || undefined} data-here={here.stop === x.id || undefined} data-new={x.added || undefined} onClick={() => setSel(x.id)} role="button" tabIndex={0} aria-label={`${order}. ${x.name} ${hm(x.t)}`} onKeyDown={e => { if (e.key === 'Enter') setSel(x.id); }}>
          <circle cx={x.x} cy={x.y} r={r * 2.2} fill="url(#ex-glow)" className="ex-halo" />
          {x.kind === 'photo' ? <g className="ex-reticle"><circle cx={x.x} cy={x.y} r={r * .9} /><path d={`M${x.x - r * 1.4} ${x.y}h${r * .7}M${x.x + r * .7} ${x.y}h${r * .7}M${x.x} ${x.y - r * 1.4}v${r * .7}M${x.x} ${x.y + r * .7}v${r * .7}`} /></g>
            : x.kind === 'food' ? <rect x={x.x - r * .55} y={x.y - r * .55} width={r * 1.1} height={r * 1.1} transform={`rotate(45 ${x.x} ${x.y})`} className="ex-shape" />
            : <path d={star(x.x, x.y, r)} className="ex-shape" />}
          <text x={x.x + r + 6} y={x.y - 4} className="ex-name">{x.name}</text>
          <text x={x.x + r + 6} y={x.y + 10} className="ex-time">{String(order).padStart(2, '0')} · {hm(x.t)}</text>
        </g>; })}
        <g className="ex-here" transform={`translate(${here.x} ${here.y})`}><circle r="16" className="ex-here-ring" /><circle r="5.5" /></g>
        <g className="ex-compass" transform="translate(940 70)"><circle r="34" /><text y="-40" textAnchor="middle">N</text>{s.up && <g transform={`rotate(${s.az})`}><line y1="0" y2="-34" /><circle cy="-34" r={4 + s.el / 10} className="ex-sun" /></g>}<text y="52" textAnchor="middle" className="ex-compass-t">{s.up ? `太阳 ${Math.round(s.az)}° · 高度 ${Math.round(s.el)}°` : '日落后'}</text></g>
      </svg>
      <span className="ex-here-tag"><i />{hm(t)} · {here.label}</span>
      <span className="chip sim ex-disclaim">示意地图 · 位置与比例非真实 · 光线按 10 月下旬估算</span>
    </section>

    <aside className="p ex-card" key={stop.id}>
      <header className="p-h dark"><b>{KIND[stop.kind]} · {stop.id}</b><span>{hm(stop.t)} – {hm(stop.t + stop.dur)}</span></header>
      <div className="p-body ex-card-body scroll-thin">
        <h3>{stop.name}{stop.added && <span className="chip gold">AI 新增</span>}</h3>
        <p>{stop.note}</p>
        {stop.photo && <div className="ex-photo">
          <svg viewBox="-50 -50 100 100" aria-hidden="true"><circle r="44" /><path d={`M0 0 L${Math.sin((stop.photo.dir - stop.photo.fov / 2) * Math.PI / 180) * 44} ${-Math.cos((stop.photo.dir - stop.photo.fov / 2) * Math.PI / 180) * 44} A44 44 0 0 1 ${Math.sin((stop.photo.dir + stop.photo.fov / 2) * Math.PI / 180) * 44} ${-Math.cos((stop.photo.dir + stop.photo.fov / 2) * Math.PI / 180) * 44} Z`} /><text y="-35" textAnchor="middle">N</text></svg>
          <dl className="kv"><dt>朝向</dt><dd className="mono">{stop.photo.dir}° · 视角 {stop.photo.fov}°</dd><dt>最佳</dt><dd>{stop.photo.best}</dd><dt>焦段</dt><dd className="mono">{stop.photo.lens}</dd></dl>
          <p className="ex-tip">{stop.photo.tip}</p>
        </div>}
        <button className="b" onClick={() => setT(stop.t + 2)}>跳到这个时刻</button>
        <h4>当天行程</h4>
        <ol className="ex-plan">{plan.map((p, i) => <li key={p.id}><button aria-current={p.id === sel || undefined} data-here={here.stop === p.id || undefined} onClick={() => { setSel(p.id); setT(p.t + 2); }}><time className="mono">{hm(p.t)}</time><em className="num">{String(i + 1).padStart(2, '0')}</em><span>{p.name}</span><i data-kind={p.kind} /></button></li>)}</ol>
      </div>
    </aside>

    <section className="p ex-time">
      <div className="ex-time-head"><button className="b solid" onClick={() => { if (t >= spanEnd) setT(span); setPlaying(v => !v); }}>{playing ? '❚❚ 暂停' : '▶ 播放这一天'}</button><span className="mono">{hm(t)}</span><span className="ex-time-legend"><i className="gold" />金色时刻<i className="blue" />蓝调时刻</span><span className="ex-time-note">日出 {hm(SUNRISE)} · 日落 {hm(SUNSET)}（估算）</span></div>
      <div className="ex-track">
        {bands.map(b => <i key={b.from} className={`ex-band ${b.kind}`} style={{ left: `${(b.from - span) / (spanEnd - span) * 100}%`, width: `${(b.to - b.from) / (spanEnd - span) * 100}%` }} />)}
        {Array.from({ length: (spanEnd - span) / 60 + 1 }, (_, i) => <span key={i} className="ex-hour mono" style={{ left: `${i * 60 / (spanEnd - span) * 100}%` }}>{String(span / 60 + i).padStart(2, '0')}</span>)}
        {plan.map(p => <button key={p.id} className="ex-block" data-kind={p.kind} data-on={p.id === sel || undefined} style={{ left: `${(p.t - span) / (spanEnd - span) * 100}%`, width: `${p.dur / (spanEnd - span) * 100}%` }} onClick={() => { setSel(p.id); setT(p.t + 2); }} title={`${hm(p.t)} ${p.name}`}><span>{p.name}</span></button>)}
        <input type="range" min={span} max={spanEnd} step={1} value={t} onChange={e => { setPlaying(false); setT(+e.target.value); }} aria-label="一天中的时刻" />
        <i className="ex-head" style={{ left: `${(t - span) / (spanEnd - span) * 100}%` }} />
      </div>
    </section>
  </div>;
}
