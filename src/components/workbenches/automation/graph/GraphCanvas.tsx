import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPE } from 'react';
import { CAT_CODE, DEF, DEFS, inPos, makeNode, newLinkId, nodeSize, outPos, ROW, TEXT_H, TYPE_COLOR, widgetRows, type GGroup, type GLink, type GNode, type Output, type SType, type WDef, type Workflow } from './graphModel';
import type { Live } from './useGraphRunner';
import Art from './Art';

// 节点画布（照 ComfyUI 的交互，DOM + SVG，不用 WebGL）：
// 拖标题移动节点 · 拖空白平移 · 滚轮缩放 · 从输出插槽拖出连线到同类型输入（松在空白处会弹出搜索，只列能接上的节点）
// · 点已连接的输入把线拔下来 · 双击空白搜索加节点 · Delete 删除选中节点 · 拖组标题连同组里的节点一起移动 · 右下角小地图。

type View = { x: number; y: number; k: number };
type Drag = { kind: 'node'; id: string; ox: number; oy: number } | { kind: 'group'; id: string; ox: number; oy: number; inside: string[]; gx: number; gy: number; start: Record<string, [number, number]> } | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number } | { kind: 'wire'; from: [string, number]; type: SType; x: number; y: number };
type Search = { cx: number; cy: number; wx: number; wy: number; type?: SType; from?: [string, number]; q: string; i: number };

const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => { const dx = Math.max(40, Math.abs(b.x - a.x) * .5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };

export default function GraphCanvas({ fitKey, wf, onChange, live, errors, latest, installed, params, onSelect }: {
  fitKey?: number; wf: Workflow; onChange: (p: { nodes?: GNode[]; links?: GLink[]; groups?: GGroup[] }) => void;
  live: Live | null; errors: Record<string, string>; latest: Output[] | undefined; installed: (name: string) => boolean; params: string[];
  onSelect?: (id: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: .8 });
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const wfRef = useRef(wf); wfRef.current = wf;
  const viewRef = useRef(view); viewRef.current = view;
  const st = live?.wf === wf.id ? live : null;

  const bounds = useCallback(() => {
    const xs = wf.nodes.flatMap(n => { const s = nodeSize(n, wf.links); return [n.x, n.x + s.w]; }), ys = wf.nodes.flatMap(n => { const s = nodeSize(n, wf.links); return [n.y, n.y + s.h]; });
    wf.groups.forEach(g => { xs.push(g.x, g.x + g.w); ys.push(g.y - 24, g.y + g.h); });
    return { x0: Math.min(...xs, 0), y0: Math.min(...ys, 0), x1: Math.max(...xs, 400), y1: Math.max(...ys, 300) };
  }, [wf]);
  const fit = useCallback(() => {
    const el = box.current; if (!el) return; const b = bounds(), cw = el.clientWidth, ch = el.clientHeight;
    const k = Math.max(.42, Math.min(1, (cw - 80) / (b.x1 - b.x0), (ch - 80) / (b.y1 - b.y0)));
    setView({ k, x: (cw - (b.x1 - b.x0) * k) / 2 - b.x0 * k, y: Math.max(40, (ch - (b.y1 - b.y0) * k) / 2) - b.y0 * k });
  }, [bounds]);
  useLayoutEffect(() => { fit(); }, [wf.id, fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);

  const toWorld = (cx: number, cy: number) => { const r = box.current!.getBoundingClientRect(), v = viewRef.current; return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k }; };
  // 滚轮缩放：以光标为中心（需要非被动监听才能阻止页面滚动）。
  useEffect(() => {
    const el = box.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      setView(v => { const k = Math.max(.3, Math.min(2, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); return { k, x: mx - (mx - v.x) * k / v.k, y: my - (my - v.y) * k / v.k }; });
    };
    el.addEventListener('wheel', onWheel, { passive: false }); return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // Delete 删除选中的节点（焦点在输入框里时不删）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sel || !['Delete', 'Backspace'].includes(e.key) || (e.target as HTMLElement).closest('input, textarea, select')) return;
      const w = wfRef.current; onChange({ nodes: w.nodes.filter(n => n.id !== sel), links: w.links.filter(l => l.from[0] !== sel && l.to[0] !== sel) }); setSel(null);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [sel, onChange]);

  // 拖拽：移动节点 / 组、平移、拉线。
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const p = toWorld(e.clientX, e.clientY), w = wfRef.current;
      if (drag.kind === 'pan') setView(v => ({ ...v, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy }));
      else if (drag.kind === 'node') onChange({ nodes: w.nodes.map(n => n.id === drag.id ? { ...n, x: Math.round(p.x - drag.ox), y: Math.round(p.y - drag.oy) } : n) });
      else if (drag.kind === 'group') {
        const dx = p.x - drag.ox - drag.gx, dy = p.y - drag.oy - drag.gy;
        onChange({ groups: w.groups.map(g => g.id === drag.id ? { ...g, x: Math.round(drag.gx + dx), y: Math.round(drag.gy + dy) } : g), nodes: w.nodes.map(n => drag.inside.includes(n.id) ? { ...n, x: Math.round(drag.start[n.id][0] + dx), y: Math.round(drag.start[n.id][1] + dy) } : n) });
      } else setDrag({ ...drag, x: p.x, y: p.y });
    };
    const up = (e: PointerEvent) => {
      if (drag.kind === 'wire') {
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const dot = el?.closest<HTMLElement>('[data-in]'), node = el?.closest<HTMLElement>('[data-node]');
        const w = wfRef.current;
        let target: [string, number] | null = null;
        if (dot) { const [id, i] = dot.dataset.in!.split(':'); if (DEF[w.nodes.find(n => n.id === id)!.type].inputs[+i].type === drag.type) target = [id, +i]; }
        else if (node) { const n = w.nodes.find(x => x.id === node.dataset.node)!; const i = DEF[n.type].inputs.findIndex((s, k) => s.type === drag.type && !w.links.some(l => l.to[0] === n.id && l.to[1] === k)); if (i >= 0 && n.id !== drag.from[0]) target = [n.id, i]; }
        if (target) connect(drag.from, target, drag.type);
        else if (!node) { const r = box.current!.getBoundingClientRect(), p = toWorld(e.clientX, e.clientY); setSearch({ cx: e.clientX - r.left, cy: e.clientY - r.top, wx: p.x, wy: p.y, type: drag.type, from: drag.from, q: '', i: 0 }); }
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag]); // eslint-disable-line react-hooks/exhaustive-deps

  function connect(from: [string, number], to: [string, number], type: SType) {
    const w = wfRef.current;
    onChange({ links: [...w.links.filter(l => !(l.to[0] === to[0] && l.to[1] === to[1])), { id: newLinkId(), from, to, type }] });
  }
  const setW = (n: GNode, name: string, value: string | number) => onChange({ nodes: wfRef.current.nodes.map(x => x.id === n.id ? { ...x, v: { ...x.v, [name]: value } } : x) });
  const addNode = (type: string, s: Search) => {
    const n = makeNode(type, s.wx, s.wy), w = wfRef.current;
    const nodes = [...w.nodes, n]; let links = w.links;
    if (s.from && s.type) { const i = DEF[type].inputs.findIndex(x => x.type === s.type); if (i >= 0) links = [...links, { id: newLinkId(), from: s.from, to: [n.id, i], type: s.type }]; }
    onChange({ nodes, links }); setSearch(null); setSel(n.id); onSelect?.(n.id);
  };

  const bgDown = (e: RPE) => {
    if ((e.target as HTMLElement).closest('.gn, .gx-search, .gx-mini, .gx-zoom, .gx-group > header')) return;
    setSearch(null); setSel(null); onSelect?.(null);
    setDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
  };
  const bgDbl = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.gn, .gx-search, .gx-mini, .gx-zoom')) return;
    const r = box.current!.getBoundingClientRect(), p = toWorld(e.clientX, e.clientY);
    setSearch({ cx: e.clientX - r.left, cy: e.clientY - r.top, wx: p.x, wy: p.y, q: '', i: 0 });
  };

  const linked = (id: string, i: number) => wf.links.find(l => l.to[0] === id && l.to[1] === i);
  const byId = (id: string) => wf.nodes.find(n => n.id === id)!;
  const active = (l: GLink) => st?.s[l.to[0]] === 'running' || st?.s[l.to[0]] === 'wait';
  const hits = search ? DEFS.filter(d => (!search.type || d.inputs.some(s => s.type === search.type)) && (`${d.title} ${d.type} ${d.cat}`.toLowerCase().includes(search.q.toLowerCase()))) : [];
  const b = bounds(), mw = 176, mh = 110, ms = Math.min(mw / (b.x1 - b.x0 + 200), mh / (b.y1 - b.y0 + 200));

  return <div className="gx" ref={box} onPointerDown={bgDown} onDoubleClick={bgDbl} data-dragging={drag?.kind}
    style={{ backgroundSize: `${24 * view.k}px ${24 * view.k}px, ${120 * view.k}px ${120 * view.k}px, ${120 * view.k}px ${120 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
    <div className="gx-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
      {wf.groups.map(g => <div key={g.id} className="gx-group" style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>
        <header onPointerDown={e => {
          e.stopPropagation(); const p = toWorld(e.clientX, e.clientY);
          const inside = wf.nodes.filter(n => n.x >= g.x && n.y >= g.y && n.x < g.x + g.w && n.y < g.y + g.h).map(n => n.id);
          setDrag({ kind: 'group', id: g.id, ox: p.x - g.x, oy: p.y - g.y, gx: g.x, gy: g.y, inside, start: Object.fromEntries(wf.nodes.map(n => [n.id, [n.x, n.y]])) });
        }}>{g.title}</header>
      </div>)}
      <svg className="gx-links" aria-hidden="true">
        {wf.links.map(l => { const a = byId(l.from[0]), z = byId(l.to[0]); if (!a || !z) return null;
          return <path key={l.id} d={curve(outPos(a, l.from[1]), inPos(z, l.to[1]))} stroke={TYPE_COLOR[l.type]} data-active={active(l) || undefined} />; })}
        {drag?.kind === 'wire' && <path className="is-temp" d={curve(outPos(byId(drag.from[0]), drag.from[1]), drag)} stroke={TYPE_COLOR[drag.type]} />}
      </svg>
      {wf.nodes.map(n => {
        const d = DEF[n.type], s = nodeSize(n, wf.links), state = st?.s[n.id], err = errors[n.id];
        const prog = st?.prog?.id === n.id ? st.prog : null;
        return <div key={n.id} className="gn" data-node={n.id} data-cat={d.cat} data-state={state} data-sel={sel === n.id || undefined} data-err={err ? true : undefined}
          style={{ left: n.x, top: n.y, width: s.w, height: s.h }} onPointerDown={() => { setSel(n.id); onSelect?.(n.id); }}>
          <header onPointerDown={e => { e.stopPropagation(); setSel(n.id); onSelect?.(n.id); const p = toWorld(e.clientX, e.clientY); setDrag({ kind: 'node', id: n.id, ox: p.x - n.x, oy: p.y - n.y }); }}>
            <i /><b>{n.title ?? d.title}</b><small>{CAT_CODE[d.cat]}</small>
            {d.write && <em>写入 · 需确认</em>}
            {state === 'cached' && <em className="is-cache">缓存</em>}
          </header>
          <div className="gn-slots" style={{ height: Math.max(d.inputs.length, d.outputs.length) * ROW }}>
            {d.inputs.map((x, i) => { const on = linked(n.id, i); return <span key={`i${i}`} className="gn-in" style={{ top: i * ROW }} data-opt={x.optional || undefined}>
              <i className="gn-dot" data-in={`${n.id}:${i}`} data-on={on ? true : undefined} style={{ ['--c' as string]: TYPE_COLOR[x.type] }}
                onPointerDown={e => { e.stopPropagation(); if (!on) return; onChange({ links: wf.links.filter(l => l !== on) }); const p = toWorld(e.clientX, e.clientY); setDrag({ kind: 'wire', from: on.from, type: on.type, x: p.x, y: p.y }); }} />{x.name}</span>; })}
            {d.outputs.map((x, i) => <span key={`o${i}`} className="gn-out" style={{ top: i * ROW }}>{x.name}
              <i className="gn-dot" data-on={wf.links.some(l => l.from[0] === n.id && l.from[1] === i) || undefined} style={{ ['--c' as string]: TYPE_COLOR[x.type] }}
                onPointerDown={e => { e.stopPropagation(); const p = toWorld(e.clientX, e.clientY); setDrag({ kind: 'wire', from: [n.id, i], type: x.type, x: p.x, y: p.y }); }} /></span>)}
          </div>
          {d.widgets.length > 0 && <div className="gn-widgets">{widgetRows(n, wf.links).map(({ w, linked: lk }) => <Widget key={w.name} w={w} value={n.v[w.name]} linked={lk} param={params.includes(`${n.id}.${w.name}`)}
            missing={!!w.model && !installed(String(n.v[w.name]))} onSet={v => setW(n, w.name, v)} />)}</div>}
          {n.type === 'KSampler' && <div className="gn-prog" data-on={prog ? true : undefined}><span style={{ width: prog ? `${prog.step / prog.steps * 100}%` : state === 'done' ? '100%' : 0 }} /><b>{prog ? `${prog.step} / ${prog.steps}` : state === 'done' ? '完成' : state === 'cached' ? '缓存' : '—'}</b></div>}
          {d.preview && <div className="gn-prev">{latest?.length ? latest.slice(0, 4).map(o => <Art key={o.id} seed={o.seed} w={o.w} h={o.h} theme={o.theme} />) : <span>排队运行后在这里预览</span>}</div>}
          {st?.notes[n.id] && <p className="gn-note">{st.notes[n.id]}</p>}
          {err && <p className="gn-err">{err}</p>}
        </div>;
      })}
    </div>

    {search && <div className="gx-search" style={{ left: Math.min(search.cx, size.w - 290), top: Math.min(search.cy, size.h - 300) }} onPointerDown={e => e.stopPropagation()}>
      <input autoFocus value={search.q} placeholder={search.type ? `能接 ${search.type} 的节点…` : '搜索节点，例如 采样 / LoRA / 档案'}
        onChange={e => setSearch({ ...search, q: e.target.value, i: 0 })}
        onKeyDown={e => { if (e.key === 'Escape') setSearch(null); if (e.key === 'ArrowDown') setSearch({ ...search, i: Math.min(hits.length - 1, search.i + 1) }); if (e.key === 'ArrowUp') setSearch({ ...search, i: Math.max(0, search.i - 1) }); if (e.key === 'Enter' && hits[search.i]) addNode(hits[search.i].type, search); }} />
      <ul>{hits.slice(0, 9).map((d, i) => <li key={d.type}><button aria-selected={i === search.i} onClick={() => addNode(d.type, search)} onMouseEnter={() => setSearch({ ...search, i })}>
        <b>{d.title}</b><small>{d.type}</small><em>{d.cat}</em></button></li>)}
        {!hits.length && <li className="is-none">没有匹配的节点</li>}</ul>
    </div>}

    <div className="gx-zoom" onPointerDown={e => e.stopPropagation()}>
      <button onClick={() => setView(v => ({ ...v, k: Math.max(.3, v.k / 1.15) }))} aria-label="缩小">−</button><b>{Math.round(view.k * 100)}%</b>
      <button onClick={() => setView(v => ({ ...v, k: Math.min(2, v.k * 1.15) }))} aria-label="放大">+</button><button onClick={fit}>适配</button>
    </div>
    <svg className="gx-mini" width={mw} height={mh} onPointerDown={e => {
      e.stopPropagation(); const r = (e.currentTarget as SVGElement).getBoundingClientRect();
      const wx = (e.clientX - r.left) / ms + b.x0 - 100, wy = (e.clientY - r.top) / ms + b.y0 - 100;
      setView(v => ({ ...v, x: size.w / 2 - wx * v.k, y: size.h / 2 - wy * v.k }));
    }}>
      {wf.nodes.map(n => { const s = nodeSize(n, wf.links); return <rect key={n.id} x={(n.x - b.x0 + 100) * ms} y={(n.y - b.y0 + 100) * ms} width={s.w * ms} height={s.h * ms} data-state={st?.s[n.id]} />; })}
      <rect className="gx-mini-view" x={(-view.x / view.k - b.x0 + 100) * ms} y={(-view.y / view.k - b.y0 + 100) * ms} width={size.w / view.k * ms} height={size.h / view.k * ms} />
    </svg>
  </div>;
}

/** 节点上的一行参数：下拉 / 数字（两侧箭头步进）/ 单行文本 / 多行文本。 */
function Widget({ w, value, linked, missing, param, onSet }: { w: WDef; value: string | number; linked: boolean; missing: boolean; param: boolean; onSet: (v: string | number) => void }) {
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  if (linked) return <div className="gw is-linked" data-param={param || undefined}><span>{w.label}</span><em>← 已由输入提供</em></div>;
  if (w.kind === 'text') return <div className="gw is-text" style={{ height: TEXT_H }} data-param={param || undefined}><textarea value={String(value)} placeholder={w.label} onChange={e => onSet(e.target.value)} onPointerDown={stop} /></div>;
  if (w.kind === 'string') return <div className="gw" data-param={param || undefined}><span>{w.label}</span><input value={String(value)} onChange={e => onSet(e.target.value)} onPointerDown={stop} /></div>;
  if (w.kind === 'combo') {
    const opts = w.options ?? [], i = opts.indexOf(String(value));
    return <div className="gw is-combo" data-missing={missing || undefined} data-param={param || undefined} onPointerDown={stop}>
      <button onClick={() => onSet(opts[(i - 1 + opts.length) % opts.length])} aria-label="上一个">◀</button>
      <span>{w.label}</span><b title={String(value)}>{missing && '未安装 · '}{String(value)}</b>
      <select value={String(value)} onChange={e => onSet(e.target.value)} aria-label={w.label}>{!opts.includes(String(value)) && <option value={String(value)}>{String(value)}</option>}{opts.map(o => <option key={o}>{o}</option>)}</select>
      <button onClick={() => onSet(opts[(i + 1) % opts.length])} aria-label="下一个">▶</button>
    </div>;
  }
  const step = w.step ?? 1, clamp = (v: number) => Math.max(w.min ?? -Infinity, Math.min(w.max ?? Infinity, +v.toFixed(3)));
  return <div className="gw is-num" data-param={param || undefined} onPointerDown={stop}>
    <button onClick={() => onSet(clamp(Number(value) - step))} aria-label="减">◀</button>
    <span>{w.label}</span><input type="number" value={value} step={step} onChange={e => onSet(clamp(Number(e.target.value)))} />
    <button onClick={() => onSet(clamp(Number(value) + step))} aria-label="加">▶</button>
  </div>;
}
