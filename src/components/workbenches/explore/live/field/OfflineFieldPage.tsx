import { useEffect, useState } from 'react';
import type { WeatherView } from '../../../../../../packages/contracts/src/explore';
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
  const off = offlineMapConfig(m);
  const mapCfg: MapConfig = { vector: { tilejson: '', glyphs: off.glyphs, attribution: '© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap', tiles: off.tiles, minzoom: off.minzoom, maxzoom: off.maxzoom }, satellite: null, contours: null, publicKey: null };
  return <main className="wb wb-exploration exl-fieldpage exl-offline">
    <header className="wb-strip" data-wb-bar><a className="wb-back" href="/">←</a><span className="wb-strip-bench"><b>EXPL</b>离线现场 · {pack.title}</span></header>
    <div className="wb-body exl-fieldwrap">
      <LiveField plan={snap.snap.plan} title={pack.title} weather={(snap.weather as WeatherView | null) ?? null} adapter={null}
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
