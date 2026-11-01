import { useRef, useState } from 'react';
import type { Frame, Pose, PositionLight, ShotSettings } from '../../../../../packages/contracts/src/explore';
import { hm, dateToLocal } from './sunlive';
import { POSE_LABEL, POSE_PATHS, POSE_VIEWBOX } from '../../../../../packages/contracts/src/explore-poses';
export { POSE_LABEL };

// 第二版示意图（09-explore-v2.md 第 8 节；10-explore-v2-contract.md 第 4.3 节）：
// 姿势小人（十种，不生成图片）、参数行、构图框（可拖）、山影 / 楼影提示框。

export function PoseFigure({ pose, title }: { pose: Pose; title?: boolean }) {
  return <span className="exd-pose" title={POSE_LABEL[pose]}><svg viewBox={POSE_VIEWBOX} aria-label={POSE_LABEL[pose]}><path d={POSE_PATHS[pose]} /></svg>{title && <small>{POSE_LABEL[pose]}</small>}</span>;
}

const shutter = (s: number) => s >= 1 ? `${s}s` : `1/${Math.round(1 / s)}`;
/** 参数行：建议起点，不冒充实际相机设置；未知写"—"。 */
export function SettingsRow({ s }: { s: ShotSettings | undefined }) {
  if (!s) return null;
  const cells: [string, string][] = [
    ['焦段', s.focalMm ? `${s.focalMm}mm` : '—'], ['光圈', s.aperture ? `f/${s.aperture}` : '—'],
    ['快门', s.shutterS ? shutter(s.shutterS) : '—'], ['ISO', s.iso ? String(s.iso) : '—'],
  ];
  return <div className="exd-settings"><span className="exd-k">建议起点{s.snapshot?.body || s.snapshot?.lens ? ` · ${[s.snapshot?.body, s.snapshot?.lens].filter(Boolean).join(' + ')}` : ''}</span>
    <div>{cells.map(([k, v]) => <span key={k}><small>{k}</small><b>{v}</b></span>)}</div></div>;
}

/** 构图框：横 3:2 / 竖 2:3 + 三分线；人物框和地平线可拖，松手时回调（写回 detail.frame）。不改地理站位。 */
export function FrameBox({ frame, onChange }: { frame: Frame | undefined; onChange?: (f: Frame) => void }) {
  const [f, setF] = useState<Frame>(frame ?? { orientation: 'portrait', subject: { x: 0.33, y: 0.62, w: 0.22, h: 0.55 }, horizon: 0.66 });
  const box = useRef<HTMLDivElement>(null), drag = useRef<'subject' | 'horizon' | null>(null);
  const rel = (e: React.PointerEvent) => { const r = box.current!.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  const move = (e: React.PointerEvent) => {
    if (!drag.current || !onChange) return;
    const p = rel(e);
    setF(cur => drag.current === 'horizon' ? { ...cur, horizon: p.y } : cur.subject ? { ...cur, subject: { ...cur.subject, x: p.x, y: p.y } } : cur);
  };
  const end = () => { if (drag.current && onChange) onChange(f); drag.current = null; };
  const s = f.subject;
  return <div className="exd-frame-wrap">
    <div className="exd-frame" ref={box} data-o={f.orientation} onPointerMove={move} onPointerUp={end} onPointerLeave={end}>
      <i className="exd-third v1" /><i className="exd-third v2" /><i className="exd-third h1" /><i className="exd-third h2" />
      {f.horizon !== null && <i className="exd-horizon" style={{ top: `${f.horizon * 100}%` }} onPointerDown={e => { drag.current = 'horizon'; (e.target as Element).setPointerCapture?.(e.pointerId); }} title="地平线" />}
      {s && <b className="exd-subject" style={{ left: `${(s.x - s.w / 2) * 100}%`, top: `${(s.y - s.h / 2) * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%` }}
        onPointerDown={e => { drag.current = 'subject'; (e.target as Element).setPointerCapture?.(e.pointerId); }} title="人物" />}
    </div>
    {onChange && <div className="exd-frame-tools">
      <button className="dm-link" onClick={() => { const n = { ...f, orientation: f.orientation === 'portrait' ? 'landscape' as const : 'portrait' as const }; setF(n); onChange(n); }}>{f.orientation === 'portrait' ? '竖 2:3 · 换横' : '横 3:2 · 换竖'}</button>
      <small>拖人物框和地平线；这是构图意图，不改地图上的站位</small>
    </div>}
  </div>;
}

const STATE_TEXT: Record<string, string> = { night: '夜', terrain: '被山挡', building: '被楼挡', maybe_lit: '预计有光', unknown: '未知' };
/** 受光提示框：机位 / 模特分两行，此刻状态 + 下一次见光；未知写原因，不硬填时间。 */
export function LightCallout({ camera, subject, now, day, tz }: { camera: PositionLight; subject: PositionLight | null; now: number; day: string; tz: string }) {
  const row = (label: string, pl: PositionLight) => {
    const cur = pl.segments.find(x => Date.parse(x.start) <= now && now < Date.parse(x.end));
    const next = pl.segments.find(x => x.state === 'maybe_lit' && Date.parse(x.start) > now);
    const st = cur?.state ?? 'unknown';
    return <div key={label} data-state={st}>
      <b>{label}</b><span>{STATE_TEXT[st]}{cur?.cause?.note ? `（${cur.cause.note}）` : ''}</span>
      <small>{st === 'maybe_lit' ? `见光到 ${hm(dateToLocal(cur!.end, day, tz))}` : next ? `${hm(dateToLocal(next.start, day, tz))} 开始预计见光` : pl.missing.length ? `算不出下次见光：${pl.missing[0]}` : '今天之后不再见光'}</small>
      {pl.heightAssumed && <em>按离地 {pl.heightM} 米假设</em>}
    </div>;
  };
  return <div className="exd-light">{row('机位', camera)}{subject && row('模特', subject)}</div>;
}
