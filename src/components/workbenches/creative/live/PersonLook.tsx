// MVP-2 人物形象（契约 §12.5）：外貌、画风、四格（立绘大、三视图小）、候选和当前版并排、只重出一格、历史、下载。
// 只显示服务端给的状态；不判断图好不好、不拼出图描述。
import { useEffect, useState } from 'react';
import type { Entity, PersonAsset, PersonAssetVersion, PersonView, AssetImage } from '../../../../../packages/contracts/src/creative';
import type { CreativeAdapter } from './adapter';

const VIEWS: PersonView[] = ['portrait', 'front', 'side', 'back'];
const VIEW_ZH: Record<PersonView, string> = { portrait: '立绘', front: '正面', side: '侧面', back: '背面' };
const STATE_ZH: Record<AssetImage['state'], string> = { queued: '排队', generating: '出图中', unsaved: '待保存', saved: '', failed: '失败' };

/** 服务端给的文件地址是 /v1/...，页面走 /backend 代理。 */
export const fileUrl = (u?: string | null) => !u ? '' : u.startsWith('/v1/') ? `/backend${u}` : u;

export type AssetEvent = { entityId: string; version: PersonAssetVersion; n: number };

function merge(a: PersonAsset, v: PersonAssetVersion): PersonAsset {
  const has = a.versions.some(x => x.id === v.id);
  return { ...a, versions: has ? a.versions.map(x => x.id === v.id ? v : x) : [v, ...a.versions] };
}
const busyOf = (v?: PersonAssetVersion | null) => !!v && Object.values(v.views).some(x => x && (x.state === 'queued' || x.state === 'generating'));
const okOf = (v: PersonAssetVersion) => Object.values(v.views).some(x => x?.state === 'saved');
const cost = (v: PersonAssetVersion) => v.cost?.known && v.cost.value != null ? `¥${v.cost.value.toFixed(2)}` : '花费未知';

/** 比当前版变了什么：只看服务端给的依据和 from，不看图。 */
function diffLine(v: PersonAssetVersion, cur: PersonAssetVersion | null, all: PersonAssetVersion[]): string {
  const from = v.from ? all.find(x => x.id === v.from) : null;
  if (from) {
    const redone = VIEWS.filter(k => v.views[k] && (!from.views[k]?.url || v.views[k]?.url !== from.views[k]?.url));
    if (redone.length && redone.length < VIEWS.length) return `只重出了${redone.map(k => VIEW_ZH[k]).join('、')}`;
  }
  if (!cur) return '第一版';
  const out: string[] = [];
  if (v.basis.look !== cur.basis.look) out.push('外貌改了');
  if ((v.basis.artStyle ?? '') !== (cur.basis.artStyle ?? '')) out.push('画风改了');
  if (v.basis.note) out.push(`备注：${v.basis.note}`);
  return out.join(' · ') || '设定没变，重出了一遍';
}

export function PersonLook({ entity, artStyle, adapter, readOnly, ev, onSaveLook, onSaveStyle }: {
  entity: Entity; artStyle: string | null | undefined; adapter: CreativeAdapter; readOnly: boolean; ev: AssetEvent | null;
  onSaveLook: (look: string) => Promise<void>; onSaveStyle: (style: string) => Promise<void>;
}) {
  const look = entity.person?.look ?? '';
  const [asset, setAsset] = useState<PersonAsset | null>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const [lookDraft, setLookDraft] = useState(look), [styleDraft, setStyleDraft] = useState(artStyle ?? ''), [editStyle, setEditStyle] = useState(false);
  const [note, setNote] = useState(''), [hist, setHist] = useState(false), [big, setBig] = useState<string | null>(null);
  useEffect(() => { setLookDraft(look); }, [entity.id, look]);
  useEffect(() => { setStyleDraft(artStyle ?? ''); }, [artStyle]);
  useEffect(() => {
    let off = false; setAsset(null); setErr(''); setHist(false);
    adapter.asset(entity.id).then(a => { if (!off) setAsset(a); }, e => { if (!off) setErr((e as Error).message); });
    return () => { off = true; };
  }, [adapter, entity.id]);
  useEffect(() => { if (ev && ev.entityId === entity.id) setAsset(a => a ? merge(a, ev.version) : a); }, [ev, entity.id]);
  // 选用变了：事件里没有 selectedVersionId，重取一次
  useEffect(() => { if (entity.person?.portrait?.url) adapter.asset(entity.id).then(setAsset, () => {}); }, [entity.person?.portrait?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (f: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const draw = (req: { views?: PersonView[]; note?: string; from?: string }) => run(async () => { const r = await adapter.drawAsset(entity.id, req); setAsset(r.asset ? merge(r.asset, r.version) : a => a); setNote(''); });
  const select = (vid: string | null) => run(async () => { await adapter.selectAsset(entity.id, vid); setAsset(await adapter.asset(entity.id)); });

  const vs = asset?.versions ?? [];
  const cur = vs.find(v => v.id === asset?.selectedVersionId) ?? null;
  const cand = vs[0] && vs[0].id !== cur?.id && (!cur || vs[0].n > cur.n) ? vs[0] : null;
  const older = vs.filter(v => v.id !== cur?.id && v.id !== cand?.id);
  const stale = (v: PersonAssetVersion) => v.basis.look !== look || (v.basis.artStyle ?? '') !== (artStyle ?? '');

  const cell = (v: PersonAssetVersion, k: PersonView) => {
    const x = v.views[k], from = v.from ? vs.find(o => o.id === v.from) : null;
    // 只重出某几格的新版：只给换了的格子描橙边
    const changed = !!from && v.id !== cur?.id && !!x && x.url !== from.views[k]?.url;
    return <figure key={k} className="pl-cell" data-view={k} data-state={x?.state ?? 'none'} data-changed={changed || undefined}>
      {x?.state === 'saved' && x.url ? <img src={fileUrl(x.url)} alt={`${entity.name} · ${VIEW_ZH[k]}`} onClick={() => setBig(fileUrl(x.url))} />
        : <div className="pl-ph">{x ? <>{(x.state === 'queued' || x.state === 'generating') && <i className="pl-spin" />}<b>{STATE_ZH[x.state]}</b>{x.failure && <small title={x.failure}>{x.failure}</small>}</> : <b>—</b>}</div>}
      <figcaption>{VIEW_ZH[k]}
        {!readOnly && x?.state === 'unsaved' && <button className="cw-link" disabled={busy} onClick={() => run(() => adapter.assetVersion(entity.id, v.id, 'retry'))}>重试取回</button>}
        {!readOnly && (x?.state === 'saved' || x?.state === 'failed') && look && <button className="cw-link" disabled={busy} title="只重出这一格：按这一版出新版本，其余格沿用" onClick={() => draw({ views: [k], from: v.id })}>重出</button>}
        {x?.state === 'saved' && x.url && <a className="cw-link" href={`${fileUrl(x.url)}?download=1`} download>下载</a>}
      </figcaption>
    </figure>;
  };
  const grid = (v: PersonAssetVersion, title: React.ReactNode, acts?: React.ReactNode) => <section className="pl-ver" data-busy={busyOf(v) || undefined}>
    <header><b>{title}</b><small>第 {v.n} 版 · {v.model} · {cost(v)}</small>{acts}</header>
    {stale(v) && okOf(v) && <p className="pl-stale">外貌{v.basis.look !== look ? '' : '（画风）'}已改，这版是旧的</p>}
    <div className="pl-grid">{VIEWS.map(k => cell(v, k))}</div>
  </section>;

  return <section className="pl" aria-label="人物形象">
    <span className="rh-micro">外貌 · 出图只按它画</span>
    {readOnly ? <p>{look || '还没写外貌'}</p> : <div className="pl-look">
      <textarea value={lookDraft} onChange={e => setLookDraft(e.target.value)} rows={3} placeholder="年龄、身形、脸、发型、衣着、随身物、神态……" />
      {lookDraft !== look && <button className="rh-btn is-solid" disabled={busy} onClick={() => run(() => onSaveLook(lookDraft.trim()))}>保存外貌</button>}
    </div>}
    <p className="pl-style"><span className="rh-micro">画风 · 整个世界观共用</span>
      {editStyle && !readOnly ? <span className="cw-row"><input value={styleDraft} onChange={e => setStyleDraft(e.target.value)} placeholder="比如：明清工笔淡彩" />
        <button className="rh-btn" disabled={busy} onClick={() => run(async () => { await onSaveStyle(styleDraft.trim()); setEditStyle(false); })}>保存</button></span>
        : <>{artStyle || '还没定画风'}{!readOnly && <button className="cw-link" onClick={() => setEditStyle(true)}>改</button>}</>}</p>

    <span className="rh-micro">形象{asset ? ` · ${vs.length} 版` : ''}</span>
    {err && <p role="alert" className="cw-warn">{err}</p>}
    {!asset && !err && <p className="cw-muted">正在取形象…</p>}
    {cand && grid(cand, <>新版 · {diffLine(cand, cur, vs)}</>, !readOnly && <span className="pl-acts">
      {busyOf(cand) && <button className="rh-btn" disabled={busy} onClick={() => run(() => adapter.assetVersion(entity.id, cand.id, 'stop'))}>停下没开始的</button>}
      {okOf(cand) && !busyOf(cand) && <button className="rh-btn is-solid" disabled={busy} onClick={() => select(cand.id)}>用这一版</button>}</span>)}
    {cur ? grid(cur, '当前选用', !readOnly && <span className="pl-acts"><button className="cw-link" disabled={busy} onClick={() => select(null)}>取消选用</button></span>)
      : asset && !cand && <p className="cw-muted">还没出过形象。</p>}
    {!readOnly && <div className="cw-row pl-draw">
      {look ? <><input value={note} onChange={e => setNote(e.target.value)} placeholder="这次的备注（可空）：比如「神情更落寞」" />
        <button className="rh-btn is-solid" disabled={busy || busyOf(cand)} onClick={() => draw({ note: note.trim() || undefined })}>{vs.length ? '再出一版' : '出形象'}</button></>
        : <p className="cw-muted">先写外貌，才能出形象。</p>}
    </div>}
    {older.length > 0 && <><button className="cw-link" onClick={() => setHist(h => !h)}>{hist ? '收起' : '展开'}历史版本（{older.length}）</button>
      {hist && older.map(v => grid(v, okOf(v) ? '历史' : '历史 · 没出成', !readOnly && okOf(v) && !busyOf(v) && <span className="pl-acts"><button className="rh-btn" disabled={busy} onClick={() => select(v.id)}>用这一版</button></span>))}</>}
    {big && <div className="pl-big" role="dialog" onClick={() => setBig(null)}><img src={big} alt="" /></div>}
  </section>;
}
