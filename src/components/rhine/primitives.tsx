import type { CSSProperties, ReactNode } from 'react';

export function PanelHeader({ no, title, micro, actions, onExpand }: { no: string; title: string; micro: string; actions?: ReactNode; onExpand?: () => void }) {
  return (
    <header className="rh-ph">
      <span className="rh-ph-no">{no}</span>
      <div className="rh-ph-title"><strong>{title}</strong><span className="rh-micro">{micro}</span></div>
      <div className="rh-ph-actions">
        {actions}
        {onExpand && <button className="rh-icon" onClick={onExpand} aria-label="放大面板" title="放大面板">⤢</button>}
      </div>
    </header>
  );
}

export type IndexTab = { id: string; label: string; count?: number };

export function IndexTabs({ tabs, value, onChange, label }: { tabs: IndexTab[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <div className="rh-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.id} role="tab" className="rh-tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          <b>{String(i + 1).padStart(2, '0')}</b>{t.label}{t.count ? <span className="rh-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SignalDot({ state = 'off', label }: { state?: 'on' | 'wait' | 'bad' | 'off'; label?: string }) {
  return <span className={`rh-dot${state === 'off' ? '' : ` is-${state}`}`} role={label ? 'img' : undefined} aria-label={label} />;
}

export function Ghost({ text, size, style, fill }: { text: string; size: number; style?: CSSProperties; fill?: boolean }) {
  return <span aria-hidden="true" className={`rh-ghost${fill ? ' is-fill' : ''}`} style={{ fontSize: size, ...style }}>{text}</span>;
}

// 引线标注：从锚点 (x, y) 斜出到 (x+dx, y+dy)，再水平延伸 run 像素，末端挂标签。
export function Callout({ x, y, dx, dy, run = 90, code, label }: { x: number; y: number; dx: number; dy: number; run?: number; code: string; label: string }) {
  const ex = dx + (dx < 0 ? -run : run);
  return (
    <div className="rh-callout" style={{ left: x, top: y }} aria-hidden="true">
      <svg width="1" height="1">
        <circle cx={0} cy={0} r={2.5} fill="var(--rh-ink)" />
        <polyline points={`0,0 ${dx},${dy} ${ex},${dy}`} fill="none" stroke="var(--rh-ink)" strokeWidth="1" />
      </svg>
      <div className="rh-callout-label" style={{ top: dy, left: dx < 0 ? ex : dx, width: run }}>
        <span className="rh-micro">{code}</span>
        <strong>{label}</strong>
      </div>
    </div>
  );
}
