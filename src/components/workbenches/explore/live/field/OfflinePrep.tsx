import { useEffect, useRef, useState } from 'react';
import type { OfflineManifest } from '../../../../../../packages/contracts/src/explore';
import type { ExploreAdapter } from '../adapter';
import { db, type PackRecord } from '../offline/db';
import { checkPack, deletePack, preparePack, type PackProgress } from '../offline/pack';
import { cacheShell, registerExploreSW } from '../offline/sw';

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

/** 准备离线使用（10-explore-v2-contract.md 第 2.1 节）：清单里每项都存好才算可离线；超限照实说、让用户选；不自动分包。 */
export default function OfflinePrep({ adapter, accountId, dossierId, title, days }: {
  adapter: ExploreAdapter; accountId: string; dossierId: string; title: string; days: string[];
}) {
  const [day, setDay] = useState(days[0] ?? '');
  const [packs, setPacks] = useState<PackRecord[]>([]);
  const [prog, setProg] = useState<PackProgress | null>(null);
  const [over, setOver] = useState<OfflineManifest | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const reload = async () => setPacks(await db.packsFor(dossierId));
  useEffect(() => { void reload(); }, [dossierId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (opts: { manifest?: OfflineManifest; detail?: 'low' } = {}) => {
    setMsg(null); setOver(null);
    const sw = await registerExploreSW();
    if (!sw) { setMsg('这里不能离线：需要构建版本，并通过 localhost 或设备信任的 HTTPS 地址打开（局域网 HTTP 不行）。'); return; }
    await cacheShell();
    abort.current = new AbortController();
    try {
      const r = await preparePack({ adapter, accountId, dossierId, title, day, ...opts, onProgress: setProg, signal: abort.current.signal });
      if ('overLimit' in r) { setOver(r.overLimit); setProg(null); return; }
      setMsg(r.state === 'ready' ? '可以离线使用了。断网后从入口或这个地址重新打开即可。' : `还有 ${r.missing.length} 项没存好，点"继续"补下载。`);
    } catch (e) { setMsg(e instanceof Error ? e.message : '准备没完成'); }
    finally { abort.current = null; await reload(); }
  };

  return <div className="exf-prep">
    <span className="exf-kicker">离线使用</span>
    {packs.map(p => <div key={p.packId} className="exf-pack" data-state={p.state}>
      <b>{p.day} · 第 {p.planRevision} 版计划</b>
      <small>{p.state === 'ready' ? '可离线使用' : p.state === 'preparing' ? '准备中断了' : `缺 ${p.missing.length} 项`} · {mb(p.manifest.tileBytes)} 地图 · {p.manifest.tiles.length} 块瓦片</small>
      {p.manifest.unknowns.length > 0 && <details className="exf-unk"><summary>{p.manifest.unknowns.length} 条缺项（楼高、路线等），点开看</summary><ul>{p.manifest.unknowns.map(u => <li key={u}>{u}</li>)}</ul></details>}
      <div>
        <button className="rh-btn" onClick={async () => { const r = await checkPack(p.packId); setMsg(r?.state === 'ready' ? '检查过了：都在' : `缺 ${r?.missing.length} 项：${r?.missing.slice(0, 3).join('、')}…`); await reload(); }}>检查</button>
        {p.state !== 'ready' && <button className="rh-btn is-solid" onClick={() => void start({ manifest: p.manifest })}>继续</button>}
        <button className="dm-link dm-danger" onClick={async () => { const r = await deletePack(p.packId); setMsg(r.ok ? '已删除这个离线包' : `还有 ${r.pending} 条现场记录没同步，先同步再删`); await reload(); }}>删除</button>
      </div>
    </div>)}
    <div className="exf-row">
      {days.length > 1 && <select value={day} onChange={e => setDay(e.target.value)} aria-label="拍摄日">{days.map(d => <option key={d}>{d}</option>)}</select>}
      <button className="rh-btn is-solid" disabled={!!prog && prog.phase !== 'ready' && prog.phase !== 'incomplete'} onClick={() => void start()}>准备离线使用{days.length <= 1 ? ` · ${day}` : ''}</button>
      {abort.current && <button className="rh-btn" onClick={() => abort.current?.abort()}>暂停</button>}
    </div>
    {prog && <p className="exf-hint">{({ manifest: '算范围…', download: '下载中', verify: '核对中', ready: '完成', incomplete: '没完成' } as const)[prog.phase]} · {prog.done}/{prog.total}{prog.failed.length ? ` · 失败 ${prog.failed.length}` : ''}</p>}
    {over && <div className="exf-over">
      <p>这一天的地图超过一次离线下载的上限：{over.tiles.length} 块瓦片、{mb(over.tileBytes)}（上限 3000 块 / 50 MB）。{over.limit.note}</p>
      <button className="rh-btn is-solid" onClick={() => void start({ detail: 'low' })}>接受较低细节</button>
      <button className="rh-btn" onClick={() => setOver(null)}>取消</button>
    </div>}
    {msg && <p className="exf-hint" role="status">{msg}</p>}
  </div>;
}
