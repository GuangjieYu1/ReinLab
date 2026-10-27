// 「模拟生成」占位图：按种子确定性地画（同一个种子永远同一张，换种子就换图），主题取自提示词。
// 只用墨、灰和一处橙色，右下角盖「模拟生成」的章。

export const themeOf = (prompt: string) => /枫|红叶|秋/.test(prompt) && !/夏尔/.test(prompt) ? 'maple' : /夏尔|袋底洞|山姆|霍比特/.test(prompt) ? 'shire' : /封面|海报|定稿/.test(prompt) ? 'cover' : 'line';
function rng(seed: number) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export default function Art({ seed, w, h, theme, blur, stamp = true }: { seed: number; w: number; h: number; theme: string; blur?: number; stamp?: boolean }) {
  const r = rng(seed), W = 300, H = Math.round(300 * h / w);
  const ridge = (base: number, amp: number, n: number) => { const pts = Array.from({ length: n + 1 }, (_, i) => `${(i / n * W).toFixed(1)},${(base + (r() - .5) * amp).toFixed(1)}`); return `0,${H} ${pts.join(' ')} ${W},${H}`; };
  const dark = theme === 'cover';
  const sun = { x: W * (.2 + r() * .6), y: H * (.16 + r() * .2), r: 10 + r() * 16 };
  return <span className="gx-art" style={{ aspectRatio: `${w} / ${h}`, filter: blur ? `blur(${blur}px) saturate(${1 - blur / 12})` : undefined }}>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width={W} height={H} fill={dark ? '#141213' : '#f0eeea'} />
      {theme !== 'cover' && <circle cx={sun.x} cy={sun.y} r={sun.r} fill="#ff7a1a" />}
      <polygon points={ridge(H * .55, 40, 7)} fill={dark ? '#262325' : '#d9d7d1'} />
      <polygon points={ridge(H * .7, 30, 9)} fill={dark ? '#3a3837' : '#9a9792'} />
      <polygon points={ridge(H * .84, 20, 12)} fill={dark ? '#6b6865' : '#3a3837'} />
      {theme === 'shire' && <g><circle cx={W * .62} cy={H * .8} r={H * .09} fill="#141213" stroke="#f0eeea" strokeWidth={2} /><circle cx={W * .62} cy={H * .8} r={2.5} fill="#ff7a1a" /></g>}
      {theme === 'maple' && Array.from({ length: 26 }, (_, i) => { const x = r() * W, y = r() * H * .8, s = 2 + r() * 4; return <rect key={i} x={x} y={y} width={s} height={s} transform={`rotate(45 ${x} ${y})`} fill={i % 4 ? '#ff7a1a' : '#141213'} opacity={.5 + r() * .5} />; })}
      {theme === 'line' && Array.from({ length: 14 }, (_, i) => { const x = r() * W; return <line key={i} x1={x} y1={H * .5 + r() * 20} x2={x + (r() - .5) * 20} y2={H} stroke="#141213" strokeWidth={.8} />; })}
      {theme === 'cover' && <g><rect x={W * .08} y={H * .08} width={W * .84} height={H * .84} fill="none" stroke="#ecebe7" strokeWidth={1} /><rect x={W * .08} y={H * .62} width={W * .3} height={4} fill="#ff7a1a" />
        <text x={W * .12} y={H * .2} fill="#ecebe7" fontSize={W * .085} fontFamily="Archivo, sans-serif" fontWeight={800}>RED BOOK</text>
        <text x={W * .12} y={H * .27} fill="#9a9792" fontSize={W * .04} fontFamily="IBM Plex Mono, monospace">THE LAST PAGE · {String(seed).padStart(4, '0')}</text></g>}
      {Array.from({ length: 40 }, (_, i) => <rect key={`g${i}`} x={r() * W} y={r() * H} width={1} height={1} fill={dark ? '#ecebe7' : '#141213'} opacity={.25} />)}
    </svg>
    {stamp && <em>模拟生成</em>}
  </span>;
}
