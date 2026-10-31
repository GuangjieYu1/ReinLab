import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ExplorePlan, Photo } from '../../../../../../packages/contracts/src/explore';
import type { ReviewApi } from '../adapter';
import { stopLabels } from '../overlays';

// 照片网格：按停留点 / 计划外 / 待确认分组；AI 标记和用户精选分开显示；落位依据小标签；多选批量改归属。

export const BASIS: Record<Photo['placement']['basis'], string> = { gps: 'GPS', event: '打卡', plan_time: '按时间推定', manual: '手动', unplanned: '计划外', pending: '待确认' };
const MARK = { recommend: '推荐', alternate: '备选' } as const;
const hm = (iso: string | null) => iso ? iso.slice(11, 16) : '时间待定';

export function PhotoTile({ p, api, selected, onToggle, onOpen, onPick }: {
  p: Photo; api: ReviewApi; selected?: boolean; onToggle?: () => void; onOpen: () => void; onPick?: (v: boolean) => void;
}) {
  return <figure className="exr-tile" data-sel={selected || undefined} data-status={p.status}>
    <button className="exr-tile-img" onClick={onOpen} title="打开">{p.status === 'ready' ? <img src={api.media(p.thumb)} alt={p.fileName} loading="lazy" /> : <span>{p.status === 'failed' ? `处理失败${p.error ? '：' + p.error : ''}` : '处理中…'}</span>}</button>
    {p.ai.mark && <span className="exr-mark" data-mark={p.ai.mark} title={p.ai.reason}>{MARK[p.ai.mark]}{p.ai.inspected === 'detail' ? ' · 细看过' : ''}</span>}
    {onPick && <button className="exr-star" aria-pressed={p.picked} title={p.picked ? '取消精选' : '精选'} onClick={() => onPick(!p.picked)}>{p.picked ? '★' : '☆'}</button>}
    <figcaption>
      {onToggle && <input type="checkbox" checked={!!selected} onChange={onToggle} aria-label={`选中 ${p.fileName}`} />}
      <span>{hm(p.time.corrected)}{p.time.trust === 'estimated' ? '≈' : ''}</span>
      <i data-basis={p.placement.basis}>{BASIS[p.placement.basis]}</i>
    </figcaption>
  </figure>;
}

export function Viewer({ photos, index, api, onClose, onIndex }: { photos: Photo[]; index: number; api: ReviewApi; onClose: () => void; onIndex: (i: number) => void }) {
  const p = photos[index];
  const [crop, setCrop] = useState<string | null>(null);
  useEffect(() => { setCrop(null); }, [index]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight' && index < photos.length - 1) onIndex(index + 1); if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [index, photos.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;
  const x = p.exif;
  // 点图片 → 取那一块的原图裁切细看（四分之一宽）
  const zoom = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), w = 0.25, h = 0.25;
    const cx = (e.clientX - r.left) / r.width, cy = (e.clientY - r.top) / r.height;
    setCrop(api.cropUrl(p.id, { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h }));
  };
  // 挂到 body：工作台外框有 transform，fixed 会被困在中栏里
  return createPortal(<div className="exr-viewer" role="dialog" aria-label={p.fileName} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="exr-viewer-box">
      <header><b>{p.fileName}</b><span>{index + 1} / {photos.length}</span><button className="rh-btn" onClick={onClose}>关闭</button></header>
      <div className="exr-viewer-img">
        {crop ? <img src={crop} alt="细节" onClick={() => setCrop(null)} title="点一下回到整张" /> : <img src={api.media(p.preview)} alt={p.fileName} onClick={zoom} title="点哪里就看哪里的细节" />}
        {index > 0 && <button className="exr-nav is-prev" onClick={() => onIndex(index - 1)}>‹</button>}
        {index < photos.length - 1 && <button className="exr-nav is-next" onClick={() => onIndex(index + 1)}>›</button>}
      </div>
      <footer>
        <span>{[x.body, x.lens].filter(Boolean).join(' + ') || '机身未知'} · {x.focalMm ? `${x.focalMm}mm` : '—'} · {x.aperture ? `f/${x.aperture}` : '—'} · {x.shutterS ? (x.shutterS >= 1 ? `${x.shutterS}s` : `1/${Math.round(1 / x.shutterS)}`) : '—'} · ISO {x.iso ?? '—'}</span>
        <span>相机记的 {x.dateTimeOriginal ?? '—'}{x.offset ? ` ${x.offset}` : ''} · 校正后 {p.time.corrected?.slice(0, 16).replace('T', ' ') ?? '待对时'}</span>
        {p.ai.mark && <span className="exr-mark-text">AI {MARK[p.ai.mark]}：{p.ai.reason ?? '没写理由'}</span>}
      </footer>
    </div>
  </div>, document.body);
}

export default function Photos({ api, plan, photos, focus, onChanged }: { api: ReviewApi; plan: ExplorePlan; photos: Photo[]; focus: string[] | null; onChanged: () => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'picked' | 'ai'>('all');
  const [view, setView] = useState<{ list: Photo[]; i: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const labels = stopLabels(plan);
  const shown = photos.filter(p => (!focus || focus.includes(p.id)) && (filter === 'all' || (filter === 'picked' ? p.picked : p.ai.mark === 'recommend')));
  const groups: { key: string; title: string; items: Photo[] }[] = [
    ...plan.stops.map(s => ({ key: s.id, title: `${labels[s.id]} · ${s.name}`, items: shown.filter(p => p.placement.stopId === s.id) })),
    { key: '~unplanned', title: '计划外', items: shown.filter(p => !p.placement.stopId && p.placement.basis !== 'pending') },
    { key: '~pending', title: '待确认（先对时）', items: shown.filter(p => !p.placement.stopId && p.placement.basis === 'pending') },
    { key: '~gone', title: '原停留点已不在计划里', items: shown.filter(p => p.placement.stopId && !plan.stops.some(s => s.id === p.placement.stopId)) },
  ].filter(g => g.items.length);
  const act = async (f: () => Promise<void>) => { setErr(null); try { await f(); setSel(new Set()); onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : '没有成功'); } };
  const toggle = (id: string) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...sel];

  return <div className="exr-photos">
    <div className="exr-row exr-photos-bar">
      <div className="ex-seg">{(['all', 'picked', 'ai'] as const).map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? `全部 ${photos.length}` : f === 'picked' ? `我的精选 ${photos.filter(p => p.picked).length}` : `AI 推荐 ${photos.filter(p => p.ai.mark === 'recommend').length}`}</button>)}</div>
      {focus && <span className="exr-chip">只看助手挑的 {focus.length} 张</span>}
      {ids.length > 0 && <>
        <b>已选 {ids.length}</b>
        <select value="" onChange={e => { const v = e.target.value; if (v) void act(() => api.assign(ids, v === '~' ? null : v)); }} aria-label="改归属">
          <option value="">归到…</option>{plan.stops.map(s => <option key={s.id} value={s.id}>{labels[s.id]} · {s.name}</option>)}<option value="~">计划外</option></select>
        <button className="rh-btn" onClick={() => void act(() => api.pick(ids, true))}>精选</button>
        <button className="rh-btn" onClick={() => void act(() => api.pick(ids, false))}>取消精选</button>
        <button className="rh-btn" onClick={() => { if (window.confirm(`删除这 ${ids.length} 张照片？原图会从 ReinLab 删除，不能恢复。`)) void act(async () => { for (const id of ids) await api.remove(id); }); }}>删除</button>
        <button className="dm-link" onClick={() => setSel(new Set())}>清除选择</button>
      </>}
    </div>
    {err && <p className="exr-warn">{err}</p>}
    {!groups.length && <p className="exr-hint">{photos.length ? '这个筛选下没有照片。' : '还没有照片。'}</p>}
    {groups.map(g => <section key={g.key} className="exr-photo-group">
      <h4>{g.title} <small>{g.items.length} 张</small>
        <button className="dm-link" onClick={() => setSel(s => new Set([...s, ...g.items.map(p => p.id)]))}>全选这组</button></h4>
      <div className="exr-grid">{g.items.map((p, i) => <PhotoTile key={p.id} p={p} api={api} selected={sel.has(p.id)} onToggle={() => toggle(p.id)}
        onOpen={() => setView({ list: g.items, i })} onPick={v => void act(() => api.pick([p.id], v))} />)}</div>
    </section>)}
    {view && <Viewer photos={view.list} index={view.i} api={api} onClose={() => setView(null)} onIndex={i => setView({ ...view, i })} />}
  </div>;
}
