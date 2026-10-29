import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DATE, sunFor, type Shot, type Spot } from './model';
import { dayTimes, sunAt } from './sun';

// 京都东山的简化矢量地图（莱茵风格：纸色底、墨线、橙色只给机位与太阳）。不是真实比例，只表达相对位置。
// 选中机位时叠加：镜头视角扇形、日出 / 日落方位线（细）、当前时刻的太阳方位（粗橙）与影子方向（虚线）——参照 PhotoPills 的地图层。
// 拖动平移、滚轮缩放。

const W = 1000, H = 700;
const STREETS: [string, string][] = [
  ['今出川通', 'M0 108 L1000 102'], ['丸太町通', 'M0 330 L860 328'], ['二条通', 'M180 400 L620 396'], ['三条通', 'M0 540 L760 532 L1000 520'], ['四条通', 'M0 664 L640 660'],
  ['川端通', 'M232 0 L236 700'], ['东大路通', 'M612 0 L618 700'], ['白川通', 'M770 0 L776 330 L786 440'], ['神宫道', 'M640 360 L640 540'],
];
const RIVERS = { kamo: 'M214 0 C 206 140 226 260 214 380 C 204 500 222 600 210 700', shirakawa: 'M560 470 C 540 540 500 590 470 610 C 420 640 330 636 240 640', canal: 'M800 548 C 760 500 720 450 680 436 C 560 424 420 432 236 430', philo: 'M832 130 C 822 200 814 260 808 320 C 804 380 820 420 836 446' };
const SITES: { name: string; x: number; y: number; w: number; h: number }[] = [
  { name: '银阁寺', x: 836, y: 98, w: 70, h: 44 }, { name: '永观堂', x: 846, y: 404, w: 54, h: 40 }, { name: '南禅寺', x: 846, y: 478, w: 72, h: 56 },
  { name: '平安神宫', x: 600, y: 352, w: 82, h: 52 }, { name: '冈崎公园', x: 566, y: 440, w: 64, h: 34 }, { name: '八坂神社', x: 628, y: 646, w: 50, h: 40 }, { name: '京都大学', x: 470, y: 130, w: 120, h: 110 },
];
const contours = Array.from({ length: 7 }, (_, i) => { const x = 880 + i * 18; return `M${x} 0 C ${x - 30} 120 ${x + 20} 240 ${x - 20} 360 C ${x - 40} 470 ${x + 10} 580 ${x - 30} 700`; });

export default function KyotoMap({ spots, sel, onSel, t, done = [], shots, onShot, pin, route = true, children }: {
  spots: Spot[]; sel: string | null; onSel: (id: string) => void; t: number; done?: string[];
  shots?: Shot[]; onShot?: (s: Shot) => void; pin?: { x: number; y: number; label: string } | null; route?: boolean; children?: ReactNode;
}) {
  const [vb, setVb] = useState({ x: 380, y: 0, w: 620, h: 700 * 620 / 1000 * 1.25 });
  const box = useRef<SVGSVGElement>(null), drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); const r = el.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      setVb(v => { const k = e.deltaY < 0 ? .88 : 1.14, w = Math.max(240, Math.min(1200, v.w * k)), h = v.h * w / v.w; return { x: v.x + (v.w - w) * fx, y: v.y + (v.h - h) * fy, w, h }; });
    };
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel);
  }, []);
  // 让视口比例跟容器一致。
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setVb(v => ({ ...v, h: v.w * r.height / Math.max(1, r.width) })); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const s = spots.find(x => x.id === sel);
  const order = [...spots].sort((a, b) => a.start - b.start);
  const ray = (x: number, y: number, az: number, len: number) => `M${x} ${y} L${x + Math.sin(az * Math.PI / 180) * len} ${y - Math.cos(az * Math.PI / 180) * len}`;
  const sun = s ? sunFor(s, t) : null, dt = dayTimes(DATE);
  const scale = vb.w / 1000;

  return <svg ref={box} className="km" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
    onPointerDown={e => { if ((e.target as Element).closest('.km-spot, .km-shot')) return; drag.current = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId); }}
    onPointerMove={e => { const d = drag.current; if (!d || !box.current) return; const r = box.current.getBoundingClientRect(), k = vb.w / r.width; setVb(v => ({ ...v, x: d.vx - (e.clientX - d.x) * k, y: d.vy - (e.clientY - d.y) * k })); }}
    onPointerUp={() => { drag.current = null; }}>
    <defs>
      <pattern id="km-grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0 H0 V50" fill="none" stroke="#14121310" /></pattern>
      <pattern id="km-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line y2="6" stroke="#14121318" strokeWidth="2" /></pattern>
    </defs>
    <rect x={-500} y={-500} width={W + 1000} height={H + 1000} fill="#f0eeea" />
    <rect x={-500} y={-500} width={W + 1000} height={H + 1000} fill="url(#km-grid)" />
    <path d={`M880 -20 C 850 120 900 240 860 360 C 840 470 890 580 850 720 L1200 720 L1200 -20 Z`} fill="url(#km-hatch)" />
    {contours.map((d, i) => <path key={i} d={d} className="km-contour" />)}
    <text x={950} y={260} className="km-region">东 山</text>
    {SITES.map(b => <g key={b.name} className="km-site"><rect x={b.x - b.w / 2} y={b.y - b.h / 2} width={b.w} height={b.h} /><text x={b.x} y={b.y + 4}>{b.name}</text></g>)}
    {STREETS.map(([n, d]) => <g key={n} className="km-street"><path d={d} /><text><textPath href={`#km-${n}`} startOffset="6%">{n}</textPath></text><path id={`km-${n}`} d={d} fill="none" stroke="none" /></g>)}
    <path d={RIVERS.kamo} className="km-river is-big" /><text x={190} y={250} className="km-water-label" transform="rotate(-88 190 250)">鸭 川</text>
    <path d={RIVERS.canal} className="km-river" /><path d={RIVERS.shirakawa} className="km-river" /><path d={RIVERS.philo} className="km-river is-philo" />
    <text x={410} y={424} className="km-water-label">琵琶湖疏水</text><text x={330} y={630} className="km-water-label">白川</text>

    {route && <path className="km-route" d={order.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')} />}
    {s && sun && <g className="km-sunlayer">
      <path d={ray(s.x, s.y, sunAt(DATE, dt.sunrise).az, 170 * scale + 60)} className="km-ray is-rise" />
      <path d={ray(s.x, s.y, sunAt(DATE, dt.sunset).az, 170 * scale + 60)} className="km-ray is-set" />
      {sun.alt > 0 && <><path d={ray(s.x, s.y, sun.az, 200 * scale + 80)} className="km-ray is-sun" data-blocked={sun.blocked || undefined} />
        <path d={ray(s.x, s.y, sun.az + 180, Math.min(160, 30 / Math.tan(Math.max(4, sun.alt) * Math.PI / 180)))} className="km-ray is-shadow" />
        <circle cx={s.x + Math.sin(sun.az * Math.PI / 180) * (200 * scale + 80)} cy={s.y - Math.cos(sun.az * Math.PI / 180) * (200 * scale + 80)} r={9 * scale + 3} className="km-sun" data-blocked={sun.blocked || undefined} /></>}
      <path className="km-fov" d={`M${s.x} ${s.y} L${s.x + Math.sin((s.dir - s.fov / 2) * Math.PI / 180) * 90} ${s.y - Math.cos((s.dir - s.fov / 2) * Math.PI / 180) * 90} A 90 90 0 0 1 ${s.x + Math.sin((s.dir + s.fov / 2) * Math.PI / 180) * 90} ${s.y - Math.cos((s.dir + s.fov / 2) * Math.PI / 180) * 90} Z`} />
    </g>}
    {shots?.map(p => <g key={p.id} className="km-shot" data-pick={p.pick || undefined} onClick={() => onShot?.(p)}><rect x={p.x - 4} y={p.y - 4} width={8} height={8} /></g>)}
    {spots.map(p => <g key={p.id} className="km-spot" data-kind={p.kind} data-sel={p.id === sel || undefined} data-done={done.includes(p.id) || undefined} onClick={() => onSel(p.id)} transform={`translate(${p.x} ${p.y}) scale(${Math.max(.6, scale)})`}>
      <rect x={-13} y={-13} width={26} height={26} /><text y={5}>{p.no}</text>
      <text className="km-spot-name" x={18} y={-6}>{p.name.split(' · ')[0]}</text><text className="km-spot-time" x={18} y={9}>{`${String(Math.floor(p.start / 60)).padStart(2, '0')}:${String(p.start % 60).padStart(2, '0')}`}</text>
    </g>)}
    {pin && <g className="km-pin" transform={`translate(${pin.x} ${pin.y}) scale(${Math.max(.6, scale)})`}><circle r={14} /><circle r={5} /><text x={18} y={4}>{pin.label}</text></g>}
    {children}
    <g className="km-north" transform={`translate(${vb.x + vb.w - 40 * scale} ${vb.y + 46 * scale}) scale(${scale})`}><path d="M0 -22 L8 8 L0 2 L-8 8 Z" /><text y={24}>N</text></g>
  </svg>;
}
