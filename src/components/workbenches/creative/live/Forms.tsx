import { useState, type ReactNode } from 'react';
import type {
  CreativeOp, Entity, EntityKind, GeoJSON, MapEdit, Participation, PlaceLevel, TransportMode, WorldEvent, WorldRule,
} from '../../../../../packages/contracts/src/creative';
import { CreativeError } from './adapter';

type Geo = GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon;
export type DrawReq = (kind: 'point' | 'line' | 'polygon', hint: string) => Promise<Geo | null>;
type Submit = (ops: CreativeOp[]) => Promise<unknown>;

export type FormKind =
  | { kind: 'entity'; entityKind: EntityKind; id?: string }
  | { kind: 'event'; id?: string; personId?: string }
  | { kind: 'mode'; id?: string } | { kind: 'rule'; id?: string } | { kind: 'edit'; id?: string };

/** 表单外壳：只提交 Op，业务校验交给服务端；422 的 message 原样显示。 */
function Shell({ title, children, onSubmit, onCancel, onRemove }: { title: string; children: ReactNode; onSubmit: () => Promise<void>; onCancel: () => void; onRemove?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const run = (f: () => Promise<void>) => async () => {
    setBusy(true); setErr(null);
    try { await f(); }
    catch (e) { const x = e as CreativeError; setErr(x.code === 'TIME_UNPARSED' ? `时间没认出来：${x.message}` : x.code === 'IN_USE' ? `还有地方在引用它：${x.message}` : x.message); }
    finally { setBusy(false); }
  };
  return <form className="cw-pane cw-form" onSubmit={e => { e.preventDefault(); void run(onSubmit)(); }}>
    <h3>{title}</h3>{children}
    {err && <p className="cw-err" role="alert">{err}</p>}
    <div className="cw-row"><button className="rh-btn is-solid" type="submit" disabled={busy}>{busy ? '提交中…' : '保存'}</button><button className="rh-btn" type="button" onClick={onCancel}>取消</button>
      {onRemove && <button className="rh-btn cw-danger" type="button" disabled={busy} onClick={() => void run(onRemove)()}>删除</button>}</div>
  </form>;
}
const F = ({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) => <label className="cw-f"><span>{label}</span>{children}{note && <small>{note}</small>}</label>;
const geoText = (g: Geo | null | undefined) => !g ? '未定位' : g.type === 'Point' ? `点 ${(g.coordinates as number[]).map(n => n.toFixed(4)).join(', ')}` : g.type === 'LineString' ? `线 · ${g.coordinates.length} 个点` : `面 · ${g.coordinates[0].length - 1} 个点`;

/* ———— 人物 / 地点 / 物件 / 组织 ———— */
const LEVELS: [PlaceLevel, string][] = [['world', '世界'], ['region', '区域'], ['city', '城市'], ['site', '地点'], ['building', '建筑'], ['floor', '楼层'], ['room', '房间']];
export function EntityForm({ entityKind, init, places, submit, onDone, draw }: { entityKind: EntityKind; init?: Entity; places: Entity[]; submit: Submit; onDone: () => void; draw: DrawReq }) {
  const [name, setName] = useState(init?.name ?? ''), [aliases, setAliases] = useState(init?.aliases.join('、') ?? ''), [summary, setSummary] = useState(init?.summary ?? '');
  const [level, setLevel] = useState<PlaceLevel>(init?.place?.level ?? 'site'), [parent, setParent] = useState(init?.place?.parentId ?? '');
  const [geo, setGeo] = useState<Geo | null>((init?.place?.geo as Geo) ?? null);
  const [connects, setConnects] = useState(init?.place?.connects ?? []);
  const indoor = level === 'building' || level === 'floor' || level === 'room';
  const label = { person: '人物', place: '地点', item: '物件', org: '组织' }[entityKind];
  const body = (): Partial<Entity> => ({
    kind: entityKind, name: name.trim(), aliases: aliases.split(/[、,，]/).map(s => s.trim()).filter(Boolean), ...(summary.trim() ? { summary: summary.trim() } : {}),
    ...(entityKind === 'place' ? { place: { level, parentId: parent || null, geo, geoCertainty: geo ? (geo.type === 'Point' ? 'exact' : 'area') : 'unlocated', connects, ...(init?.place?.osm ? { osm: init.place.osm } : {}) } } : {}),
  });
  const save = async () => { await submit([init ? { op: 'entity.update', id: init.id, patch: body() } : { op: 'entity.add', entity: body() as never }]); onDone(); };
  const others = places.filter(p => p.id !== init?.id);
  return <Shell title={`${init ? '编辑' : '新建'}${label}`} onSubmit={save} onCancel={onDone} onRemove={init ? async () => { await submit([{ op: 'entity.remove', id: init.id }]); onDone(); } : undefined}>
    <F label="名称"><input value={name} onChange={e => setName(e.target.value)} required autoFocus /></F>
    <F label="别名" note="用顿号分开"><input value={aliases} onChange={e => setAliases(e.target.value)} /></F>
    <F label="简介"><textarea rows={2} value={summary} onChange={e => setSummary(e.target.value)} /></F>
    {entityKind === 'place' && <>
      <div className="cw-f2"><F label="层级"><select value={level} onChange={e => setLevel(e.target.value as PlaceLevel)}>{LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></F>
        <F label="属于"><select value={parent} onChange={e => setParent(e.target.value)}><option value="">—</option>{others.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></F></div>
      {!(level === 'floor' || level === 'room') && <F label="位置" note={geoText(geo)}><span className="cw-row">
        <button type="button" className="rh-btn" onClick={async () => { const g = await draw('point', `「${name || '这个地点'}」在哪`); if (g) setGeo(g); }}>在地图上点</button>
        <button type="button" className="rh-btn" onClick={async () => { const g = await draw('polygon', `圈出「${name || '这个地点'}」的范围`); if (g) setGeo(g); }}>圈一个范围</button>
        {geo && <button type="button" className="rh-btn" onClick={() => setGeo(null)}>清掉（未定位）</button>}</span></F>}
      {indoor && <F label="和哪些空间相通" note="1A 只记归属和连接，不要几何">
        <div className="cw-connects">{connects.map((c, i) => <div key={i} className="cw-row">
          <select value={c.to} onChange={e => setConnects(cs => cs.map((x, k) => k === i ? { ...x, to: e.target.value } : x))}>{others.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <label className="cw-check"><input type="checkbox" checked={c.passable} onChange={e => setConnects(cs => cs.map((x, k) => k === i ? { ...x, passable: e.target.checked } : x))} />能通行</label>
          <button type="button" className="rh-btn" onClick={() => setConnects(cs => cs.filter((_, k) => k !== i))}>×</button></div>)}
          {others.length > 0 && <button type="button" className="rh-btn" onClick={() => setConnects(cs => [...cs, { to: others[0].id, passable: true }])}>＋ 加一条连接</button>}</div></F>}
    </>}
  </Shell>;
}

/* ———— 事件 ———— */
const EV_KIND: [WorldEvent['kind'], string][] = [['stay', '停留 / 做事'], ['interaction', '互动'], ['travel', '出行'], ['birth', '出生'], ['death', '死亡'], ['other', '其他']];
const NARR: [WorldEvent['narrative'], string][] = [['fact', '事实'], ['hearsay', '传闻'], ['dream', '梦境'], ['hypothetical', '假设'], ['flashback', '回忆']];
const AS: [Participation, string][] = [['actor', '本人'], ['present', '在场'], ['remote', '远程'], ['mentioned', '只是提及']];
export function EventForm({ init, personId, persons, places, modes, submit, onDone }: { init?: WorldEvent; personId?: string; persons: Entity[]; places: Entity[]; modes: TransportMode[]; submit: Submit; onDone: () => void }) {
  const [title, setTitle] = useState(init?.title ?? ''), [what, setWhat] = useState(init?.what ?? '');
  const [kind, setKind] = useState<WorldEvent['kind']>(init?.kind ?? 'stay'), [narr, setNarr] = useState<WorldEvent['narrative']>(init?.narrative ?? 'fact');
  const [parts, setParts] = useState(init?.participants ?? (personId ? [{ entityId: personId, as: 'actor' as Participation }] : []));
  const [place, setPlace] = useState(init?.placeId ?? '');
  const [start, setStart] = useState(init?.start.original ?? init?.start.label ?? ''), [end, setEnd] = useState(init?.end.original ?? init?.end.label ?? '');
  const [from, setFrom] = useState(init?.travel?.fromId ?? ''), [mode, setMode] = useState(init?.travel?.modeId ?? '');
  const save = async () => {
    const travel = from || mode ? { fromId: from || null, toId: place || null, modeId: mode || null } : null;
    const base = { title: title.trim(), what: what.trim(), kind, narrative: narr, participants: parts, placeId: place || null, travel };
    if (init) {
      const patch: Record<string, unknown> = { ...base };
      if (start !== (init.start.original ?? init.start.label)) patch.start = { input: start };
      if (end !== (init.end.original ?? init.end.label)) patch.end = { input: end };
      await submit([{ op: 'event.update', id: init.id, patch: patch as never }]);
    } else await submit([{ op: 'event.add', event: { ...base, start: { input: start }, end: { input: end || start } } as never }]);
    onDone();
  };
  return <Shell title={init ? '编辑事件' : '新建事件'} onSubmit={save} onCancel={onDone} onRemove={init ? async () => { await submit([{ op: 'event.remove', id: init.id }]); onDone(); } : undefined}>
    <F label="标题"><input value={title} onChange={e => setTitle(e.target.value)} required autoFocus /></F>
    <F label="做什么"><textarea rows={2} value={what} onChange={e => setWhat(e.target.value)} /></F>
    <div className="cw-f2"><F label="类型"><select value={kind} onChange={e => setKind(e.target.value as WorldEvent['kind'])}>{EV_KIND.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></F>
      <F label="叙述性质"><select value={narr} onChange={e => setNarr(e.target.value as WorldEvent['narrative'])}>{NARR.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></F></div>
    <F label="开始" note="照原文写：1684-04-21 08:00、第 3 日 08:00、出城后三天……服务端来认"><input value={start} onChange={e => setStart(e.target.value)} placeholder="留空 = 时间未定" /></F>
    <F label="结束"><input value={end} onChange={e => setEnd(e.target.value)} placeholder="留空 = 和开始相同" /></F>
    <F label="地点"><select value={place} onChange={e => setPlace(e.target.value)}><option value="">未定</option>{places.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></F>
    <div className="cw-f2"><F label="从哪来（可空）"><select value={from} onChange={e => setFrom(e.target.value)}><option value="">—</option>{places.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></F>
      <F label="怎么来"><select value={mode} onChange={e => setMode(e.target.value)}><option value="">—</option>{modes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></F></div>
    <F label="参与者"><div className="cw-connects">{parts.map((p, i) => <div key={i} className="cw-row">
      <select value={p.entityId} onChange={e => setParts(ps => ps.map((x, k) => k === i ? { ...x, entityId: e.target.value } : x))}>{persons.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      <select value={p.as} onChange={e => setParts(ps => ps.map((x, k) => k === i ? { ...x, as: e.target.value as Participation } : x))}>{AS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <button type="button" className="rh-btn" onClick={() => setParts(ps => ps.filter((_, k) => k !== i))}>×</button></div>)}
      {persons.length > 0 && <button type="button" className="rh-btn" onClick={() => setParts(ps => [...ps, { entityId: persons.find(x => !ps.some(y => y.entityId === x.id))?.id ?? persons[0].id, as: 'actor' }])}>＋ 加一个人</button>}</div></F>
  </Shell>;
}

/* ———— 交通方式 / 规则 ———— */
export function ModeForm({ init, submit, onDone }: { init?: TransportMode; submit: Submit; onDone: () => void }) {
  const [name, setName] = useState(init?.name ?? ''), [kmh, setKmh] = useState(String(init?.kmPerHour ?? 4.5)), [net, setNet] = useState<TransportMode['network']>(init?.network ?? 'road'), [note, setNote] = useState(init?.note ?? '');
  return <Shell title={init ? '编辑交通方式' : '新建交通方式'} onCancel={onDone}
    onSubmit={async () => { await submit([{ op: 'mode.set', mode: { id: init?.id ?? `mode-${Date.now().toString(36)}`, name: name.trim(), kmPerHour: Number(kmh), network: net, ...(note.trim() ? { note: note.trim() } : {}) } }]); onDone(); }}
    onRemove={init ? async () => { await submit([{ op: 'mode.remove', id: init.id }]); onDone(); } : undefined}>
    <F label="名称"><input value={name} onChange={e => setName(e.target.value)} required autoFocus placeholder="步行、骑马、坐船……" /></F>
    <div className="cw-f2"><F label="速度（km/小时）"><input type="number" min="0.1" step="0.1" value={kmh} onChange={e => setKmh(e.target.value)} required /></F>
      <F label="走什么"><select value={net} onChange={e => setNet(e.target.value as TransportMode['network'])}><option value="road">路网</option><option value="water">水路</option><option value="any">不限</option><option value="none">不走路网</option></select></F></div>
    <F label="备注"><input value={note} onChange={e => setNote(e.target.value)} /></F>
  </Shell>;
}
export function RuleForm({ init, submit, onDone }: { init?: WorldRule; submit: Submit; onDone: () => void }) {
  const [text, setText] = useState(init?.text ?? '');
  return <Shell title={init ? '编辑规则' : '新建规则'} onCancel={onDone}
    onSubmit={async () => { await submit([{ op: 'rule.set', rule: { id: init?.id ?? `rule-${Date.now().toString(36)}`, text: text.trim(), machine: init?.machine ?? null } }]); onDone(); }}
    onRemove={init ? async () => { await submit([{ op: 'rule.remove', id: init.id }]); onDone(); } : undefined}>
    <F label="规则" note="写成一句话。程序还判不了的规则，检查里会显示「未覆盖」，不会让 AI 去猜"><textarea rows={3} value={text} onChange={e => setText(e.target.value)} required autoFocus /></F>
  </Shell>;
}

/* ———— 改造层 ———— */
const EFFECTS: [MapEdit['effect'], string][] = [['add', '新增（城墙、古道、建筑……）'], ['hide', '隐藏一片底图'], ['rename', '改名'], ['restyle', '改样式'], ['passability', '通行变化（拆桥、封路）']];
const STYLES: [NonNullable<NonNullable<MapEdit['props']>['style']>, string][] = [['ancient_road', '古道'], ['road', '道路'], ['wall', '城墙'], ['water', '水道'], ['building', '建筑'], ['area', '区域'], ['mark', '标记']];
export function EditForm({ init, places, modes, submit, onDone, draw }: { init?: MapEdit; places: Entity[]; modes: TransportMode[]; submit: Submit; onDone: () => void; draw: DrawReq }) {
  const [title, setTitle] = useState(init?.title ?? ''), [effect, setEffect] = useState<MapEdit['effect']>(init?.effect ?? 'add');
  const [geo, setGeo] = useState<Geo | null>((init?.geometry as Geo) ?? null), [area, setArea] = useState<GeoJSON.Polygon | null>(init?.target?.area ?? null), [placeId, setPlaceId] = useState(init?.target?.placeId ?? '');
  const [name, setName] = useState(init?.props?.name ?? ''), [style, setStyle] = useState(init?.props?.style ?? 'ancient_road');
  const [pass, setPass] = useState<'none' | 'open' | 'closed'>(init?.passable ? (init.passable.open ? 'open' : 'closed') : effect === 'passability' ? 'closed' : 'none');
  const [passModes, setPassModes] = useState<string[]>(init?.passable?.modeIds ?? []);
  const [from, setFrom] = useState(init?.valid.from?.original ?? init?.valid.from?.label ?? ''), [to, setTo] = useState(init?.valid.to?.original ?? init?.valid.to?.label ?? '');
  const save = async () => {
    const target = effect === 'add' ? null : { ...(area ? { area } : {}), ...(placeId ? { placeId } : {}), ...(init?.target?.osm ? { osm: init.target.osm } : {}) };
    const body = {
      title: title.trim(), effect, target, geometry: effect === 'add' ? geo : null,
      props: { ...(name.trim() ? { name: name.trim() } : {}), ...(effect === 'add' || effect === 'restyle' ? { style } : {}) },
      passable: pass === 'none' ? null : { open: pass === 'open', ...(passModes.length ? { modeIds: passModes } : {}) },
      valid: { from: from.trim() ? { input: from.trim() } : null, to: to.trim() ? { input: to.trim() } : null },
    };
    await submit([init ? { op: 'edit.update', id: init.id, patch: body as never } : { op: 'edit.add', edit: body as never }]); onDone();
  };
  return <Shell title={init ? '编辑改造层' : '新建改造层'} onSubmit={save} onCancel={onDone} onRemove={init ? async () => { await submit([{ op: 'edit.remove', id: init.id }]); onDone(); } : undefined}>
    <F label="名称"><input value={title} onChange={e => setTitle(e.target.value)} required autoFocus placeholder="比如：村口旧桥被冲垮" /></F>
    <F label="做什么"><select value={effect} onChange={e => setEffect(e.target.value as MapEdit['effect'])}>{EFFECTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></F>
    {effect === 'add' ? <>
      <F label="画出来" note={geoText(geo)}><span className="cw-row">
        <button type="button" className="rh-btn" onClick={async () => { const g = await draw('line', `画「${title || '新路'}」`); if (g) setGeo(g); }}>画线</button>
        <button type="button" className="rh-btn" onClick={async () => { const g = await draw('polygon', `圈「${title || '新区域'}」`); if (g) setGeo(g); }}>画面</button>
        <button type="button" className="rh-btn" onClick={async () => { const g = await draw('point', `点出「${title || '新地物'}」`); if (g) setGeo(g); }}>点</button></span></F>
      <div className="cw-f2"><F label="显示名"><input value={name} onChange={e => setName(e.target.value)} /></F>
        <F label="样式"><select value={style} onChange={e => setStyle(e.target.value as never)}>{STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></F></div>
    </> : <>
      <F label="对象：世界观里的地点"><select value={placeId} onChange={e => setPlaceId(e.target.value)}><option value="">—</option>{places.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></F>
      <F label="或者圈一块底图" note={area ? `已圈 · ${area.coordinates[0].length - 1} 个点` : '隐藏、改名底图上的东西时用'}><span className="cw-row">
        <button type="button" className="rh-btn" onClick={async () => { const g = await draw('polygon', '圈出要改的那一块'); if (g?.type === 'Polygon') setArea(g); }}>圈一块</button>
        {area && <button type="button" className="rh-btn" onClick={() => setArea(null)}>清掉</button>}</span></F>
      {(effect === 'rename') && <F label="新名字"><input value={name} onChange={e => setName(e.target.value)} /></F>}
      {(effect === 'restyle') && <F label="样式"><select value={style} onChange={e => setStyle(e.target.value as never)}>{STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></F>}
    </>}
    <F label="通行" note="外观和通行分开：隐藏一条路不等于封路"><select value={pass} onChange={e => setPass(e.target.value as never)}><option value="none">不影响通行</option><option value="open">能走</option><option value="closed">不能走</option></select></F>
    {pass !== 'none' && modes.length > 0 && <F label="只对这些交通方式（不选 = 全部）"><span className="cw-row">{modes.map(m => <label key={m.id} className="cw-check"><input type="checkbox" checked={passModes.includes(m.id)} onChange={e => setPassModes(s => e.target.checked ? [...s, m.id] : s.filter(x => x !== m.id))} />{m.name}</label>)}</span></F>}
    <div className="cw-f2"><F label="从故事里哪天起" note="留空 = 一直"><input value={from} onChange={e => setFrom(e.target.value)} placeholder="1684-04-22" /></F>
      <F label="到哪天为止"><input value={to} onChange={e => setTo(e.target.value)} placeholder="留空 = 一直" /></F></div>
  </Shell>;
}
