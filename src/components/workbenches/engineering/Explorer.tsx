import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import './explorer.css';

// 工程台共用的 IDE 式资源管理器：最左一条活动栏（视图切换），右侧是可折叠的文件树与若干分节。
// 再点一次当前视图的图标（或「«」）收起文件树，只留活动栏贴在最左边。

export type TreeNode = { name: string; path: string; ext?: string; children?: TreeNode[]; badge?: 'M' | 'A' | 'D'; ai?: boolean; meta?: ReactNode; title?: string };
export type ExplorerView = string;
/** 活动栏的一个视图：图标 + 名称。不传时用默认的 资源管理器 / 搜索 / 源代码管理 / 本体。 */
export type ExplorerViewDef = { id: string; label: string; icon: ReactNode };
export type ExplorerSection = { id: string; title: string; count?: number; actions?: ReactNode; body: ReactNode; grow?: boolean; folded?: boolean };

const ICON: Record<string, ReactNode> = {
  files: <svg viewBox="0 0 24 24"><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5" /></svg>,
  search: <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></svg>,
  git: <svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M18 11c0 4-6 3-11 6" /></svg>,
  onto: <svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /><path d="M11 7l-5 9M13 7l5 9M7 18h10" /></svg>,
};
const LABEL: Record<string, string> = { files: '资源管理器', search: '搜索', git: '源代码管理', onto: '本体' };

export default function Explorer({ open, view, onView, onToggle, title, sections, badges = {}, code = 'ENGR', views }: {
  open: boolean; view: ExplorerView; onView: (v: ExplorerView) => void; onToggle: () => void;
  title: string; sections: ExplorerSection[]; badges?: Partial<Record<string, number>>; code?: string; views?: ExplorerViewDef[];
}) {
  const defs: ExplorerViewDef[] = views ?? Object.keys(ICON).map(id => ({ id, label: LABEL[id], icon: ICON[id] }));
  const label = (v: string) => defs.find(d => d.id === v)?.label ?? v;
  const [folded, setFolded] = useState<Set<string>>(() => new Set(sections.filter(s => s.folded).map(s => s.id)));
  return <div className="xp" data-open={open || undefined} data-wb-panel>
    <nav className="xp-bar" aria-label="视图">
      {defs.map(({ id: v, label: l, icon }) => <button key={v} aria-pressed={open && v === view} title={l} aria-label={l}
        onClick={() => { if (v === view) onToggle(); else { onView(v); if (!open) onToggle(); } }}>
        {icon}{badges[v] ? <em>{badges[v]}</em> : null}
      </button>)}
      <span className="xp-bar-foot">{code}</span>
    </nav>
    {open && <aside className="xp-panel" aria-label={label(view)}>
      <header className="xp-head"><b>{label(view)}</b><small>{title}</small><button onClick={onToggle} title="收起" aria-label="收起资源管理器">«</button></header>
      <div className="xp-sections">
        {sections.map(s => {
          const isFolded = folded.has(s.id);
          return <section key={s.id} className="xp-sec" data-grow={s.grow && !isFolded || undefined}>
            <header><button onClick={() => setFolded(f => { const n = new Set(f); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} aria-expanded={!isFolded}>
              <i>{isFolded ? '▸' : '▾'}</i>{s.title}{s.count !== undefined && <em>{s.count}</em>}
            </button>{s.actions && <span className="xp-sec-act">{s.actions}</span>}</header>
            {!isFolded && <div className="xp-sec-body">{s.body}</div>}
          </section>;
        })}
      </div>
    </aside>}
  </div>;
}

/** 文件树：单击选中，双击打开（或 single 模式下单击即打开）。 */
export function Tree({ nodes, active, selected, open = [], onSelect, onOpen, filter = '', defaultOpen }: {
  nodes: TreeNode[]; active?: string; selected?: string; open?: string[];
  onSelect?: (path: string) => void; onOpen: (path: string) => void; filter?: string; defaultOpen?: (path: string) => boolean;
}) {
  const [closed, setClosed] = useState<Set<string>>(() => {
    const s = new Set<string>();
    const walk = (ns: TreeNode[]) => ns.forEach(n => { if (n.children) { if (defaultOpen && !defaultOpen(n.path)) s.add(n.path); walk(n.children); } });
    walk(nodes); return s;
  });
  const match = useMemo(() => {
    if (!filter) return null;
    const f = filter.toLowerCase(), hit = new Set<string>();
    const walk = (ns: TreeNode[], up: string[]) => ns.forEach(n => {
      if ((n.name + ' ' + (n.title ?? '')).toLowerCase().includes(f)) [...up, n.path].forEach(p => hit.add(p));
      if (n.children) walk(n.children, [...up, n.path]);
    });
    walk(nodes, []); return hit;
  }, [filter, nodes]);
  const row = (n: TreeNode, depth: number): ReactNode => {
    if (match && !match.has(n.path)) return null;
    const isDir = !!n.children, isClosed = !match && closed.has(n.path);
    const ext = isDir ? '' : n.ext ?? (n.name.includes('.') ? (n.name.split('.').pop() ?? '').toUpperCase() : 'DOC');
    return <div key={n.path} role="treeitem" aria-expanded={isDir ? !isClosed : undefined}>
      <button className="xp-row" style={{ '--d': depth } as CSSProperties} data-dir={isDir || undefined}
        aria-current={active === n.path || undefined} aria-selected={selected === n.path || undefined} data-open={open.includes(n.path) || undefined}
        title={n.title ?? n.path}
        onClick={() => { if (isDir) setClosed(c => { const s = new Set(c); if (s.has(n.path)) s.delete(n.path); else s.add(n.path); return s; }); else onSelect ? onSelect(n.path) : onOpen(n.path); }}
        onDoubleClick={() => { if (!isDir && onSelect) onOpen(n.path); }}
        onKeyDown={e => { if (e.key === 'Enter' && !isDir) onOpen(n.path); }}>
        {Array.from({ length: depth }, (_, k) => <i key={k} className="xp-guide" style={{ left: 14 + k * 12 }} />)}
        <span className="xp-chev">{isDir ? (isClosed ? '▸' : '▾') : ''}</span>
        {isDir ? <span className="xp-folder" /> : <span className="xp-ext" data-ext={ext}>{ext.slice(0, 3)}</span>}
        <span className="xp-name">{n.name}{n.title && <small>{n.title}</small>}</span>
        {n.ai && <i className="xp-ai" title="助手改过" />}
        {n.meta && <span className="xp-meta">{n.meta}</span>}
        {n.badge && <b className="xp-badge" data-b={n.badge}>{n.badge}</b>}
      </button>
      {isDir && !isClosed && n.children!.map(c => row(c, depth + 1))}
    </div>;
  };
  return <div className="xp-tree" role="tree">{nodes.map(n => row(n, 0))}</div>;
}
