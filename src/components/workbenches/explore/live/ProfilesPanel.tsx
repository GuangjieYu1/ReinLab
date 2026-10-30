import { useState } from 'react';
import type { ExplorePlan, Profile } from '../../../../../packages/contracts/src/explore';

// 账户级资料：模特、器材。跨计划共用；计划里保存选中时的快照（资料再改，旧计划不跟着变）。

type Draft = { type: 'model'; name: string; height: string; style: string; experience: string; wardrobe: string }
  | { type: 'gear'; name: string; kind: 'body' | 'lens'; focal: string; aperture: string };

const blank = (type: 'model' | 'gear'): Draft => type === 'model'
  ? { type, name: '', height: '', style: '', experience: '', wardrobe: '' } : { type, name: '', kind: 'lens', focal: '', aperture: '' };

const toDraft = (p: Profile): Draft => p.type === 'model'
  ? { type: 'model', name: p.name, height: p.height ? String(p.height) : '', style: p.style ?? '', experience: p.experience ?? '', wardrobe: p.wardrobe ?? '' }
  : { type: 'gear', name: p.name, kind: p.kind, focal: p.focal ? (p.focal[0] === p.focal[1] ? String(p.focal[0]) : `${p.focal[0]}-${p.focal[1]}`) : '', aperture: p.aperture ? String(p.aperture) : '' };

function fromDraft(d: Draft): Omit<Profile, 'id' | 'revision'> {
  if (d.type === 'model') return { type: 'model', name: d.name.trim(), ...(d.height ? { height: Number(d.height) } : {}), ...(d.style ? { style: d.style } : {}), ...(d.experience ? { experience: d.experience } : {}), ...(d.wardrobe ? { wardrobe: d.wardrobe } : {}) } as never;
  const f = d.focal.split(/[-–~]/).map(Number).filter(n => n > 0);
  return { type: 'gear', name: d.name.trim(), kind: d.kind, ...(f.length ? { focal: [f[0], f[1] ?? f[0]] } : {}), ...(d.aperture ? { aperture: Number(d.aperture) } : {}) } as never;
}

export default function ProfilesPanel({ type, items, plan, onSave, onDelete, onToggle, onRefresh }: {
  type: 'model' | 'gear'; items: Profile[]; plan: ExplorePlan;
  onSave: (p: Omit<Profile, 'id' | 'revision'> & { id?: string; revision?: number }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, on: boolean) => void;
  onRefresh: (id: string) => void;
}) {
  const [edit, setEdit] = useState<{ id?: string; revision?: number; d: Draft } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const picked = (type === 'model' ? plan.people : plan.gear);
  const save = async () => {
    if (!edit || !edit.d.name.trim()) { setMsg('名称不能空'); return; }
    try { await onSave({ ...fromDraft(edit.d), ...(edit.id ? { id: edit.id, revision: edit.revision } : {}) }); setEdit(null); setMsg(null); }
    catch (e) { setMsg(e instanceof Error ? e.message : '没保存成功'); }
  };
  const field = (k: string, label: string, ph = '') => <label><span>{label}</span><input value={(edit!.d as Record<string, string>)[k]} placeholder={ph} onChange={e => setEdit(x => x && { ...x, d: { ...x.d, [k]: e.target.value } as Draft })} /></label>;

  return <div className="exl-prof">
    {items.length === 0 && !edit && <p className="dm-empty">{type === 'model' ? '还没有存模特。常合作的人存下来，下次排计划直接选。' : '还没有存器材。存下机身和镜头，助手只推荐你有的焦段。'}</p>}
    {items.map(p => {
      const snap = picked.find(x => x.profileId === p.id);
      return <div key={p.id} className="exl-prof-row" data-on={!!snap || undefined}>
        <label className="exl-prof-pick"><input type="checkbox" checked={!!snap} onChange={e => onToggle(p.id, e.target.checked)} /><span title="用在这份计划">计划</span></label>
        <div><b>{p.name}</b><small>{p.type === 'model' ? [p.height && `${p.height}cm`, p.style, p.experience].filter(Boolean).join(' · ') : [p.kind === 'body' ? '机身' : '镜头', p.focal && `${p.focal[0]}${p.focal[1] !== p.focal[0] ? `–${p.focal[1]}` : ''}mm`, p.aperture && `f/${p.aperture}`].filter(Boolean).join(' · ')}</small>
          {snap && snap.revision < p.revision && <button className="dm-link" onClick={() => onRefresh(p.id)}>资料有新修订，点这里用最新的</button>}</div>
        <button className="dm-link" onClick={() => setEdit({ id: p.id, revision: p.revision, d: toDraft(p) })}>改</button>
        <button className="dm-link dm-danger" onClick={() => { if (window.confirm(`删除「${p.name}」？旧计划里的快照会保留。`)) void onDelete(p.id).catch(e => setMsg(e instanceof Error ? e.message : '没删成功')); }}>删</button>
      </div>;
    })}
    {/* 计划里引用了、但资料已删除的：只剩快照 */}
    {picked.filter(s => !items.some(p => p.id === s.profileId)).map(s => <div key={s.profileId} className="exl-prof-row" data-gone><div><b>{s.data.name}</b><small>资料已删除 · 这份计划保留当时的快照</small></div></div>)}
    {edit ? <form className="exl-prof-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      {edit.d.type === 'model' ? <>{field('name', '称呼')}{field('height', '身高 cm')}{field('style', '风格')}{field('experience', '经验', '比如：第一次外拍')}{field('wardrobe', '衣橱要点')}</>
        : <>{field('name', '名称', '比如：Sony A7C2 / 35mm f/1.4')}<label><span>类型</span><select value={edit.d.kind} onChange={e => setEdit(x => x && { ...x, d: { ...x.d, kind: e.target.value } as Draft })}><option value="lens">镜头</option><option value="body">机身</option></select></label>{field('focal', '焦段', '35 或 24-70')}{field('aperture', '最大光圈', '1.4')}</>}
      <div><button className="rh-btn is-solid">保存</button><button type="button" className="rh-btn" onClick={() => setEdit(null)}>取消</button></div>
    </form> : <button className="dm-add" onClick={() => setEdit({ d: blank(type) })}>＋ 新增{type === 'model' ? '模特' : '器材'}</button>}
    {msg && <p className="dm-msg">{msg}</p>}
  </div>;
}
