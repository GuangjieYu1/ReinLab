import { useState } from 'react';
import type { Profile } from '../../../../../packages/contracts/src/explore';

// 地点经验（账户级资料，type: 'place'）：回顾时你确认过的"这个地方实际怎样"。下次规划时助手会读；可改、可删。
type Place = Extract<Profile, { type: 'place' }>;

export default function PlacesPanel({ items, onSave, onDelete }: {
  items: Place[];
  onSave: (p: Omit<Profile, 'id' | 'revision'> & { id?: string; revision?: number }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [edit, setEdit] = useState<{ p: Place; name: string; text: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (f: () => Promise<void>) => { try { await f(); setEdit(null); setMsg(null); } catch (e) { setMsg(e instanceof Error ? e.message : '没有成功'); } };
  if (!items.length) return <p className="dm-empty">还没有地点经验。回顾时让助手总结，你确认的才会存进来。</p>;
  return <div className="exl-prof">
    {items.map(p => edit?.p.id === p.id ? <div key={p.id} className="exl-prof-form">
      <label><span>地点</span><input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
      <label><span>经验</span><textarea rows={4} value={edit.text} onChange={e => setEdit({ ...edit, text: e.target.value })} /></label>
      <div className="exr-row"><button className="rh-btn is-solid" onClick={() => void run(() => onSave({ ...p, name: edit.name.trim() || p.name, text: edit.text } as never))}>保存</button><button className="dm-link" onClick={() => setEdit(null)}>取消</button></div>
    </div> : <div key={p.id} className="exl-prof-item">
      <b>{p.name}</b>
      <small>{[p.observedOn, p.season, p.timeOfDay, p.standpoint].filter(Boolean).join(' · ')}</small>
      <p>{p.text}</p>
      <small>依据：{[p.evidence.photoIds?.length && `${p.evidence.photoIds.length} 张照片`, p.evidence.eventIds?.length && `${p.evidence.eventIds.length} 条现场记录`].filter(Boolean).join('、') || '回顾'}</small>
      <div className="exr-row"><button className="dm-link" onClick={() => setEdit({ p, name: p.name, text: p.text })}>改</button>
        <button className="dm-link" onClick={() => { if (window.confirm(`删除「${p.name}」这条经验？`)) void run(() => onDelete(p.id)); }}>删</button></div>
    </div>)}
    {msg && <p className="dm-msg">{msg}</p>}
  </div>;
}
