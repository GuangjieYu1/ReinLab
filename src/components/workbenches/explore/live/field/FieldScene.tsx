import { lazy, Suspense, useEffect, useState } from 'react';
import type { BuildingScene, ExplorePlan, Stop } from '../../../../../../packages/contracts/src/explore';
import type { ExploreAdapter } from '../adapter';
import type { PackRecord } from '../offline/db';
import SafeBox from '../SafeBox';
import { localToDate } from '../sunlive';

const WhiteModel = lazy(() => import('../WhiteModel'));
const viaBackend = (u: string) => (u.startsWith('/v1/') ? '/backend' + u : u);

/** 现场看白模：在线走接口；离线读离线包里缓存的同一份场景（不联网）。只看，不改站位。 */
export default function FieldScene({ plan, stop, day, tz, nowMinutes, adapter, pack }: {
  plan: ExplorePlan; stop: Stop; day: string; tz: string; nowMinutes: number; adapter: ExploreAdapter | null; pack: PackRecord | null;
}) {
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState<BuildingScene | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(nowMinutes);
  useEffect(() => { setScene(null); setErr(null); setOpen(false); }, [stop.id]);
  useEffect(() => {
    if (!open || scene || err) return;
    const url = pack?.manifest.scenes.find(s => s.stopId === stop.id)?.url;
    const load = adapter ? adapter.scene(stop.id)
      : url ? fetch(viaBackend(url), { credentials: 'same-origin' }).then(r => { if (!r.ok) throw Error('离线包里没有这个点的建筑数据'); return r.json() as Promise<BuildingScene>; })
      : Promise.reject(Error('离线包里没有这个点的建筑数据（准备离线包时它可能还不是已确认的点）'));
    load.then(setScene, e => setErr(e instanceof Error ? e.message : '取不到建筑数据'));
  }, [open, stop.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const body = plan.gear.map(g => g.data).find((g): g is Extract<typeof g, { type: 'gear' }> => g.type === 'gear' && g.kind === 'body');
  const focals = [...new Set([...(stop.detail?.settings?.focalMm ? [stop.detail.settings.focalMm] : []), ...(stop.focal ?? [])])];
  const at = localToDate(day, minutes, tz).getTime();
  const blocking = [stop.light2?.camera, stop.light2?.subject].flatMap(pl => {
    const seg = pl?.segments.find(x => Date.parse(x.start) <= at && at < Date.parse(x.end));
    return seg?.state === 'building' ? seg.cause?.buildingIds ?? [] : [];
  });
  return <section className="exf-scene">
    <span className="exf-kicker">白模{pack && !adapter ? ' · 离线' : ''}</span>
    {!open ? <button className="rh-btn" onClick={() => setOpen(true)}>看这个点的白模</button>
      : err ? <p className="exf-hint">{err}</p>
      : !scene ? <p className="exf-hint">正在取建筑数据…</p>
      : <SafeBox fallback={() => <p className="exf-hint">白模没能加载{adapter ? '' : '（这台设备上没缓存到白模的程序；联网时重新准备一次离线包）'}</p>}><Suspense fallback={<p className="exf-hint">正在加载白模…</p>}>
          <WhiteModel scene={scene} stop={stop} day={day} tz={tz} minutes={minutes} onMinutes={setMinutes}
            focals={focals.length ? focals : [35]} sensor={body?.sensor ?? null} orientation={stop.detail?.frame?.orientation ?? 'landscape'}
            cameraHeightM={stop.cameraHeightM ?? 1.5} subjectHeightM={stop.subjectHeightM ?? 1.5}
            highlight={[...new Set(blocking)]} pick={null} onPick={() => {}} />
        </Suspense></SafeBox>}
  </section>;
}
