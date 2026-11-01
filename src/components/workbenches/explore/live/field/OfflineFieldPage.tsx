import { useEffect, useState } from 'react';
import type { Stop, WeatherView } from '../../../../../../packages/contracts/src/explore';
import type { MapConfig } from '../adapter';
import { db, type PackRecord, type SnapshotRecord } from '../offline/db';
import { offlineMapConfig } from '../offline/pack';
import LiveField from './LiveField';
import '../../../workbench-shell.css';
import '../../explore.css';
import '../live.css';

/**
 * 离线现场（?preview=field-offline&pack=…）：不经过登录恢复，全部数据来自本设备的离线包。
 * 锁定后不显示；不缓存 Cookie，回到能连上 ReinLab 时再正常登录、同步。
 */
export default function OfflineFieldPage() {
  const packId = new URLSearchParams(location.search).get('pack') ?? '';
  const [state, setState] = useState<{ pack: PackRecord; snap: SnapshotRecord } | 'locked' | 'missing' | null>(null);
  useEffect(() => {
    void (async () => {
      if (await db.isLocked()) { setState('locked'); return; }
      const pack = await db.getPack(packId); if (!pack) { setState('missing'); return; }
      const snap = await db.getSnapshot(pack.dossierId, pack.planRevision); if (!snap) { setState('missing'); return; }
      setState({ pack, snap });
    })();
  }, [packId]);

  if (state === null) return <div className="de"><p>正在打开离线现场…</p></div>;
  if (state === 'locked') return <div className="de"><p>已锁定。离线内容不显示，请在能连上 ReinLab 时重新登录。</p></div>;
  if (state === 'missing') return <div className="de"><p>这台设备上没有这个离线包（或已被浏览器清理）。能连上 ReinLab 时回到现场页重新准备。</p><a className="rh-btn" href="/">回到入口</a></div>;

  const { pack, snap } = state, m = pack.manifest;
  // 受光（light2）和站位高度在离线包的 light 里：并进计划快照（快照取的是修订那一刻，受光是之后异步算的）
  const extra = new Map(((snap.light as { stops?: (Partial<Stop> & { stopId: string })[] } | null)?.stops ?? []).map(x => [x.stopId, x]));
  const plan = { ...snap.snap.plan, stops: snap.snap.plan.stops.map(st => { const x = extra.get(st.id); return x ? { ...st,
    ...(x.light2 ? { light2: x.light2 } : {}), ...(x.cameraHeightM != null ? { cameraHeightM: x.cameraHeightM } : {}), ...(x.subjectHeightM != null ? { subjectHeightM: x.subjectHeightM } : {}),
    ...(x.subjectPoint !== undefined ? { subjectPoint: x.subjectPoint } : {}), ...(x.areaRef ? { areaRef: x.areaRef } : {}) } : st; }) };
  const off = offlineMapConfig(m);
  const mapCfg: MapConfig = { vector: { tilejson: '', glyphs: off.glyphs, attribution: '© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap', tiles: off.tiles, minzoom: off.minzoom, maxzoom: off.maxzoom }, satellite: null, contours: null, publicKey: null };
  return <main className="wb wb-exploration exl-fieldpage exl-offline">
    <header className="wb-strip" data-wb-bar><a className="wb-back" href="/">←</a><span className="wb-strip-bench"><b>EXPL</b>离线现场 · {pack.title}</span></header>
    <div className="wb-body exl-fieldwrap">
      <LiveField plan={plan} title={pack.title} weather={(snap.weather as WeatherView | null) ?? null} adapter={null}
        accountId={pack.accountId} dossierId={pack.dossierId} mapCfg={mapCfg} offlinePack={pack} serverRevision={null} />
    </div>
  </main>;
}

/** 入口在"连不上本地服务"时列出本设备可用的离线包（未锁定才列）。 */
export function OfflinePacksList() {
  const [packs, setPacks] = useState<PackRecord[]>([]);
  useEffect(() => { void (async () => { if (await db.isLocked()) return; setPacks((await db.allPacks()).filter(p => p.state === 'ready')); })().catch(() => {}); }, []);
  if (!packs.length) return null;
  return <div className="exl-offline-list"><span className="rh-micro">这台设备上已准备好的离线现场</span>
    {packs.map(p => <a key={p.packId} className="rh-btn" href={`/?preview=field-offline&pack=${encodeURIComponent(p.packId)}`}>{p.title} · {p.day}</a>)}</div>;
}
