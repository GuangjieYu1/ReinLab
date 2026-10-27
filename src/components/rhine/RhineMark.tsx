// ∞± 标志与莫比乌斯循环共用同一条路径：左环 +，右环 −。
export const INFINITY_PATH = 'M100 40 C125 10 170 10 170 40 C170 70 125 70 100 40 C75 10 30 10 30 40 C30 70 75 70 100 40';

export function RhineMark({ size = 28, title = 'Rhine Lab' }: { size?: number; title?: string }) {
  return (
    <svg viewBox="20 4 160 72" width={size * 2.2} height={size} role="img" aria-label={title}>
      <path d={INFINITY_PATH} fill="none" stroke="currentColor" strokeWidth="11" strokeLinecap="square" />
      <path d="M55 40h22M66 29v22" stroke="currentColor" strokeWidth="6" />
      <path d="M126 40h22" stroke="currentColor" strokeWidth="6" />
    </svg>
  );
}

// 路径上五个阶段节点的位置（与 INFINITY_PATH 的走向一致：中心 → 右上 → 右下 → 左上 → 左下）。
const STAGE_POINTS: [number, number][] = [[100, 40], [144, 17.5], [144, 62.5], [56, 17.5], [56, 62.5]];

export function Mobius({ stages, current, running, width = 220 }: { stages: string[]; current: number; running: boolean; width?: number }) {
  return (
    <figure className="rh-mobius" style={{ margin: 0, width }}>
      <svg viewBox="10 0 180 80" width={width} height={width * 80 / 180} role="img" aria-label={`循环${running ? '运行中' : '空闲'}，当前：${stages[current]}`}>
        <path d={INFINITY_PATH} fill="none" stroke="var(--rh-line)" strokeWidth="1.5" pathLength={100} />
        {running && <path className="flow" d={INFINITY_PATH} fill="none" stroke="var(--rh-accent)" strokeWidth="2.5" pathLength={100} />}
        {stages.slice(0, 5).map((_, i) => {
          const [x, y] = STAGE_POINTS[i];
          const now = i === current;
          return <rect key={i} x={x - 4} y={y - 4} width={8} height={8} fill={now ? 'var(--rh-accent)' : 'var(--rh-white)'} stroke="var(--rh-ink)" strokeWidth={now ? 0 : 1} />;
        })}
      </svg>
      <figcaption className="rh-micro" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 6 }}>
        {stages.map((s, i) => <span key={s} style={{ color: i === current ? 'var(--rh-ink)' : undefined }}>{String(i + 1).padStart(2, '0')} {s}</span>)}
      </figcaption>
    </figure>
  );
}
