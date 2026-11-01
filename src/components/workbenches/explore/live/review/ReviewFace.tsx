import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraGroup, Comparison, ExplorePlan, FieldEventRecord, Photo, Travelogue } from '../../../../../../packages/contracts/src/explore';
import { ExploreError, type ActualItem, type ExploreAdapter } from '../adapter';
import { stopLabels } from '../overlays';
import { dateToLocal, hm } from '../sunlive';
import { RichBlocks } from '../../../richText';
import Upload from './Upload';
import Clock from './Clock';
import Photos, { BASIS } from './Photos';
import './review.css';

// 回顾面（09-explore-v2.md 第 6 节；10-explore-v2-contract.md 第 4.2 节）：
// 上传 → 对时 → 照片 → 实际时间线 → 计划 vs 实际 → 游记。挑片、对照、游记、经验都在右边对话里发起。

export type ReviewFocus = { part: 'comparison' | 'travelogue' | 'photos'; photoIds?: string[]; n: number } | null;

export default function ReviewFace({ adapter, plan, day, tz, dossierId, focus }: {
  adapter: ExploreAdapter; plan: ExplorePlan; day: string; tz: string; dossierId: string; focus: ReviewFocus;
}) {
  const api = adapter.review;
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [groups, setGroups] = useState<CameraGroup[]>([]);
  const [events, setEvents] = useState<FieldEventRecord[]>([]);
  const [actual, setActual] = useState<ActualItem[]>([]);
  const [review, setReview] = useState<{ comparison: Comparison | null; travelogue: Travelogue | null }>({ comparison: null, travelogue: null });
  const [storage, setStorage] = useState<{ dossierBytes: number; freeBytes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [photoFocus, setPhotoFocus] = useState<string[] | null>(null);
  const refs = { photos: useRef<HTMLElement>(null), comparison: useRef<HTMLElement>(null), travelogue: useRef<HTMLElement>(null) };
  const body = useRef<HTMLDivElement>(null);
  // 在回顾面自己的滚动区里定位到某一块
  const goTo = (el: HTMLElement | null) => { const b = body.current; if (b && el) b.scrollTo({ top: el.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop - 8, behavior: 'smooth' }); };

  const loadPhotos = useCallback(async () => {
    const all: Photo[] = []; let cursor: string | undefined;
    do { const r = await api.photos(cursor ? { cursor } : {}); all.push(...r.items); cursor = r.cursor ?? undefined; } while (cursor);
    setPhotos(all);
  }, [api]);
  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : '读不到');
  const loadClock = useCallback(() => api.clock().then(setGroups, fail), [api]);
  const loadActual = useCallback(() => api.actual().then(setActual, fail), [api]);
  const loadReview = useCallback(() => api.get().then(setReview, fail), [api]);
  const loadAll = useCallback(() => {
    void loadPhotos().catch(fail); void loadClock(); void loadActual(); void loadReview();
    adapter.fieldEvents().then(setEvents, () => {}); api.storage().then(setStorage, () => {});
  }, [adapter, api, loadPhotos, loadClock, loadActual, loadReview]);

  useEffect(() => {
    loadAll();
    // 处理进度、对时、回顾成果都由服务端推；进度事件频繁，合并一下再取
    let t = 0;
    const later = (f: () => void) => { window.clearTimeout(t); t = window.setTimeout(f, 800); };
    const off = adapter.subscribe(ev => {
      if (ev.type === 'explore.photos') later(() => { void loadPhotos().catch(() => {}); void loadClock(); void loadActual(); api.storage().then(setStorage, () => {}); });
      else if (ev.type === 'explore.clock') { void loadClock(); void loadPhotos().catch(() => {}); void loadActual(); }
      else if (ev.type === 'explore.review') { if (ev.part === 'picks') void loadPhotos().catch(() => {}); else void loadReview(); }
      else if (ev.type === 'explore.field') { adapter.fieldEvents().then(setEvents, () => {}); void loadActual(); }
    });
    return () => { off(); window.clearTimeout(t); };
  }, [adapter]); // eslint-disable-line react-hooks/exhaustive-deps

  // 对话里点了"打开对照 / 游记 / 这几张照片"
  useEffect(() => {
    if (!focus) return;
    if (focus.part === 'photos') setPhotoFocus(focus.photoIds ?? null);
    else void loadReview();
    window.setTimeout(() => goTo(refs[focus.part].current), 50);
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = () => { void loadPhotos().catch(fail); void loadClock(); void loadActual(); };
  const pending = photos.filter(p => p.status === 'uploading' || p.status === 'processing').length;
  // 整组都没有拍摄时间的对不了时，不算"没对上"
  const timed = (g: CameraGroup) => photos.some(p => p.cameraGroupId === g.id && (p.exif.dateTimeOriginal || p.exif.gpsTime));
  const needClock = groups.filter(g => (g.status === 'needs_anchor' || g.status === 'inconsistent') && timed(g)).length;

  return <div className="ex-center exr">
    <header className="exr-head">
      <b>回顾 · {plan.destination?.name ?? '这次'}</b>
      <span>{photos.length} 张照片{pending ? ` · ${pending} 张处理中` : ''}</span>
      {needClock > 0 && <span className="exr-chip" data-status="needs_anchor">{needClock} 台相机还没对上时间</span>}
      {storage && <span>占用 {(storage.dossierBytes / 1e9).toFixed(2)} GB · 剩 {(storage.freeBytes / 1e9).toFixed(1)} GB</span>}
      <span className="exr-hint">挑片、对照、写游记、记经验：在右边对话里说</span>
    </header>
    {err && <p className="exr-warn">{err}</p>}
    <div className="exr-body" ref={body}>
      <section><h3>上传原图</h3><Upload api={api} dossierId={dossierId} onUploaded={() => { void loadPhotos().catch(() => {}); void loadClock(); void loadActual(); api.storage().then(setStorage, () => {}); }} /></section>
      <section><h3>对时</h3><Clock api={api} groups={groups} photos={photos} events={events} tz={tz} onChanged={changed} /></section>
      <section ref={refs.photos} className="is-wide"><h3>照片{photoFocus && <button className="dm-link" onClick={() => setPhotoFocus(null)}>看全部</button>}</h3>
        <Photos api={api} plan={plan} photos={photos} focus={photoFocus} onChanged={changed} /></section>
      <section className="is-wide"><h3>实际时间线</h3><ActualTrack plan={plan} items={actual} day={day} tz={tz} /></section>
      <section ref={refs.comparison} className="is-wide"><h3>计划 vs 实际</h3>
        {review.comparison ? <ComparisonView c={review.comparison} plan={plan} day={day} tz={tz} onPhotos={ids => { setPhotoFocus(ids); goTo(refs.photos.current); }} />
          : <p className="exr-hint">还没有对照。在对话里说"对照一下计划和实际"。</p>}</section>
      <section ref={refs.travelogue} className="is-wide"><h3>游记</h3>
        {review.travelogue ? <TravelogueEditor t={review.travelogue} adapter={adapter} photos={photos} onSaved={t => setReview(r => ({ ...r, travelogue: t }))} onReload={loadReview} />
          : <p className="exr-hint">还没有游记。在对话里说"帮我写游记"，写好会出现在这里，可以改、可以导出。</p>}</section>
    </div>
  </div>;
}

/** 实际时间线：计划一轨、实际一轨（打卡、照片簇、笔记）；推定的用虚线。 */
function ActualTrack({ plan, items: all, day, tz }: { plan: ExplorePlan; items: ActualItem[]; day: string; tz: string }) {
  const labels = stopLabels(plan);
  const mins = (iso: string) => dateToLocal(iso, day, tz);
  // 只画拍摄日当天的；别的日子的记录（比如出发前的试用）单独说一句
  const onDay = (iso: string) => { const m = mins(iso); return m >= 0 && m < 1440; };
  const items = all.filter(i => i.type === 'event' ? onDay(i.record.at) : onDay(i.start) || onDay(i.end));
  const other = all.length - items.length;
  const planned = plan.stops.filter(s => s.window && (!s.day || s.day === day));
  const ts = [...planned.flatMap(s => [mins(s.window!.start), mins(s.window!.end)]),
    ...items.flatMap(i => i.type === 'event' ? [mins(i.record.at)] : [mins(i.start), mins(i.end)])];
  if (!ts.length) return <p className="exr-hint">还没有打卡和对上时间的照片。{other ? `另有 ${other} 条不在 ${day} 这一天。` : ''}</p>;
  const lo = Math.floor((Math.min(...ts) - 30) / 60) * 60, hi = Math.ceil((Math.max(...ts) + 30) / 60) * 60;
  const x = (m: number) => `${((m - lo) / (hi - lo)) * 100}%`, w = (a: number, b: number) => `${Math.max(0.6, ((b - a) / (hi - lo)) * 100)}%`;
  const hours = Array.from({ length: (hi - lo) / 60 + 1 }, (_, i) => lo + i * 60);
  return <div className="exr-track">
    <div className="exr-axis">{hours.map(h => <span key={h} style={{ left: x(h) }}>{hm(h)}</span>)}</div>
    <div className="exr-lane"><em>计划</em>{planned.map(s => { const a = mins(s.window!.start), b = mins(s.window!.end);
      return <i key={s.id} className="is-plan" style={{ left: x(a), width: w(a, b) }} title={`${labels[s.id]} ${s.name} ${hm(a)}–${hm(b)}`}>{labels[s.id]}</i>; })}</div>
    <div className="exr-lane"><em>实际</em>{items.map((it, k) => {
      if (it.type === 'event') { const a = mins(it.record.at), kind = it.record.kind;
        return <b key={k} className="exr-ev" data-kind={kind} style={{ left: x(a) }} title={`${hm(a)} ${kind === 'arrived' ? '到了' : kind === 'shot' ? '拍到了' : kind === 'note' ? '笔记' : kind === 'situation' ? '情况变了' : '更正'} · ${it.record.stopName ?? '行程外'}${it.record.effectiveText ? '：' + it.record.effectiveText : ''}`} />; }
      const a = mins(it.start), b = mins(it.end);
      return <i key={k} className="is-actual" data-estimated={it.basis === 'plan_time' || it.basis === 'pending' || undefined} style={{ left: x(a), width: w(a, b) }}
        title={`${it.stopId ? labels[it.stopId] ?? '已删的点' : '计划外'} · ${it.photoIds.length} 张 · ${hm(a)}–${hm(b)} · ${BASIS[it.basis]}`}>{it.photoIds.length}</i>;
    })}</div>
    <p className="exr-hint">竖线是打卡和笔记；色块是照片簇（数字是张数），虚线框是按时间推定的。{other ? ` 另有 ${other} 条不在 ${day} 这一天，没画。` : ''}</p>
  </div>;
}

const EVIDENCE = { shot: '拍到了', arrived_only: '到了，没找到照片', none_found: '没找到记录（不代表没去）' } as const;
function ComparisonView({ c, plan, day, tz, onPhotos }: { c: Comparison; plan: ExplorePlan; day: string; tz: string; onPhotos: (ids: string[]) => void }) {
  const labels = stopLabels(plan);
  const t = (iso: string | null) => iso ? hm(dateToLocal(iso, day, tz)) : '—';
  return <div className="exr-compare">
    <table><thead><tr><th>点</th><th>计划</th><th>实际</th><th>差</th><th>结果</th><th>光</th><th>笔记</th><th>照片</th></tr></thead>
      <tbody>{c.items.map(i => <tr key={i.stopId} data-evidence={i.evidence}>
        <td><b>{labels[i.stopId] ?? '·'}</b> {i.stopName}</td><td>{t(i.plannedStart)}</td><td>{t(i.actualStart)}</td>
        <td>{i.lateMin === null ? (i.actualStart ? '时间没对准' : '—') : i.lateMin === 0 ? '准时' : i.lateMin > 0 ? `晚 ${i.lateMin} 分` : `早 ${-i.lateMin} 分`}</td>
        <td>{EVIDENCE[i.evidence]}</td><td>{i.light ?? '—'}</td><td>{i.notes.join('；') || '—'}</td>
        <td>{i.photoIds.length ? <button className="dm-link" onClick={() => onPhotos(i.photoIds)}>{i.photoIds.length} 张</button> : '—'}</td>
      </tr>)}</tbody></table>
    <p className="exr-hint">按第 {c.revisionUsed} 版计划对照{c.unplannedPhotoIds.length ? ' · ' : ''}{c.unplannedPhotoIds.length > 0 && <button className="dm-link" onClick={() => onPhotos(c.unplannedPhotoIds)}>计划外 {c.unplannedPhotoIds.length} 张</button>}</p>
  </div>;
}

function TravelogueEditor({ t, adapter, photos, onSaved, onReload }: { t: Travelogue; adapter: ExploreAdapter; photos: Photo[]; onSaved: (t: Travelogue) => void; onReload: () => void }) {
  const [text, setText] = useState(t.markdown);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = text !== t.markdown;
  useEffect(() => { if (!dirty) setText(t.markdown); }, [t.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setSaving(true); setMsg(null);
    try { onSaved(await adapter.review.saveTravelogue(t.revision, text)); setMsg('已保存'); setMode('read'); }
    catch (e) {
      if (e instanceof ExploreError && e.code === 'REVISION_CONFLICT') { setMsg('游记刚被助手或另一台设备改过。你的修改还在编辑框里；已载入最新版的对照，确认后再存。'); onReload(); }
      else setMsg(e instanceof Error ? e.message : '没存上');
    } finally { setSaving(false); }
  };
  const pics = t.photoIds.map(id => photos.find(p => p.id === id)).filter((p): p is Photo => !!p);
  return <div className="exr-travel">
    <div className="exr-row">
      <div className="ex-seg"><button aria-pressed={mode === 'read'} onClick={() => setMode('read')}>看</button><button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>改</button></div>
      {dirty && <button className="rh-btn is-solid" disabled={saving} onClick={() => void save()}>{saving ? '正在存…' : '保存'}</button>}
      {dirty && <button className="dm-link" onClick={() => setText(t.markdown)}>放弃修改</button>}
      <a className="rh-btn" href={adapter.review.exportUrl('md')} download="游记.md">导出 Markdown</a>
      <a className="rh-btn" href={adapter.review.exportUrl('html')} download="游记.html">导出网页</a>
      <small className="exr-hint">第 {t.revision} 版 · {new Date(t.updatedAt).toLocaleString('zh-CN', { hour12: false })}</small>
    </div>
    {msg && <p className={msg === '已保存' ? 'exr-hint' : 'exr-warn'}>{msg}</p>}
    {mode === 'edit' ? <textarea value={text} onChange={e => setText(e.target.value)} rows={16} aria-label="游记正文" />
      : <article className="exr-article"><RichBlocks text={text} /></article>}
    {pics.length > 0 && <div className="exr-strip">{pics.map(p => <img key={p.id} src={adapter.review.media(p.thumb)} alt={p.fileName} title={p.fileName} />)}</div>}
    {t.sources.length > 0 && <p className="exr-hint">来源：{t.sources.map(s => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.name}</a>)}</p>}
  </div>;
}
