// 群研视图的共用状态：快照 + 事件合并。live 与 mock 都用它，界面只读结果。
// 只做「按 id / revision / seq 取新」，不推断任何研究状态（那是服务端的事）。
import type { BoardPost, BusEntry, Intervention, SwarmEvent, SwarmMember, SwarmRoute, SwarmSnapshot, SwarmTask, SwarmView } from './swarmTypes';

export function emptyView(): SwarmView {
  return { snap: null, bus: [], dock: [], asks: [], cards: [], conn: 'idle', thinking: false, logTick: 0, missed: 0, error: null };
}

const upsert = <T extends { id: string }>(list: T[], item: T, newer: (a: T, b: T) => boolean = () => true) => {
  const i = list.findIndex(x => x.id === item.id);
  if (i < 0) return [...list, item];
  if (!newer(list[i], item)) return list;
  const next = list.slice(); next[i] = item; return next;
};

/** 时间线合并：按 seq 去重、升序。 */
export function mergeBus(list: BusEntry[], more: BusEntry[]) {
  if (!more.length) return list;
  const seen = new Set(list.map(x => x.seq));
  const add = more.filter(x => !seen.has(x.seq));
  if (!add.length) return list;
  return [...list, ...add].sort((a, b) => a.seq - b.seq);
}

/** 把一帧事件合进视图。返回新视图（不改原对象）。 */
export function applyEvent(view: SwarmView, ev: SwarmEvent): SwarmView {
  const snap = view.snap;
  if (ev.type === 'bus') return { ...view, bus: mergeBus(view.bus, [ev.data as BusEntry]), snap: snap && { ...snap, cursor: Math.max(snap.cursor, ev.seq) } };
  if (ev.type === 'member_log') return { ...view, logTick: view.logTick + 1 };
  if (!snap) return view;
  const s: SwarmSnapshot = { ...snap, cursor: Math.max(snap.cursor, ev.seq) };
  switch (ev.type) {
    case 'run': s.run = ev.data as SwarmSnapshot['run']; break;
    case 'plan': s.plan = ev.data as SwarmSnapshot['plan']; break;
    case 'member': s.members = upsert(s.members, ev.data as SwarmMember); break;
    case 'task': s.tasks = upsert(s.tasks, ev.data as SwarmTask, (a, b) => b.revision >= a.revision); break;
    case 'route': s.routes = upsert(s.routes, ev.data as SwarmRoute); break;
    case 'post': s.posts = upsert(s.posts, ev.data as BoardPost); break;
    case 'intervention': s.interventions = upsert(s.interventions, ev.data as Intervention); break;
    case 'usage': s.run = { ...s.run, used: ev.data as SwarmSnapshot['run']['used'] }; break;
    case 'report': s.report = ev.data as SwarmSnapshot['report']; break;
    case 'claim': s.claims = upsert(s.claims, ev.data as SwarmSnapshot['claims'][number]); break;
    case 'evidence': s.evidence = upsert(s.evidence, ev.data as SwarmSnapshot['evidence'][number]); break;
    case 'review': s.reviews = upsert(s.reviews, ev.data as SwarmSnapshot['reviews'][number]); break;
    default: return view;
  }
  return { ...view, snap: s };
}

/** 小型发布器：持有视图，变化时通知订阅者。 */
export function createHub() {
  let view = emptyView();
  const subs = new Set<(v: SwarmView) => void>();
  return {
    get: () => view,
    set(next: SwarmView | ((v: SwarmView) => SwarmView)) {
      view = typeof next === 'function' ? next(view) : next;
      for (const on of subs) on(view);
    },
    subscribe(on: (v: SwarmView) => void) { subs.add(on); on(view); return () => { subs.delete(on); }; },
  };
}
