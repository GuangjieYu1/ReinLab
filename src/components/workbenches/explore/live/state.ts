// 探索台真实模式的页面状态：一份计划快照 + 按修订号应用服务端推来的已生效修改。
// 规则（契约第 3、4 节）：revision === 本地 + 1 就按 result 应用；对不上就重取；409 先重取再判断原意。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppliedOp, CanvasObject, ExplorePlan, Op, PendingChange, Stop, Viewport, Basemap } from '../../../../../packages/contracts/src/explore';
import { ExploreError, type ExploreAdapter, type ExploreEvent, type ExploreSnapshot } from './adapter';

/** 按服务端的权威结果更新本地快照。纯函数，live 事件和内存版共用。 */
export function applyOps(s: ExploreSnapshot, applied: AppliedOp[], revision: number): ExploreSnapshot {
  let plan: ExplorePlan = s.plan, canvas: CanvasObject[] = s.canvas;
  const upsertStop = (st: Stop) => { plan = { ...plan, stops: plan.stops.some(x => x.id === st.id) ? plan.stops.map(x => x.id === st.id ? st : x) : [...plan.stops, st] }; };
  for (const a of applied) {
    const r = a.result ?? {};
    if (r.stop) upsertStop(r.stop);
    if (r.stops) r.stops.forEach(upsertStop);
    if (r.removedStopId) plan = { ...plan, stops: plan.stops.filter(x => x.id !== r.removedStopId) };
    if (r.object) canvas = canvas.some(x => x.id === r.object!.id) ? canvas.map(x => x.id === r.object!.id ? r.object! : x) : [...canvas, r.object];
    if (r.removedObjectId) canvas = canvas.filter(x => x.id !== r.removedObjectId);
    if (r.plan) plan = { ...plan, ...r.plan };
    if (r.routes) plan = { ...plan, routes: r.routes };
    if (r.conflicts) plan = { ...plan, conflicts: r.conflicts };
  }
  return { ...s, plan: { ...plan, revision }, canvas };
}

export type LogLine = { id: string; actor: 'agent' | 'user'; text: string; at: number };

export function useExplore(adapter: ExploreAdapter) {
  const [snap, setSnap] = useState<ExploreSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);              // 右侧操作记录（Agent 和用户的已生效动作）
  const [pending, setPending] = useState<PendingChange[]>([]);  // 页面发起后变成待批的（少见；Agent 的待批走对话卡）
  const [notice, setNotice] = useState<string | null>(null);
  const [camera, setCamera] = useState<{ viewport: Viewport; basemap?: Basemap; n: number } | null>(null);
  const snapRef = useRef<ExploreSnapshot | null>(null);
  snapRef.current = snap;
  const [events, setEvents] = useState<ExploreEvent[]>([]);    // 天气 / 计划书 / 快照请求，交给页面各自处理

  const reload = useCallback(async () => {
    try { const s = await adapter.load(); setSnap(s); setError(null); return s; }
    catch (e) { setError(e instanceof Error ? e.message : '读取计划失败'); return null; }
  }, [adapter]);

  // 同一批可能先从事件到、再从 ops() 返回到：按 opId 去重，应用本身是幂等的（按 id 覆盖）
  const record = (applied: AppliedOp[]) => setLog(l => {
    const seen = new Set(l.map(x => x.id));
    return [...l, ...applied.filter(a => !seen.has(a.opId)).map(a => ({ id: a.opId, actor: a.actor, text: a.summary, at: Date.now() }))].slice(-200);
  });

  useEffect(() => {
    void reload();
    return adapter.subscribe(ev => {
      if (ev.type === 'explore.op') {
        const cur = snapRef.current;
        // 自己刚发的那一批已经在 ops() 返回时应用过：修订号不会再 +1，直接忽略
        if (cur && ev.revision <= cur.plan.revision) return;
        if (cur && ev.revision === cur.plan.revision + 1) { setSnap(applyOps(cur, ev.applied, ev.revision)); record(ev.applied); }
        else { record(ev.applied); void reload(); }
      } else if (ev.type === 'explore.camera') {
        setCamera(c => ({ viewport: ev.viewport, basemap: ev.basemap, n: (c?.n ?? 0) + 1 }));
      } else {
        setEvents(list => [...list.slice(-20), ev]);
      }
    });
  }, [adapter, reload]);

  /**
   * 页面发起的修改。409：先重取，用 still(新快照) 判断原意是否还成立；成立就带新修订重发一次，否则提示，不覆盖。
   */
  const run = useCallback(async (ops: Op[], still?: (s: ExploreSnapshot) => boolean) => {
    const cur = snapRef.current; if (!cur) return;
    setNotice(null);
    const once = async (s: ExploreSnapshot) => {
      const r = await adapter.ops(s.plan.revision, ops);
      if (r.applied.length) { setSnap(prev => !prev || prev.plan.revision < r.revision ? applyOps(prev ?? s, r.applied, r.revision) : prev); record(r.applied); }
      if (r.pending) setPending(p => [...p, r.pending!]);
    };
    try { await once(cur); }
    catch (e) {
      if (e instanceof ExploreError && e.code === 'REVISION_CONFLICT') {
        const fresh = await reload();
        if (fresh && (!still || still(fresh))) { try { await once(fresh); } catch (e2) { setNotice(e2 instanceof Error ? e2.message : '没有成功'); } }
        else setNotice('计划刚被改过，请看一下最新的再操作。');
      } else setNotice(e instanceof Error ? e.message : '没有成功');
    }
  }, [adapter, reload]);

  return { snap, error, log, pending, setPending, notice, setNotice, camera, events, run, reload };
}
