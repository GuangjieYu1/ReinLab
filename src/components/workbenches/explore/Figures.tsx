import type { Pose } from './model';

// 姿势简图（给模特看的）与「模拟生成」的样片 / 服饰参考图。只用墨、灰与一处颜色。

const POSES: Record<Pose, string> = {
  walk: 'M20 8 a4 4 0 1 0 0.1 0 M20 16 L19 32 M19 20 L12 27 M19 20 L27 25 M19 32 L13 46 M19 32 L26 45',
  'look-back': 'M23 8 a4 4 0 1 0 0.1 0 M21 16 L19 32 M20 20 L14 28 M20 20 L25 27 M19 32 L15 46 M19 32 L23 46 M26 9 L30 8',
  lean: 'M16 8 a4 4 0 1 0 0.1 0 M17 16 L21 32 M18 20 L28 24 M18 20 L12 26 M21 32 L17 46 M21 32 L25 46 M30 16 L30 46',
  touch: 'M18 8 a4 4 0 1 0 0.1 0 M18 16 L18 32 M18 20 L28 13 M18 20 L13 28 M18 32 L15 46 M18 32 L22 46 M30 6 C 33 9 33 14 29 16',
  pockets: 'M20 8 a4 4 0 1 0 0.1 0 M20 16 L20 32 M20 20 L14 26 L17 31 M20 20 L26 26 L23 31 M20 32 L16 46 M20 32 L24 46',
  scarf: 'M20 8 a4 4 0 1 0 0.1 0 M20 16 L20 32 M20 20 L15 23 L19 13 M20 20 L25 23 L21 13 M20 32 L17 46 M20 32 L23 46',
  step: 'M16 16 a4 4 0 1 0 0.1 0 M17 24 L19 36 M18 27 L26 31 M18 27 L24 33 M19 36 L29 37 L29 46 M19 36 L14 46 M6 46 H34',
  stand: 'M20 8 a4 4 0 1 0 0.1 0 M20 16 L20 32 M20 20 L14 30 M20 20 L26 30 M20 32 L17 46 M20 32 L23 46',
};
export function PoseGlyph({ pose }: { pose: Pose }) {
  return <svg className="ex-pose" viewBox="0 0 40 50" aria-hidden="true"><path d={POSES[pose]} /></svg>;
}

function rng(seed: number) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
/** 样片 / 照片占位：场景（枫树 / 拱 / 铁轨 / 灯笼 / 鸟居）+ 人物剪影（服饰配色）。 */
export function Photo({ seed, scene, palette, person = true, night, stamp = true, ratio = 1.5 }: { seed: number; scene: string; palette?: string[]; person?: boolean; night?: boolean; stamp?: boolean; ratio?: number }) {
  const r = rng(seed), W = 300, H = Math.round(W / ratio), bg = night ? '#1c1a1b' : '#ecebe7', fg = night ? '#3a3837' : '#9a9792';
  const px = W * (.3 + r() * .4), ph = H * .62, pc = palette ?? ['#141213', '#ff7a1a', '#3a3837'];
  return <span className="ex-photo" style={{ aspectRatio: `${ratio}` }}>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width={W} height={H} fill={bg} />
      {scene === 'maple' && <>{Array.from({ length: 9 }, (_, i) => <circle key={i} cx={r() * W} cy={r() * H * .5} r={20 + r() * 30} fill={i % 3 ? '#d9b49a' : '#ff7a1a'} opacity={.35 + r() * .3} />)}<rect x={0} y={H * .78} width={W} height={H * .22} fill="#b9c3c8" /></>}
      {scene === 'arch' && Array.from({ length: 5 }, (_, i) => { const s = 1 - i * .17, w = W * .7 * s, x = (W - w) / 2, h = H * .9 * s; return <path key={i} d={`M${x} ${H} V${H - h * .55} A ${w / 2} ${h * .45} 0 0 1 ${x + w} ${H - h * .55} V${H}`} fill="none" stroke={i ? '#a8978a' : '#6b5a48'} strokeWidth={14 * s} />; })}
      {scene === 'rail' && <><path d={`M${W * .3} ${H} L${W * .48} ${H * .3} M${W * .7} ${H} L${W * .52} ${H * .3}`} stroke="#3a3837" strokeWidth={3} />{Array.from({ length: 8 }, (_, i) => <line key={i} x1={W * (.3 + i * .022)} x2={W * (.7 - i * .022)} y1={H - i * H * .09} y2={H - i * H * .09} stroke="#6b6865" strokeWidth={2} />)}{Array.from({ length: 10 }, (_, i) => <circle key={i} cx={i < 5 ? W * (.12 + r() * .2) : W * (.68 + r() * .2)} cy={H * (.15 + r() * .4)} r={18 + r() * 18} fill="#b8aea2" opacity={.6} />)}</>}
      {scene === 'lantern' && <>{Array.from({ length: 6 }, (_, i) => <rect key={i} x={W * .08 + i * W * .15} y={H * .28} width={W * .12} height={H * .3} fill="#2a2728" stroke="#141213" />)}{Array.from({ length: 6 }, (_, i) => <circle key={`l${i}`} cx={W * .14 + i * W * .15} cy={H * .5} r={7} fill="#ff7a1a" opacity={night ? 1 : .6} />)}<rect x={0} y={H * .72} width={W} height={H * .28} fill={night ? '#26303a' : '#b9c3c8'} /></>}
      {scene === 'torii' && <><rect x={W * .3} y={H * .2} width={W * .05} height={H * .45} fill="#ff7a1a" /><rect x={W * .65} y={H * .2} width={W * .05} height={H * .45} fill="#ff7a1a" /><rect x={W * .24} y={H * .16} width={W * .52} height={H * .05} fill="#ff7a1a" /><rect x={0} y={H * .65} width={W} height={H * .35} fill="#b9c3c8" /><rect x={W * .3} y={H * .68} width={W * .05} height={H * .25} fill="#ff7a1a" opacity={.4} /><rect x={W * .65} y={H * .68} width={W * .05} height={H * .25} fill="#ff7a1a" opacity={.4} /></>}
      {scene === 'garden' && <><path d={`M0 ${H * .55} C ${W * .3} ${H * .3} ${W * .6} ${H * .4} ${W} ${H * .25} V${H} H0Z`} fill="#cbc6be" /><rect x={W * .55} y={H * .3} width={W * .2} height={H * .2} fill="#6b6865" /><path d={`M${W * .2} ${H * .9} L${W * .3} ${H * .62} L${W * .4} ${H * .9}Z`} fill="#fbfbf9" stroke={fg} /><rect x={0} y={H * .85} width={W} height={H * .15} fill="#f6f5f1" /></>}
      {person && <g transform={`translate(${px} ${H - ph - H * .06})`}>
        <circle cx={0} cy={ph * .08} r={ph * .07} fill={night ? '#6b6865' : '#3a3837'} />
        <path d={`M${-ph * .1} ${ph * .17} L${ph * .1} ${ph * .17} L${ph * .14} ${ph * .62} L${-ph * .14} ${ph * .62}Z`} fill={pc[0]} />
        <path d={`M${-ph * .09} ${ph * .62} L${ph * .09} ${ph * .62} L${ph * .07} ${ph} L${-ph * .07} ${ph}Z`} fill={pc[2] ?? pc[0]} />
        <rect x={-ph * .1} y={ph * .15} width={ph * .2} height={ph * .05} fill={pc[1]} />
      </g>}
      {Array.from({ length: 50 }, (_, i) => <rect key={`g${i}`} x={r() * W} y={r() * H} width={1} height={1} fill={night ? '#ecebe7' : '#141213'} opacity={.22} />)}
    </svg>
    {stamp && <em>模拟生成</em>}
  </span>;
}
export const SCENE_OF: Record<string, string> = { P1: 'maple', P2: 'garden', P3: 'arch', P4: 'rail', P5: 'torii', P6: 'lantern', backup: 'arch' };
