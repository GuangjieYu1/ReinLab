// 本地内存版：演示模式下 ?explore=memory 才用，用来看真实界面（真实地图瓦片，不连后端、不调模型）。
// 预置一份小计划；修改按契约规则在内存里生效（原子批次、修订 +1、结果带回）。
import type { AppliedOp, CanvasObject, ExplorePlan, Op, Profile, RefImage, Stop } from '../../../../../packages/contracts/src/explore';
import { ExploreError, type ChatItem, type ExploreAdapter, type ExploreEvent, type ExploreSnapshot } from './adapter';

const iso = (day: string, hhmm: string) => `${day}T${hhmm}:00+08:00`;
const DAY = (() => { const d = new Date(Date.now() + 3 * 864e5); return d.toISOString().slice(0, 10); })();

function seed(): ExploreSnapshot {
  const stops: Stop[] = [
    { id: 's1', kind: 'spot', state: 'confirmed', name: '外滩观景平台', geometry: { type: 'Point', coordinates: [121.4905, 31.2397] }, day: DAY, window: { start: iso(DAY, '16:30'), end: iso(DAY, '17:20') },
      reason: '对岸陆家嘴天际线，日落后蓝调最好', facing: 100, focal: [35, 85], refs: [], source: 'agent', detail: { composition: '人物放左三分之一，背景压陆家嘴', guidance: ['沿栏杆慢慢走过来，看江面', '停下，回头看我'] } },
    { id: 's2', kind: 'area', state: 'candidate', name: '武康路一带', geometry: { type: 'Polygon', coordinates: [[[121.4385, 31.2085], [121.4425, 31.2105], [121.4455, 31.2065], [121.4405, 31.2040], [121.4385, 31.2085]]] }, day: DAY, window: { start: iso(DAY, '14:00'), end: iso(DAY, '15:30') },
      reason: '梧桐和老洋房，下午侧光', refs: [], source: 'agent' },
    { id: 's3', kind: 'waypoint', state: 'candidate', name: '南京东路步行街', geometry: { type: 'Point', coordinates: [121.4815, 31.2380] }, day: DAY, window: { start: iso(DAY, '18:00'), end: iso(DAY, '18:40') },
      reason: '去外滩路上顺路，霓虹街拍', refs: [], source: 'agent' },
  ];
  const plan: ExplorePlan = { dossierId: 'memory', revision: 1, state: 'draft', destination: { name: '上海', center: [121.47, 31.23], timezone: 'Asia/Shanghai' },
    days: [DAY], kinds: ['portrait', 'street'], feel: null, people: [], gear: [], stops, routes: [], conflicts: [], updatedAt: new Date().toISOString() };
  return { plan, canvas: [], refs: [], lastViewport: null, basemap: 'vector' };
}

export function createMemoryExploreAdapter(): ExploreAdapter {
  let snap = seed(), n = 100;
  const profiles: Profile[] = [];
  const subs = new Set<(e: ExploreEvent) => void>();
  const id = (p: string) => `${p}${++n}`;

  function apply(op: Op): AppliedOp['result'] {
    const p = snap.plan;
    switch (op.op) {
      case 'stop.add': { const st = { ...op.stop, id: id('s'), state: op.stop.state ?? 'candidate', source: 'user' } as Stop; snap.plan = { ...p, stops: [...p.stops, st] }; return { stop: st }; }
      case 'stop.update': { const st = { ...p.stops.find(s => s.id === op.id)!, ...op.patch, id: op.id } as Stop; snap.plan = { ...p, stops: p.stops.map(s => s.id === op.id ? st : s) }; return { stop: st }; }
      case 'stop.remove': snap.plan = { ...p, stops: p.stops.filter(s => s.id !== op.id) }; return { removedStopId: op.id };
      case 'stop.confirm': { const stops = p.stops.map(s => op.ids.includes(s.id) ? { ...s, state: 'confirmed' as const } : s); snap.plan = { ...p, stops }; return { stops: stops.filter(s => op.ids.includes(s.id)) }; }
      case 'plan.confirm': { const stops = p.stops.map(s => ({ ...s, state: 'confirmed' as const })); snap.plan = { ...p, stops, state: 'ready' }; return { stops, plan: { state: 'ready' } }; }
      case 'plan.finish': snap.plan = { ...p, state: 'finished' }; return { plan: { state: 'finished' } };
      case 'plan.cancel': snap.plan = { ...p, state: 'cancelled' }; return { plan: { state: 'cancelled' } };
      case 'plan.set': snap.plan = { ...p, ...op.patch }; return { plan: op.patch };
      case 'feel.set': snap.plan = { ...p, feel: op.feel }; return { plan: { feel: op.feel } };
      case 'plan.select': {
        const pick = (ids?: string[]) => ids?.map(pid => { const pr = profiles.find(x => x.id === pid)!; return { profileId: pid, revision: pr.revision, data: pr }; });
        const patch = { ...(op.people ? { people: pick(op.people)! } : {}), ...(op.gear ? { gear: pick(op.gear)! } : {}) };
        snap.plan = { ...p, ...patch }; return { plan: patch };
      }
      case 'canvas.add': { const o = { ...op.object, id: id('c'), author: 'user', createdAt: new Date().toISOString() } as CanvasObject; snap.canvas = [...snap.canvas, o]; return { object: o }; }
      case 'canvas.update': { const o = { ...snap.canvas.find(c => c.id === op.id)!, ...op.patch } as CanvasObject; snap.canvas = snap.canvas.map(c => c.id === op.id ? o : c); return { object: o }; }
      case 'canvas.remove': snap.canvas = snap.canvas.filter(c => c.id !== op.id); return { removedObjectId: op.id };
      case 'canvas.undo': { const last = snap.canvas.at(-1); if (!last) return {}; snap.canvas = snap.canvas.slice(0, -1); return { removedObjectId: last.id }; }
      case 'view.save': snap = { ...snap, lastViewport: op.viewport, basemap: op.basemap }; return {};
    }
  }
  const summary = (op: Op) => ({ 'stop.confirm': '留下候选', 'stop.remove': '删除停留点', 'plan.confirm': '确认整份计划', 'canvas.add': '加了一条笔记', 'canvas.undo': '撤回草图', 'plan.select': '更新计划用的资料' } as Record<string, string>)[op.op] ?? op.op;

  return {
    kind: 'memory',
    load: async () => structuredClone(snap),
    async ops(base, ops) {
      if (base !== snap.plan.revision && !ops.every(o => o.op === 'view.save')) throw new ExploreError('计划刚被改过', 'REVISION_CONFLICT');
      const applied = ops.filter(o => o.op !== 'view.save').map(o => ({ ...o, opId: id('op'), actor: 'user' as const, summary: summary(o), result: apply(o)! }));
      if (applied.length) snap.plan = { ...snap.plan, revision: snap.plan.revision + 1 };
      return { revision: snap.plan.revision, applied, pending: null };
    },
    saveView(viewport, basemap) { snap = { ...snap, lastViewport: viewport, basemap }; },
    weather: async () => ({ state: 'out_of_range', byStop: [], destination: null, fetchedAt: null, source: { name: '本地预览 · 不取天气' }, nextCheckAt: null }),
    suggestions: async () => [],
    usage: async () => ({ byPurpose: [], byModel: [], tools: [], unknownCalls: 0 }),
    places: async () => [],
    mapConfig: async () => ({ vector: { tilejson: 'https://tiles.openfreemap.org/planet', glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', attribution: '© OpenMapTiles © OpenStreetMap contributors · OpenFreeMap' }, satellite: null, contours: null, publicKey: null }),
    profiles: async () => [...profiles],
    async saveProfile(p) {
      if (p.id) { const i = profiles.findIndex(x => x.id === p.id); profiles[i] = { ...p, id: p.id, revision: profiles[i].revision + 1 } as Profile; return profiles[i]; }
      const np = { ...p, id: id('pr'), revision: 1 } as Profile; profiles.push(np); return np;
    },
    async deleteProfile(pid) { const i = profiles.findIndex(x => x.id === pid); if (i >= 0) profiles.splice(i, 1); },
    async uploadRef(file, kind) { const r: RefImage = { id: id('r'), origin: 'upload', kind, image: { src: URL.createObjectURL(file) } }; snap.refs = [...snap.refs, r]; return r; },
    async removeRef(rid) { snap.refs = snap.refs.filter(r => r.id !== rid); },
    async uploadSnapshot() { /* 本地预览不保存 */ },
    async book() { throw new ExploreError('本地预览不生成 PDF', 'NOT_AVAILABLE'); },
    timezone: async () => 'Asia/Shanghai',
    async setTimezone() {},
    async decide() {},
    subscribe(on) { subs.add(on); return () => { subs.delete(on); }; },
    chat(on) {
      let items: ChatItem[] = [{ id: 'hello', kind: 'agent', text: '这是本地预览：地图是真的，计划是预置的示例，对话不连模型。可以在地图上点候选「留下 / 不要」，或者确认整份计划看看效果。' }];
      return {
        async load() { on(items, false); },
        async send(text) { items = [...items, { id: id('u'), kind: 'user', text }, { id: id('a'), kind: 'agent', text: '本地预览不连模型。接上后端以后，这里是真正的旅拍搭档。' }, { id: id('k'), kind: 'stops', stopIds: snap.plan.stops.filter(s => s.state === 'candidate').map(s => s.id) }]; on(items, false); },
        stop() {},
      };
    },
  };
}
