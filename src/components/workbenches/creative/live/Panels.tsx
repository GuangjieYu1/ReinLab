import { useState } from 'react';
import type {
  CheckRun, ConflictKind, CreativeConflict, CreativeOp, CreativeRouteLeg, Entity, Fix, MapEdit, Proposal, TransportMode, WorldEvent, WorldRule,
} from '../../../../../packages/contracts/src/creative';
import { dur } from './geo';

export const KIND_ZH: Record<ConflictKind, string> = {
  double_location: '同时异地', travel_time: '路程耗时', dead_appearance: '死后出场', presence: '在场互动', place_hierarchy: '地点层级与连接',
};
const BASIS_ZH: Record<string, string> = { explicit: '原文明写', inferred: '推断', unknown: '未知', author: '作者手写' };
const NARR_ZH: Record<string, string> = { fact: '事实', hearsay: '传闻', dream: '梦境', hypothetical: '假设', flashback: '回忆' };
const LEVEL_ZH: Record<string, string> = { world: '世界', region: '区域', city: '城市', building: '建筑', floor: '楼层', room: '房间', site: '地点' };
const EFFECT_ZH: Record<string, string> = { add: '新增', hide: '隐藏', rename: '改名', restyle: '改样式', passability: '通行变化' };
const ROUTE_ZH: Record<string, string> = { network: '路网', manual: '手绘（已确认）', inferred: 'AI 推断（未确认）', none: '算不出' };
const MAX_OPS = 40;
/** 服务端预览里偶尔是枚举原值（如 fact → flashback）：认得的翻成中文，不认得的照原样。 */
const zh = (v: string) => NARR_ZH[v] ?? KIND_ZH[v as ConflictKind] ?? v;

/** 一批最多 40 条（后端约定），超了按顺序分批提交。 */
export async function submitChunks(send: (ops: CreativeOp[]) => Promise<unknown>, ops: CreativeOp[]) {
  for (let i = 0; i < ops.length; i += MAX_OPS) await send(ops.slice(i, i + MAX_OPS));
}

type Lookup = { events: Map<string, WorldEvent>; entities: Map<string, Entity>; rules: Map<string, WorldRule> };

/* ———— 修法预览（先看前后对照，接受才提交） ———— */
function FixPreview({ fixes, look, onAccept, onCancel, busy }: { fixes: Fix[]; look: Lookup; onAccept: () => void; onCancel: () => void; busy: boolean }) {
  return <div className="cw-fixprev">
    <span className="rh-micro">接受后会改这些</span>
    {fixes.map(f => <div key={f.id}><b>{f.label}</b>{f.kind === 'drop_constraint' && <em>删约束是一条设定决定，不是隐藏警告</em>}
      <ul>{f.preview.map((p, i) => <li key={i}>{p.eventId && <span>「{look.events.get(p.eventId)?.title ?? '事件'}」</span>}{p.field}：<s>{zh(p.before)}</s> → <ins>{zh(p.after)}</ins></li>)}</ul></div>)}
    <div className="cw-row"><button className="rh-btn is-solid" disabled={busy} onClick={onAccept}>{busy ? '提交中…' : '接受并重查'}</button><button className="rh-btn" onClick={onCancel}>取消</button></div>
  </div>;
}

/* ———— 检查（照 Aeon Timeline：红 / 黄 / 信息不足 / 未覆盖 + 本次查过未发现） ———— */
export function CheckPanel({ check, look, sel, onSel, onApply, onRecheck, busy }: {
  check: CheckRun | null; look: Lookup; sel: string | null; onSel: (c: CreativeConflict | null) => void;
  onApply: (fixes: Fix[]) => Promise<void>; onRecheck: () => void; busy: boolean;
}) {
  const [preview, setPreview] = useState<{ key: string; fixes: Fix[] } | null>(null);
  if (!check) return <div className="cw-pane"><p className="cw-muted">还没检查过。</p><button className="rh-btn" onClick={onRecheck} disabled={busy}>全部重查</button></div>;
  const hard = check.conflicts.filter(c => c.severity === 'hard'), sus = check.conflicts.filter(c => c.severity === 'suspect');
  const auto = check.conflicts.map(c => c.fixes.find(f => f.kind !== 'drop_constraint')).filter((f): f is Fix => !!f);
  const apply = async (fixes: Fix[]) => { await onApply(fixes); setPreview(null); };
  const conflict = (c: CreativeConflict) => <article key={c.id} className="cw-conf" data-sev={c.severity} data-sel={sel === c.id || undefined}>
    <button className="cw-conf-head" onClick={() => onSel(sel === c.id ? null : c)}>
      <em>{c.severity === 'hard' ? '确定冲突' : '疑似 · 按推断路线估算'}</em><b>{KIND_ZH[c.kind]}</b><p>{c.why}</p>
      {c.numbers && <small>{c.numbers.needMin != null && `需要 ${dur(c.numbers.needMin) || '0 分'}`}{c.numbers.needMin != null && c.numbers.haveMin != null && ' · '}{c.numbers.haveMin != null && `只有 ${dur(c.numbers.haveMin) || '0 分'}`}</small>}
    </button>
    {sel === c.id && <div className="cw-fixes">{c.fixes.map(f => <button key={f.id} className="cw-fix" data-kind={f.kind} onClick={() => setPreview({ key: f.id, fixes: [f] })}>{f.label}</button>)}
      {!c.fixes.length && <p className="cw-muted">服务端没给修法，去改相关事件。</p>}
      {preview && c.fixes.some(f => f.id === preview.key) && <FixPreview fixes={preview.fixes} look={look} busy={busy} onAccept={() => void apply(preview.fixes)} onCancel={() => setPreview(null)} />}
    </div>}
  </article>;
  return <div className="cw-pane">
    <div className="cw-check-sum">
      <span data-sev="hard">红 {hard.length}</span><span data-sev="suspect">黄 {sus.length}</span><span>信息不足 {check.insufficient.length}</span><span>未覆盖 {check.uncovered.length}</span>
      <button className="rh-btn" onClick={onRecheck} disabled={busy}>全部重查</button>
    </div>
    {auto.length > 1 && <div className="cw-allfix">
      <button className="rh-btn" onClick={() => setPreview({ key: 'all', fixes: auto })}>全部处理（{auto.length} 条，先看预览）</button>
      {preview?.key === 'all' && <FixPreview fixes={preview.fixes} look={look} busy={busy} onAccept={() => void apply(preview.fixes)} onCancel={() => setPreview(null)} />}
    </div>}
    {hard.map(conflict)}{sus.map(conflict)}
    {check.insufficient.length > 0 && <section className="cw-sub"><h4>信息不足 · 不算通过</h4>{check.insufficient.map(i => <button key={i.eventId} className="cw-line" onClick={() => onSel({ id: 'gap:' + i.eventId, eventIds: [i.eventId] } as CreativeConflict)}>
      <b>{look.events.get(i.eventId)?.title ?? '事件'}</b><span>{i.gaps.join('；')}</span></button>)}</section>}
    {check.uncovered.length > 0 && <section className="cw-sub"><h4>未覆盖 · 程序还判不了</h4>{check.uncovered.map(u => <div key={u.ruleId} className="cw-line"><b>{look.rules.get(u.ruleId)?.text ?? u.ruleId}</b><span>{u.why}</span></div>)}</section>}
    <p className="cw-clean">本次查过、未发现：{check.clean.length ? check.clean.map(k => KIND_ZH[k]).join('、') : '—'}<small>（不等于没有矛盾）</small></p>
  </div>;
}

/* ———— 待确认（1A 只有路线） ———— */
export function ProposalList({ proposals, legs, look, onDecide, onRedraw, onDraw, onFocusLeg, busy }: {
  proposals: Proposal[]; legs: Map<string, CreativeRouteLeg>; look: Lookup;
  onDecide: (p: Proposal, d: 'accepted' | 'rejected' | 'deferred') => void;
  onRedraw: (legId: string, hint: string) => void; onDraw: (legId: string) => void; onFocusLeg: (legId: string) => void; busy: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null), [hint, setHint] = useState('');
  if (!proposals.length) return <div className="cw-pane"><p className="cw-muted">没有待确认的内容。缺路时 AI 画的推断路线会出现在这里。</p></div>;
  return <div className="cw-pane">{proposals.map(p => {
    const legId = (p.ops.find(o => o.op === 'route.draw') as { legId?: string } | undefined)?.legId;
    const leg = legId ? legs.get(legId) : undefined;
    const who = leg ? look.entities.get(leg.entityId)?.name : undefined;
    const from = leg ? look.events.get(leg.fromEventId)?.title : undefined, to = leg ? look.events.get(leg.toEventId)?.title : undefined;
    return <article key={p.id} className="cw-prop" data-status={p.status}>
      <header onClick={() => { setOpen(open === p.id ? null : p.id); if (legId) onFocusLeg(legId); }}>
        <em>{p.kind === 'route' ? '推断路线' : p.kind}{p.status === 'deferred' ? ' · 暂缓' : ''}</em>
        <b>{who ? `${who}：${from ?? '?'} → ${to ?? '?'}` : p.title}</b>
        {leg && <small>{leg.distanceKm != null ? `${leg.distanceKm.toFixed(1)} km` : '距离未知'} · {leg.durationMin != null ? dur(leg.durationMin) : '耗时未知'}</small>}
      </header>
      {open === p.id && <div className="cw-prop-body">
        {p.origin.why && <p className="cw-why"><span className="rh-micro">依据</span>{p.origin.why}</p>}
        {leg?.inferred?.sources?.length ? <ul className="cw-src">{leg.inferred.sources.map((s, i) => <li key={i}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</li>)}</ul> : null}
        {p.doubts.length > 0 && <><span className="rh-micro">疑点</span><ul className="cw-doubts">{p.doubts.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
        {p.conflicts.length > 0 && <p className="cw-warn">接受后会有 {p.conflicts.length} 条冲突：{p.conflicts.map(c => KIND_ZH[c.kind]).join('、')}</p>}
        <div className="cw-row">
          <button className="rh-btn is-solid" disabled={busy} onClick={() => onDecide(p, 'accepted')}>确认这条路线</button>
          {legId && <button className="rh-btn" disabled={busy} onClick={() => onDraw(legId)}>自己画</button>}
          {p.status !== 'deferred' && <button className="rh-btn" disabled={busy} onClick={() => onDecide(p, 'deferred')}>暂缓</button>}
          <button className="rh-btn" disabled={busy} onClick={() => onDecide(p, 'rejected')}>不要</button>
        </div>
        {legId && <div className="cw-row cw-redraw"><input value={hint} onChange={e => setHint(e.target.value)} placeholder="重画的提示（可空）：比如「走水路」「绕开山」" /><button className="rh-btn" disabled={busy} onClick={() => { onRedraw(legId, hint); setHint(''); }}>让 AI 重画</button></div>}
      </div>}
    </article>;
  })}</div>;
}

/* ———— 详情 ———— */
export type Sel =
  | { kind: 'event'; id: string } | { kind: 'person'; id: string } | { kind: 'place'; id: string }
  | { kind: 'leg'; id: string } | { kind: 'edit'; id: string } | { kind: 'mode'; id: string } | { kind: 'rule'; id: string };

export function Detail({ works = [], onOpenWork, sel, look, legs, edits, modes, conflicts, onPick, onEdit, onRemove, onDraw, onRedraw }: {
  works?: import('../../../../../packages/contracts/src/creative').Work[];
  onOpenWork?: (ref: { workId: string; chapterId?: string; sceneId?: string }) => void;
  sel: Sel; look: Lookup; legs: Map<string, CreativeRouteLeg>; edits: MapEdit[]; modes: TransportMode[]; conflicts: CreativeConflict[];
  onPick: (s: Sel) => void; onEdit: (s: Sel) => void; onRemove: (s: Sel) => void; onDraw: (legId: string) => void; onRedraw: (legId: string) => void;
}) {
  const name = (id: string | null | undefined) => (id && look.entities.get(id)?.name) || '未定';
  const tools = (removable = true) => <div className="cw-row"><button className="rh-btn" onClick={() => onEdit(sel)}>编辑</button>{removable && <button className="rh-btn" onClick={() => onRemove(sel)}>删除</button>}</div>;
  const flagsOf = (pred: (c: CreativeConflict) => boolean) => conflicts.filter(pred).map(c => <p key={c.id} className="cw-flag" data-sev={c.severity}>{KIND_ZH[c.kind]} · {c.why}</p>);
  if (sel.kind === 'event') {
    const e = look.events.get(sel.id); if (!e) return <p className="cw-muted">这条事件已经不在了。</p>;
    const time = (s: WorldEvent['start']) => <>{s.label}{s.certainty !== 'exact' && <small> · {s.certainty === 'range' ? '范围' : s.certainty === 'relative' ? '相对' : '未知'}</small>}</>;
    return <div className="cw-pane cw-detail">
      <span className="rh-micro">事件 · {NARR_ZH[e.narrative]} · {BASIS_ZH[e.origin.basis] ?? e.origin.basis}</span><h3>{e.title}</h3>{e.what && <p>{e.what}</p>}
      {flagsOf(c => c.eventIds.includes(e.id))}
      <dl>
        <div><dt>开始</dt><dd>{time(e.start)}</dd></div><div><dt>结束</dt><dd>{time(e.end)}</dd></div>
        <div><dt>地点</dt><dd>{e.placeId ? <button className="cw-link" onClick={() => onPick({ kind: 'place', id: e.placeId! })}>{name(e.placeId)}</button> : '未定'}</dd></div>
        {e.travel && <div><dt>怎么到</dt><dd>从{name(e.travel.fromId)} · {modes.find(m => m.id === e.travel!.modeId)?.name ?? '交通方式未定'}</dd></div>}
        <div><dt>参与</dt><dd>{e.participants.map(p => <button key={p.entityId} className="cw-link" onClick={() => onPick({ kind: 'person', id: p.entityId })}>{name(p.entityId)}<small>{p.as === 'actor' ? '' : p.as === 'present' ? ' 在场' : p.as === 'remote' ? ' 远程' : ' 提及'}</small></button>)}</dd></div>
      </dl>
      {e.workRefs.length > 0 && <section><h4>出现于作品</h4>{e.workRefs.map((r, i) => <button className="cw-link" key={i} onClick={() => onOpenWork?.(r)}>{works.find(w => w.id === r.workId)?.title ?? `作品 ${r.workId.slice(0, 8)}`}{r.chapterId ? ` · ${works.find(w => w.id === r.workId)?.chapters.find(c => c.id === r.chapterId)?.title ?? r.chapterId}` : ''}{r.sceneId ? ` · ${works.find(w => w.id === r.workId)?.chapters.flatMap(c => c.scenes).find(sc => sc.id === r.sceneId)?.title ?? r.sceneId}` : ''}</button>)}</section>}
      {e.gaps.length > 0 && <p className="cw-warn">检查缺口：{e.gaps.join('；')}</p>}
      {e.start.original && e.start.original !== e.start.label && <p className="cw-muted">原写法：{e.start.original}</p>}
      {tools()}
    </div>;
  }
  if (sel.kind === 'person' || sel.kind === 'place') {
    const e = look.entities.get(sel.id); if (!e) return <p className="cw-muted">这个条目已经不在了。</p>;
    const evs = [...look.events.values()].filter(x => sel.kind === 'person' ? x.participants.some(p => p.entityId === e.id) : x.placeId === e.id)
      .sort((a, b) => (a.start.t ?? Infinity) - (b.start.t ?? Infinity));
    const kids = [...look.entities.values()].filter(x => x.place?.parentId === e.id);
    return <div className="cw-pane cw-detail">
      <span className="rh-micro">{sel.kind === 'person' ? '人物' : `地点 · ${LEVEL_ZH[e.place?.level ?? 'site']}`}{e.aliases.length ? ` · 又名 ${e.aliases.join('、')}` : ''}</span><h3>{e.name}</h3>{e.summary && <p>{e.summary}</p>}
      {flagsOf(c => c.entityIds.includes(e.id))}
      {e.place && <dl>
        <div><dt>上级</dt><dd>{e.place.parentId ? <button className="cw-link" onClick={() => onPick({ kind: 'place', id: e.place!.parentId! })}>{name(e.place.parentId)}</button> : '—'}</dd></div>
        {kids.length > 0 && <div><dt>下级</dt><dd>{kids.map(k => <button key={k.id} className="cw-link" onClick={() => onPick({ kind: 'place', id: k.id })}>{k.name}</button>)}</dd></div>}
        {e.place.connects.length > 0 && <div><dt>相通</dt><dd>{e.place.connects.map(c => <span key={c.to}>{name(c.to)}{c.passable ? '' : '（不通）'}{c.note ? ` · ${c.note}` : ''} </span>)}</dd></div>}
        <div><dt>位置</dt><dd>{e.place.geoCertainty === 'exact' ? '已定位' : e.place.geoCertainty === 'area' ? '只知道一个范围' : '未定位'}</dd></div>
      </dl>}
      <span className="rh-micro">相关事件 · {evs.length}</span>
      <div className="cw-evlist">{evs.map(x => <button key={x.id} onClick={() => onPick({ kind: 'event', id: x.id })}><b>{x.title}</b><small>{x.start.label}</small></button>)}</div>
      {tools()}
    </div>;
  }
  if (sel.kind === 'leg') {
    const l = legs.get(sel.id); if (!l) return <p className="cw-muted">这段路线已经不在了。</p>;
    return <div className="cw-pane cw-detail">
      <span className="rh-micro">路线 · {ROUTE_ZH[l.kind]}</span><h3>{name(l.entityId)}：{look.events.get(l.fromEventId)?.title} → {look.events.get(l.toEventId)?.title}</h3>
      {flagsOf(c => !!c.legIds?.includes(l.id))}
      <dl><div><dt>交通</dt><dd>{modes.find(m => m.id === l.modeId)?.name ?? '未定'}</dd></div>
        <div><dt>距离</dt><dd>{l.distanceKm != null ? `${l.distanceKm.toFixed(1)} km` : '未知'}</dd></div>
        <div><dt>耗时</dt><dd>{l.durationMin != null ? dur(l.durationMin) || '不到 1 分' : '未知'}</dd></div></dl>
      {l.failure && <p className="cw-warn">{l.kind === 'none' ? '路线待定 · ' : ''}{l.failure}</p>}
      {l.inferred && <p className="cw-why"><span className="rh-micro">AI 的依据</span>{l.inferred.why}</p>}
      <div className="cw-row"><button className="rh-btn" onClick={() => onDraw(l.id)}>自己画</button><button className="rh-btn" onClick={() => onRedraw(l.id)}>让 AI 重画</button></div>
    </div>;
  }
  if (sel.kind === 'edit') {
    const e = edits.find(x => x.id === sel.id); if (!e) return <p className="cw-muted">这个改造已经不在了。</p>;
    return <div className="cw-pane cw-detail">
      <span className="rh-micro">改造层 · {EFFECT_ZH[e.effect]}</span><h3>{e.title}</h3>
      <dl><div><dt>生效</dt><dd>{e.valid.from?.label ?? '一直'} → {e.valid.to?.label ?? '一直'}</dd></div>
        {e.props?.name && <div><dt>名称</dt><dd>{e.props.name}</dd></div>}
        {e.target?.placeId && <div><dt>对象</dt><dd>{name(e.target.placeId)}</dd></div>}
        {e.passable && <div><dt>通行</dt><dd>{e.passable.open ? '能走' : '不能走'}{e.passable.modeIds?.length ? `（${e.passable.modeIds.map(id => modes.find(m => m.id === id)?.name ?? id).join('、')}）` : ''}</dd></div>}</dl>
      {e.needsRemap && <p className="cw-warn">目标对不上了，待确认：重新指定对象，或删掉这条改造。</p>}
      {tools()}
    </div>;
  }
  if (sel.kind === 'mode') { const m = modes.find(x => x.id === sel.id); return m ? <div className="cw-pane cw-detail"><span className="rh-micro">交通方式</span><h3>{m.name}</h3><p>{m.kmPerHour} km/小时 · {m.network === 'road' ? '走路网' : m.network === 'water' ? '走水路' : m.network === 'any' ? '不限' : '不走路网'}{m.note ? ` · ${m.note}` : ''}</p>{tools()}</div> : null; }
  const r = look.rules.get(sel.id);
  return r ? <div className="cw-pane cw-detail"><span className="rh-micro">规则 · {r.machine ? '程序能判' : '自然语言，检查里显示「未覆盖」'}</span><p>{r.text}</p>{tools()}</div> : null;
}
