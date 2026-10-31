import { useEffect, useState } from 'react';
import type { Photo } from '../../../../../../packages/contracts/src/explore';
import type { ReviewApi } from '../adapter';
import { PhotoTile, Viewer } from './Photos';

// 对话里的照片条：助手挑出来的几张（缩略图 + AI 标记 + 理由），点开看细节，或跳到回顾面看这一组。
const cache = new WeakMap<ReviewApi, Promise<Photo[]>>();
async function allPhotos(api: ReviewApi) {
  const out: Photo[] = []; let cursor: string | undefined;
  do { const r = await api.photos(cursor ? { cursor } : {}); out.push(...r.items); cursor = r.cursor ?? undefined; } while (cursor);
  return out;
}

export default function ChatPhotos({ api, ids, onOpen }: { api: ReviewApi; ids: string[]; onOpen: () => void }) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [view, setView] = useState<number | null>(null);
  useEffect(() => {
    let p = cache.get(api);
    if (!p) { p = allPhotos(api); cache.set(api, p); window.setTimeout(() => cache.delete(api), 30000); }
    p.then(all => setPhotos(ids.map(id => all.find(x => x.id === id)).filter((x): x is Photo => !!x)), () => setPhotos([]));
  }, [api, ids.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!photos) return <small className="exr-hint">正在取照片…</small>;
  return <div className="exr-exp">
    <div className="exr-chatstrip">{photos.slice(0, 6).map((p, i) => <PhotoTile key={p.id} p={p} api={api} onOpen={() => setView(i)} />)}</div>
    {photos.slice(0, 3).filter(p => p.ai.reason).map(p => <small key={p.id} className="exr-hint">{p.fileName}：{p.ai.reason}</small>)}
    {photos.length < ids.length && <small className="exr-hint">{ids.length - photos.length} 张已经不在了</small>}
    <button className="dm-link" onClick={onOpen}>在回顾里看这 {ids.length} 张 →</button>
    {view !== null && <Viewer photos={photos} index={view} api={api} onClose={() => setView(null)} onIndex={setView} />}
  </div>;
}
