import { useEffect, useMemo, useRef, useState } from 'react';
import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import landData from '../data/land-110m.json';
import { normalizeLongitude, type Point } from '../learningState';
import type { SceneProps } from './types';

const land = feature(landData as unknown as Topology<{ land: GeometryCollection }>, landData.objects.land as GeometryCollection);
const places: { name: string; coordinates: Point }[] = [
  { name: '雅典', coordinates: [23.731375, 37.985272] }, { name: '尼科西亚', coordinates: [33.366635, 35.166677] },
  { name: '贝鲁特', coordinates: [35.507762, 33.873921] }, { name: '开罗', coordinates: [31.248022, 30.051906] },
];
const regions = { overview: [10, 24, 1], east: [31, 33, 3], aegean: [24, 37, 2.6], egypt: [31, 26, 2.3] } as const;
const sources = [
  ['A / 建筑层记录', '某处建筑出现破坏层，其上方仍有后续活动痕迹。', '不能单凭一处地点，推断整个区域同时终结。'],
  ['B / 两处地点比较', '两处地点出现变化，但年代区间存在重叠与不确定性。', '区间重叠，不等于同一天发生或原因相同。'],
  ['C / 交流网络线索', '一类外来物品在后续材料中减少，其他物品仍然出现。', '需要检查样本、年代和替代解释。'],
];
export default function HistoryLesson({ scene: s, change, reduced }: SceneProps) {
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(400);
  const [pen, setPen] = useState(false);
  const [view, setView] = useState({ lon: s.lon, lat: s.lat, zoom: s.zoom });
  const viewRef = useRef(view); viewRef.current = view;
  const [strokes, setStrokes] = useState(s.strokes);
  const strokesRef = useRef(strokes); strokesRef.current = strokes;
  const frame = useRef(0);
  const moving = useRef<{ x: number; y: number; lon: number; lat: number; kind: 'rotate' | 'pen' } | null>(null);
  const latestChange = useRef(change); latestChange.current = change;
  useEffect(() => { cancelAnimationFrame(frame.current); setView({ lon: s.lon, lat: s.lat, zoom: s.zoom }); }, [s.lon, s.lat, s.zoom]);
  useEffect(() => { setStrokes(s.strokes); }, [s.strokes]);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, [s.stage]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    const hidden = () => { if (document.hidden) { cancelAnimationFrame(frame.current); latestChange.current(viewRef.current); } };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);
  const radius = Math.min(width / 2 - 15, 176) * view.zoom;
  const projection = useMemo(() => geoOrthographic().translate([width / 2, 185]).scale(radius).rotate([-view.lon, -view.lat]).clipAngle(90), [width, radius, view.lon, view.lat]);
  const path = geoPath(projection);
  const focus = (name: keyof typeof regions) => {
    const [lon, lat, zoom] = regions[name], start = viewRef.current, begin = performance.now();
    cancelAnimationFrame(frame.current);
    const tick = (now: number) => {
      const t = reduced ? 1 : Math.min(1, (now - begin) / 900), u = t * t * (3 - 2 * t);
      const next = { lon: start.lon + (lon - start.lon) * u, lat: start.lat + (lat - start.lat) * u, zoom: start.zoom + (zoom - start.zoom) * u };
      viewRef.current = next; setView(next);
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else { frame.current = 0; change(next, true); }
    };
    frame.current = requestAnimationFrame(tick);
  };
  const geoAt = (x: number, y: number) => {
    const r = svg.current!.getBoundingClientRect(), p: Point = [x - r.left, y - r.top];
    if (Math.hypot(p[0] - width / 2, p[1] - 185) > radius) return null;
    const pos = projection.invert?.(p);
    return pos && pos.every(Number.isFinite) ? pos.map(x => +x.toFixed(3)) as Point : null;
  };
  const endDrag = () => {
    if (!moving.current) return;
    if (moving.current.kind === 'pen') {
      const complete = strokesRef.current.filter(p => p.length > 1);
      setStrokes(complete); change({ strokes: complete }, complete.length > 0);
    } else change(viewRef.current);
    moving.current = null;
  };
  if (s.stage) return <section className="history-materials"><span className="rl-label">以下三项是虚构教学材料，不是真实遗址证据。</span><h3>分开记录：材料、解释与证据缺口。</h3>
    {sources.map(([title, content, limit], i) => <article className="history-source" key={title}><div><span className="rl-index">{title}</span><p>{content}</p><small>{limit}</small></div><label>目前能支持的判断<select aria-label={`材料 ${'ABC'[i]} 的判断`} value={s.judgments[i]} onChange={e => { const judgments = [...s.judgments]; judgments[i] = e.target.value; change({ judgments }, true); }}>{['待判断', '局部变化', '跨区域关联', '暂不足区分'].map(v => <option key={v}>{v}</option>)}</select></label></article>)}
    <p className="rl-result">本地自拟示例用于演示比较流程。正式课程须绑定真实来源和年代。</p></section>;
  return <div className="rl-split"><article className="rl-lecture"><span className="rl-label">专题讲义 / 空间与证据</span><h3>先定位，<br />再提出解释。</h3><p>讨论“海上民族”时，先将视角转向东地中海，再画出需要核查的空间假设。</p><div className="rl-globe-concepts"><button onClick={() => focus('east')}>海上民族 · 定位</button><button onClick={() => focus('aegean')}>爱琴海</button><button onClick={() => focus('egypt')}>埃及地区</button></div><ul><li>陆地：现代地理底图。</li><li>城市：现代定位参照。</li><li>红线：讨论假设或手动批注。</li></ul><blockquote>示范虚线不是已证实的入侵路线。每一条历史路径都需要材料、年代和不确定性说明。</blockquote><div className="rl-reading-source">底图与地点坐标：Natural Earth / world-atlas。D3 正射投影，无 WebGL。资料页为自拟示例。</div></article>
    <section className="rl-live-object"><div className="rl-globe-frame"><svg ref={svg} className="learning-globe" viewBox={`0 0 ${width} 370`} role="img" aria-label="交互地球，支持拖动旋转与红笔批注" onPointerDown={e => {
      cancelAnimationFrame(frame.current);
      if (pen) { const p = geoAt(e.clientX, e.clientY); if (!p) return; const next = [...strokesRef.current.slice(-9), [p]]; strokesRef.current = next; setStrokes(next); }
      moving.current = { x: e.clientX, y: e.clientY, lon: view.lon, lat: view.lat, kind: pen ? 'pen' : 'rotate' };
      e.currentTarget.setPointerCapture(e.pointerId);
    }} onPointerMove={e => {
      const d = moving.current; if (!d) return;
      if (d.kind === 'rotate') { const next = { ...viewRef.current, lon: normalizeLongitude(d.lon - (e.clientX - d.x) * .35), lat: Math.max(-75, Math.min(75, d.lat + (e.clientY - d.y) * .3)) }; viewRef.current = next; setView(next); }
      else {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
        const p = geoAt(e.clientX, e.clientY), list = strokesRef.current; if (!p || !list.length || list.at(-1)!.length >= 100) return;
        const next = [...list.slice(0, -1), [...list.at(-1)!, p]]; strokesRef.current = next; setStrokes(next); d.x = e.clientX; d.y = e.clientY;
      }
    }} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <path d={path({ type: 'Sphere' }) ?? ''} fill="#e4e9df" /><path d={path(geoGraticule10()) ?? ''} fill="none" stroke="#d0d9cb" strokeWidth=".6" /><path d={path(land) ?? ''} fill="#bcc9b4" stroke="#839780" strokeWidth=".55" />
      {s.route && <path d={path({ type: 'LineString', coordinates: places.map(p => p.coordinates) }) ?? ''} fill="none" stroke="#ad6658" strokeWidth="2" strokeDasharray="5 4" />}
      {strokes.filter(s => s.length > 1).map((line, i) => <path key={i} d={path({ type: 'LineString', coordinates: line }) ?? ''} fill="none" stroke="#ad6658" strokeWidth="2" strokeLinecap="round" />)}
      {places.filter(p => geoDistance([view.lon, view.lat], p.coordinates) < Math.PI / 2 - .03).map(p => { const q = projection(p.coordinates)!; return <g key={p.name}><circle cx={q[0]} cy={q[1]} r="3" fill="var(--rl-green)" />{view.zoom > 1.7 && ['雅典', '开罗'].includes(p.name) && <text x={q[0] + 6} y={q[1] + (p.name === '雅典' ? -8 : 16)}>{p.name}</text>}</g>; })}
    </svg><div className="rl-geonote">{pen ? '红笔模式：在球面拖动绘图。' : '拖动旋转；点击左侧概念，转向并放大相应区域。'}</div></div><div className="rl-controls"><button aria-label="地球向左转动" onClick={() => change({ lon: normalizeLongitude(view.lon - 20), lat: view.lat, zoom: view.zoom })}>← 转动</button><button aria-label="地球向右转动" onClick={() => change({ lon: normalizeLongitude(view.lon + 20), lat: view.lat, zoom: view.zoom })}>转动 →</button><button onClick={() => focus('overview')}>全球视角</button><button aria-pressed={s.route} onClick={() => change({ route: !s.route }, true)}>{s.route ? '隐藏示范路径' : '画出讨论路径'}</button><button aria-pressed={pen} onClick={() => setPen(v => !v)}>{pen ? '退出红笔' : '红笔批注'}</button><button disabled={!strokes.length} onClick={() => change({ strokes: strokes.slice(0, -1) }, true)}>撤回笔迹</button></div><div className="rl-globe-legend">虚线是讨论假设；实线是你的批注。均不是已核实路线。</div></section>
  </div>;
}
