import { useState } from 'react';
import type { CameraGroup, FieldEventRecord, Photo } from '../../../../../../packages/contracts/src/explore';
import type { ReviewApi } from '../adapter';

// 对时面板：每个相机组一行；需要锚点 / 前后不一致时给建议锚点，用户确认或另选；显示校正前后时间。

const STATUS: Record<CameraGroup['status'], string> = { auto: '自动对上了', needs_anchor: '需要一个参照', inconsistent: '前后对不上', confirmed: '已确认' };
export function offsetText(sec: number | null) {
  if (sec === null) return '偏差未知';
  const a = Math.abs(sec), h = Math.floor(a / 3600), m = Math.floor(a % 3600 / 60), s = a % 60;
  const t = [h && `${h} 小时`, m && `${m} 分`, (s || (!h && !m)) && `${s} 秒`].filter(Boolean).join(' ');
  return sec === 0 ? '相机时间是准的' : sec > 0 ? `相机慢了 ${t}` : `相机快了 ${t}`;
}
/** EXIF 原文 "2026:11:03 09:12:00" → "09:12"；加偏差后的时刻 */
const exifHm = (raw: string | null, add = 0) => {
  if (!raw) return '—';
  const m = /(\d+):(\d+):(\d+)$/.exec(raw); if (!m) return raw;
  const t = ((+m[1] * 3600 + +m[2] * 60 + +m[3] + add) % 86400 + 86400) % 86400;
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}`;
};
const evHm = (at: string) => at.slice(11, 16);

export default function Clock({ api, groups, photos, events, tz, onChanged }: {
  api: ReviewApi; groups: CameraGroup[]; photos: Photo[]; events: FieldEventRecord[]; tz: string; onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [pick, setPick] = useState<{ photoId: string; eventClientId: string }>({ photoId: '', eventClientId: '' });
  const act = async (id: string, f: () => Promise<void>) => { setBusy(id); setErr(null); try { await f(); onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : '没有成功'); } finally { setBusy(null); } };
  if (!groups.length) return <p className="exr-hint">还没有照片。传完后按相机分组对时。</p>;
  const anchorable = events.filter(e => e.status === 'ok' && (e.kind === 'arrived' || e.kind === 'shot'));

  return <div className="exr-clock">
    {groups.map(g => {
      const mine = photos.filter(p => p.cameraGroupId === g.id);
      const sample = mine[0];
      const sug = g.suggestion, sugPhoto = sug && photos.find(p => p.id === sug.photoId), sugEvent = sug && events.find(e => e.clientId === sug.eventClientId);
      return <div key={g.id} className="exr-group" data-status={g.status}>
        <div className="exr-group-head">
          <b>{g.label}</b><span>{g.photos} 张</span><span className="exr-chip" data-status={g.status}>{STATUS[g.status]}</span>
          <span>{offsetText(g.offsetSec)}{g.residualSec !== null && g.offsetSec !== null ? `（误差约 ${Math.abs(g.residualSec)} 秒）` : ''}</span>
          <span>{g.timezone ? `时区 ${g.timezone}${g.timezoneBasis === 'offset_tag' ? '（照片自带）' : g.timezoneBasis === 'plan' ? '（按计划所在地）' : g.timezoneBasis === 'user' ? '（你定的）' : ''}` : '时区未知'}</span>
        </div>
        {sample && g.offsetSec !== null && <p className="exr-hint">例：{sample.fileName} 相机记的 {exifHm(sample.exif.dateTimeOriginal)} → 校正后 {exifHm(sample.exif.dateTimeOriginal, g.offsetSec)}</p>}
        {g.anchors.length > 0 && <ul className="exr-anchors">{g.anchors.map(a => {
          const p = photos.find(x => x.id === a.photoId), e = events.find(x => x.clientId === a.eventClientId);
          return <li key={a.photoId}>{p?.fileName ?? a.photoId} = {e ? `${evHm(e.at)} ${e.kind === 'arrived' ? '到了' : '拍到了'} · ${e.stopName ?? '行程外'}` : a.time ?? '—'}（{offsetText(a.deltaSec)}）</li>;
        })}</ul>}
        {(g.status === 'needs_anchor' || g.status === 'inconsistent') && <div className="exr-suggest">
          {sug && sugPhoto && sugEvent && g.anchors.length === 0 && <div className="exr-sug">
            <img src={api.media(sugPhoto.thumb)} alt="" />
            <div><b>这张 = {evHm(sugEvent.at)} 的"{sugEvent.kind === 'arrived' ? '到了' : '拍到了'} · {sugEvent.stopName ?? '行程外'}"？</b><small>{sug.note}</small>
              <div className="exr-row"><button className="rh-btn is-solid" disabled={!!busy} onClick={() => void act(g.id, () => api.anchor(g.id, { photoId: sug.photoId, eventClientId: sug.eventClientId }))}>就是这个</button>
                <button className="rh-btn" onClick={() => setPickFor(g.id)}>另选</button></div></div>
          </div>}
          {(!sug || g.anchors.length > 0 || pickFor === g.id) && <div className="exr-row">
            <select value={pick.photoId} onChange={e => setPick(p => ({ ...p, photoId: e.target.value }))} aria-label="选一张照片"><option value="">选一张照片…</option>
              {mine.map(p => <option key={p.id} value={p.id}>{p.fileName} · 相机记 {exifHm(p.exif.dateTimeOriginal)}</option>)}</select>
            <span>=</span>
            <select value={pick.eventClientId} onChange={e => setPick(p => ({ ...p, eventClientId: e.target.value }))} aria-label="对应的现场打卡"><option value="">对应的现场打卡…</option>
              {anchorable.map(e => <option key={e.clientId} value={e.clientId}>{evHm(e.at)} {e.kind === 'arrived' ? '到了' : '拍到了'} · {e.stopName ?? '行程外'}</option>)}</select>
            <button className="rh-btn" disabled={!pick.photoId || !pick.eventClientId || !!busy} onClick={() => void act(g.id, () => api.anchor(g.id, pick))}>加参照</button>
          </div>}
          {!anchorable.length && <p className="exr-hint">这次没有现场打卡可对照。可以在对话里告诉助手某张照片大概几点拍的。</p>}
        </div>}
        {g.status !== 'confirmed' && g.offsetSec !== null && <div className="exr-row">
          <button className="rh-btn is-solid" disabled={!!busy} onClick={() => void act(g.id, () => api.confirmClock(g.id, g.timezone ?? tz, g.offsetSec!))}>{busy === g.id ? '正在应用…' : '确认，按这个校正'}</button>
          <small className="exr-hint">会重算这组照片的时间和归属；你手动归过的不动。</small>
        </div>}
      </div>;
    })}
    {err && <p className="exr-warn">{err}</p>}
  </div>;
}
