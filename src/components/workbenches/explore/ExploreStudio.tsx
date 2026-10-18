import { useEffect, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../BenchFrame';
import AgentDock, { type DockDraft, type DockEvent } from '../AgentDock';
import Explorer, { type ExplorerSection, type ExplorerViewDef } from '../engineering/Explorer';
import type { BenchProps } from '../WorkbenchStudio';
import { DATE, DATE_LABEL, KIND_LABEL, LOOKS, MODEL, NOTES, PLANS, SHOTS, SPOTS, sunFor, WEATHER, type Note, type Shot, type Spot } from './model';
import { dayTimes, hm, lightOf } from './sun';
import PlanFace from './PlanFace';
import SpotFace from './SpotFace';
import FieldFace, { type Proposal } from './FieldFace';
import ReviewFace, { type Lesson } from './ReviewFace';
import { Photo, SCENE_OF } from './Figures';
import '../engineering/dev.css';
import './explore.css';

// 探索台 EXPL：生成一份「拍照计划」——机位、时间、天气、给模特的引导词与出图提示词、服饰参考。
// 01 计划：矢量地图 + 太阳方位 + 一天的光线 / 天气 / 机位时间线；生成拍照计划书。
// 02 机位：Canvas 2D 的 2.5D 白模看光线与影子、机位视角取景；参数、构图、引导词、样片、服饰、规定。
// 03 现场：现在该拍什么、倒计时、快速记录；下雨 / 晚到 / 人多时由助手重排（应用前不改计划）。
// 04 回顾：照片落回地图、计划与实际对照、精选；整理观察与游记；经验写回计划；交给创作台 / 研究台 / 自动化台。全部为前端示例。

type Face = 'plan' | 'spot' | 'field' | 'review';
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `e${++seq}`;
const VIEWS: ExplorerViewDef[] = [
  { id: 'plans', label: '计划与机位', icon: <svg viewBox="0 0 24 24"><path d="M12 21s-6-6.5-6-11a6 6 0 0 1 12 0c0 4.5-6 11-6 11z" /><circle cx="12" cy="10" r="2" /></svg> },
  { id: 'looks', label: '服饰', icon: <svg viewBox="0 0 24 24"><path d="M12 6a2 2 0 1 1 2-2M12 6v2L3 15h18l-9-7" /></svg> },
];

export default function ExploreStudio({ file, reduced, chrome }: BenchProps) {
  const [face, setFace] = useState<Face>('plan');
  const [spots, setSpots] = useState<Spot[]>(() => SPOTS.map(s => ({ ...s, rules: [...s.rules] })));
  const [sel, setSel] = useState('P1');
  const [t, setT] = useState(7 * 60 + 30);
  const [view, setView] = useState<'map' | 'doc'>('map');
  const [book, setBook] = useState(0);
  const [mode, setMode] = useState<'orbit' | 'camera'>('orbit');
  const [samples, setSamples] = useState<Record<string, number[]>>({});
  const [lineSet, setLineSet] = useState(0);
  const [now, setNow] = useState(10 * 60 + 25);
  const [done, setDone] = useState<string[]>(['P1', 'P2']);
  const [fieldNotes, setFieldNotes] = useState<Note[]>(() => NOTES.filter(n => n.at < 10 * 60));
  const [proposal, setProposal] = useState<(Proposal & { apply: () => void }) | null>(null);
  const [shots, setShots] = useState<Shot[]>(SHOTS);
  const [organized, setOrganized] = useState(false);
  const [rtab, setRtab] = useState<'picks' | 'notes' | 'next'>('picks');
  const [lessons, setLessons] = useState<string[]>([]);
  const [handed, setHanded] = useState<string[]>([]);
  const [shotOpen, setShotOpen] = useState<Shot | null>(null);
  const [busy, setBusy] = useState(false);
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState('plans');
  const [ev, setEv] = useState<Record<Face, DockEvent[]>>(() => ({
    plan: [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是拍照计划助手。{DATE_LABEL} 京都东山：日出 06:14、日落 17:08，14 点前后有阵雨可能。6 个机位已经按光线排好；拖底部时间线可以看太阳在地图上怎么走。要我写一份完整的拍照计划书吗？</p> }],
    spot: [{ id: uid(), kind: 'agent', at: clock(), text: <p>这里看单个机位：白模里的影子跟着时间走，「机位视角」按镜头焦距取景。右边是给模特的引导词和出图提示词，可以先生成样片看看。</p> }],
    field: [{ id: uid(), kind: 'agent', at: clock(), text: <p>现场模式。我按模拟时间告诉你现在该拍什么；遇到下雨、晚到、人多，点「情况变了」，我先给调整方案，你点应用才会改。</p> }],
    review: [{ id: uid(), kind: 'agent', at: clock(), text: <p>拍完了：{SHOTS.length} 张照片已按位置落回地图，时间线上叠了实际轨道。现场记了 {NOTES.length} 条，要我按主题整理成观察笔记和游记吗？</p> }],
  }));
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? 30 : ms)); };
  const faceRef = useRef(face); faceRef.current = face;
  const push = (e: DockDraft, f: Face = faceRef.current) => { const id = e.id ?? uid(); setEv(m => ({ ...m, [f]: [...m[f], { ...e, id } as DockEvent] })); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => setEv(m => Object.fromEntries(Object.entries(m).map(([k, l]) => [k, l.map(e => e.id === id ? { ...e, ...p } as DockEvent : e)])) as Record<Face, DockEvent[]>);
  const say = (text: ReactNode, f?: Face) => push({ kind: 'agent', text, at: clock() }, f);
  const tool = (action: string, label: string, ms: number, detail: string, then: () => void, f?: Face) => {
    setBusy(true); const id = push({ kind: 'tool', action, label, state: 'running' }, f); const t0 = performance.now();
    later(ms, () => { setBusy(false); patch(id, { state: 'done', ms: performance.now() - t0, detail } as Partial<DockEvent>); then(); });
  };
  const approve = (title: string, effects: string[], action: string, ok: () => void, f?: Face) => {
    const id = uid();
    push({ id, kind: 'approval', title, effects, action, risk: 'write', state: 'pending', onApprove: () => { patch(id, { state: 'approved' } as Partial<DockEvent>); ok(); }, onReject: () => { patch(id, { state: 'rejected' } as Partial<DockEvent>); say(<p>好，先不交。</p>, f); } }, f);
  };
  const s = spots.find(x => x.id === sel) ?? spots[0];
  const pick = (id: string) => { setSel(id); const p = spots.find(x => x.id === id); if (p) setT(p.start + Math.round(p.dur / 2)); };
  const order = [...spots].sort((a, b) => a.start - b.start);

  /* ———— 计划 ———— */
  const generate = () => {
    setView('doc'); setBook(0);
    tool('plan.write', `写拍照计划书 · ${spots.length} 个机位 · 光线 + 天气 + 服饰`, 400, '6 节', () => {}, 'plan');
    for (let i = 1; i <= 6; i++) later(450 + i * 520, () => setBook(i));
    later(450 + 7 * 520, () => say(<p>计划书写好了，6 节：概要、时间表、机位、服饰、天气预案、装备。4 号机位和 14 点的阵雨重叠，我在预案里写了备选。</p>, 'plan'));
  };
  const lightCheck = () => tool('plan.light_check', '按太阳位置检查每个机位的光线', 900, `${spots.length} 个机位`, () => push({ kind: 'card', body: <div className="ex-cardlist"><b>光线检查</b>{order.map(p => { const m = p.start + p.dur / 2, sun = sunFor(p, m), l = sun.blocked ? '被东山挡住' : lightOf(sun.az, sun.alt, p.dir);
    return <button key={p.id} onClick={() => { setFace('spot'); pick(p.id); }} data-warn={sun.blocked || /偏硬/.test(l) || undefined}><em>{p.no}</em><span>{hm(m)} · {l}</span><small>{Math.round(sun.az)}° / {sun.alt.toFixed(0)}°</small></button>; })}
    <p>1 号开拍时太阳刚翻过东山；3、4 号在正午附近光偏硬，已经靠拱廊遮挡和长焦压缩处理。</p></div> }, 'plan'), 'plan');
  const weatherCheck = () => tool('plan.weather', '对照逐时预报', 700, '1 处风险', () => { const w = WEATHER.find(x => x.rain >= 30)!; push({ kind: 'card', body: <div className="ex-cardlist"><b>天气风险</b><button onClick={() => { setFace('spot'); pick('P4'); }} data-warn><em>4</em><span>{w.h}:00 阵雨 {w.rain}% · 蹴上铁道</span><small>备选：疏水纪念馆</small></button><p>其他时段降水 ≤ 20%。预报是模拟数据，出发前一晚请用真实预报再看一次。</p></div> }, 'plan'); }, 'plan');

  /* ———— 机位 ———— */
  const sample = () => tool('spot.sample', `用出图提示词生成 ${s.no} 号样片 ×4`, 1300, '4 张 · 模拟生成', () => { setSamples(m => ({ ...m, [s.id]: [1, 2, 3, 4].map(i => s.no * 100 + i * 17 + (m[s.id]?.length ?? 0) * 3) })); say(<p>样片是「模拟生成」的占位图，用来对构图和配色，不代表真实效果。</p>, 'spot'); }, 'spot');
  const sendGraph = () => approve(`在自动化台新建工作流 · ${s.no} 号机位样片`, ['节点图模板：文生图 + 放大', `正向提示词：${s.prompt.slice(0, 48)}…`, '批次 4 · 竖横各 2'], 'automation.graph.create', () => say(<p>已在自动化台「节点」面建好工作流，提示词和尺寸都填好了，去那里按「排队运行」就能出图。</p>, 'spot'), 'spot');
  const copy = (text: string) => { navigator.clipboard?.writeText(text).catch(() => {}); say(<p>已复制：「{text.slice(0, 40)}{text.length > 40 ? '…' : ''}」</p>, faceRef.current); };

  /* ———— 现场 ———— */
  const situation = (k: 'rain' | 'late' | 'crowd') => {
    push({ kind: 'user', text: { rain: '下雨了', late: '我们晚到了 20 分钟', crowd: '这里人太多了' }[k], at: clock() }, 'field');
    const left = order.filter(p => !done.includes(p.id) && p.start + p.dur > now);
    tool('field.replan', '按此刻的位置、光线和预报重排后面的行程', 1100, `${left.length} 个机位受影响`, () => {
      let p: Proposal & { apply: () => void };
      if (k === 'rain') {
        const p4 = left.find(x => x.id === 'P4'), p5 = left.find(x => x.id === 'P5');
        p = { kind: k, title: '雨天方案：铁道换室内，冈崎取消', why: '雨带会持续到 15 点前后；铁道和水面在雨里出不了计划里的画面。祇园雨后的石板路和灯笼倒影反而更好，照常。', rows: [
          ...(p4 ? [{ id: 'P4', before: `${hm(p4.start)} 蹴上 · 倾斜铁道`, after: `${hm(p4.start)} ${p4.backup!.name}（室内砖拱）` }] : []),
          ...(p5 ? [{ id: 'P5', before: `${hm(p5.start)} 冈崎疏水`, after: '取消（雨后水面乱）' }] : []),
          { id: 'P6', before: '16:35 祇园白川', after: '照常 · 人站檐下，拍石板倒影' }],
          apply: () => setSpots(l => l.filter(x => !(x.id === 'P5' && p5)).map(x => x.id === 'P4' && p4 ? { ...x, name: `${x.backup!.name} · 雨天`, kind: 'portrait', crowd: 2, crowdNote: '室内，人少。' } : x)) };
      } else if (k === 'late') {
        const shift = left.filter(x => x.id !== 'P6');
        p = { kind: k, title: '晚到 20 分钟：顺延，压缩冈崎，守住傍晚', why: '祇园的金色时刻不能晚，所以 6 号不动；前面顺延 20 分钟，5 号冈崎从 30 分钟压到 10 分钟。', rows: shift.map(x => ({ id: x.id, before: `${hm(x.start)} · ${x.dur} 分`, after: x.id === 'P5' ? `${hm(x.start + 20)} · 10 分` : `${hm(x.start + 20)} · ${x.dur} 分` })),
          apply: () => setSpots(l => l.map(x => shift.some(y => y.id === x.id) ? { ...x, start: x.start + 20, dur: x.id === 'P5' ? 10 : x.dur } : x)) };
      } else {
        const c = left[0];
        p = { kind: k, title: c?.id === 'P3' ? '先拍上面的水渠步道，再回拱下' : '多停 10 分钟等空档', why: c?.id === 'P3' ? '水路阁上面的水渠步道是同一种红砖，几乎没人；10 分钟后团客走了再回拱下。' : '团客通常一批 10 分钟左右；后面顺延，6 号不动。', rows: c ? [{ id: c.id, before: `${hm(c.start)}–${hm(c.start + c.dur)}`, after: `${hm(c.start)}–${hm(c.start + c.dur + 10)}${c.id === 'P3' ? ' · 先拍水渠步道' : ''}` }, ...left.slice(1).filter(x => x.id !== 'P6').map(x => ({ id: x.id, before: hm(x.start), after: hm(x.start + 10) }))] : [],
          apply: () => setSpots(l => l.map(x => x.id === c?.id ? { ...x, dur: x.dur + 10 } : left.slice(1).some(y => y.id === x.id) && x.id !== 'P6' ? { ...x, start: x.start + 10 } : x)) };
      }
      setProposal(p); say(<p>{p.title}。右边是前后对照，点「应用」才会改计划。</p>, 'field');
    }, 'field');
  };

  /* ———— 回顾 ———— */
  const allNotes = [...NOTES, ...fieldNotes.filter(n => !NOTES.includes(n))].sort((a, b) => a.at - b.at);
  const organize = () => tool('review.organize', `整理 ${allNotes.length} 条现场记录 · 按主题归类 + 写游记`, 1600, `${new Set(allNotes.map(n => n.tag)).size} 个主题 · 游记 1 篇`, () => { setOrganized(true); setRtab('notes'); say(<p>按主题整理好了，游记草稿在最后。「下次」那一栏是从这些观察里提炼的经验，可以写回计划。</p>, 'review'); }, 'review');
  const lesson = (l: Lesson) => { setSpots(list => list.map(x => x.id !== l.spot ? x : { ...x, start: l.start ?? x.start, rules: l.rule ? [...x.rules, l.rule] : x.rules })); setLessons(v => [...v, l.id]); say(<p>写回了 {spots.find(x => x.id === l.spot)?.no} 号机位{l.start ? `：开拍时间改到 ${hm(l.start)}` : '：加了一条规定'}。下次用这份计划时会带上。</p>, 'review'); };
  const hand = (k: 'creative' | 'research' | 'automation') => {
    if (handed.includes(k)) return;
    const picks = shots.filter(x => x.pick).length;
    const cfg = { creative: [`交给创作台 · 作品集《东山 · 秋日》`, [`精选 ${picks} 张（含 EXIF 与机位）`, '每张附服饰与引导词', '在创作台新建作品草稿'], 'creative.import'], research: ['交给研究台 · 观察笔记写入 R—014', ['6 个主题 · 9 条证据', '游记草稿作为附录', '追加，不覆盖'], 'research.archive.append'], automation: ['交给自动化台 · 例程 WF-06 探索照片回收', [`${shots.length} 张照片按 GPS 归到机位`, '没有位置的放进「未归位」', '例程是草稿 v0.3，第一次运行仍需你确认'], 'automation.routine.run'] } as const;
    const [title, eff, act] = cfg[k];
    approve(title, [...eff], act, () => { setHanded(v => [...v, k]); say(<p>{title.split(' · ')[0]}：已完成（模拟）。</p>, 'review'); }, 'review');
  };

  const send = (text: string) => {
    const f = faceRef.current; push({ kind: 'user', text, at: clock() }, f);
    if (f === 'field') { if (/雨/.test(text)) return situation('rain'); if (/晚|迟/.test(text)) return situation('late'); if (/人多|人太多|挤/.test(text)) return situation('crowd'); }
    if (f === 'plan' && /计划书|生成|写/.test(text)) return generate();
    if (f === 'plan' && /光/.test(text)) return lightCheck();
    if (f === 'plan' && /天气|雨/.test(text)) return weatherCheck();
    if (f === 'review' && /整理|游记|观察/.test(text)) return organize();
    if (f === 'spot' && /样片|出图/.test(text)) return sample();
    later(400, () => say(<p>{s.no} 号 {s.name}：{hm(s.start)} 开拍，{s.lens} {s.ap}。{s.comp}</p>));
  };

  /* ———— 资源管理器 ———— */
  const sections: ExplorerSection[] = xpView === 'looks' ? LOOKS.map(l => ({ id: l.id, title: `${l.id} · ${l.name}`, body: <div className="ex-xplook"><span className="ex-palette">{l.palette.map(c => <i key={c} style={{ background: c }} />)}</span><ul>{l.items.map(x => <li key={x}>{x}</li>)}</ul><small>用于 {l.spots.map(id => spots.find(s => s.id === id)?.no).filter(Boolean).join('、')} 号{l.change ? ` · ${hm(l.change.at)} 换装` : ''}</small></div> }))
    : [
      { id: 'plans', title: '拍摄计划', count: PLANS.length, body: <div className="ex-list">{PLANS.map((p, i) => <button key={p.id} aria-current={i === 0 || undefined} data-off={i > 0 || undefined} title={i > 0 ? '示例只做了第一份' : undefined}><i /><span><b>{p.name}</b><small>{p.id} · {p.date} · {p.state}</small></span></button>)}</div> },
      { id: 'spots', title: '机位', count: spots.length, grow: true, body: <div className="ex-list">{order.map(p => <button key={p.id} aria-current={p.id === sel || undefined} onClick={() => pick(p.id)} data-kind={p.kind}>
        <em>{p.no}</em><span><b>{p.name}</b><small>{hm(p.start)} · {KIND_LABEL[p.kind]}{p.look ? ` · 服饰 ${p.look}` : ''}</small></span>{done.includes(p.id) && face === 'field' && <u>✓</u>}</button>)}</div> },
      { id: 'model', title: '模特', body: <p className="ex-model"><b>{MODEL.name}</b> · {MODEL.height}cm<br />{MODEL.note}</p> },
    ];
  const dt = dayTimes(DATE);
  const plan = face === 'plan' ? { stages: ['定机位', '查光线', '查天气', '写计划书'], current: book >= 6 ? 3 : 2 }
    : face === 'spot' ? { stages: ['看光线', '定构图', '引导词', '样片'], current: samples[s.id] ? 3 : 2 }
      : face === 'field' ? { stages: ['出发', '拍摄', '应变', '收工'], current: proposal ? 2 : done.length >= spots.length ? 3 : 1 }
        : { stages: ['挑片', '整理观察', '写回经验', '交出去'], current: handed.length ? 3 : lessons.length ? 2 : organized ? 1 : 0 };
  const suggestions = face === 'plan' ? [{ id: 'g', label: '生成拍照计划书', onClick: generate }, { id: 'l', label: '检查光线', onClick: lightCheck }, { id: 'w', label: '检查天气风险', onClick: weatherCheck }]
    : face === 'spot' ? [{ id: 's', label: '生成样片', onClick: sample }, { id: 'r', label: '换个顺序说引导词', onClick: () => { setLineSet(n => n + 1); say(<p>改成从静到动的顺序：先站定，再走动，模特更容易进入状态。</p>, 'spot'); } }, { id: 'c', label: '机位视角', onClick: () => setMode('camera') }]
      : face === 'field' ? [{ id: 'r', label: '下雨了', onClick: () => situation('rain') }, { id: 'l', label: '晚到 20 分钟', onClick: () => situation('late') }, { id: 'c', label: '人太多', onClick: () => situation('crowd') }]
        : [{ id: 'o', label: '整理观察', onClick: organize }, { id: 'n', label: '看下次的经验', onClick: () => setRtab('next') }];

  return <BenchFrame code="EXPL" section="006" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => setFace(id as Face)}
    faces={[{ id: 'plan', label: '计划', en: 'PLAN' }, { id: 'spot', label: '机位', en: 'SPOT', badge: spots.length }, { id: 'field', label: '现场', en: 'FIELD' }, { id: 'review', label: '回顾', en: 'REVIEW', badge: LESSONS_LEFT(lessons) }]}
    strip={<>{DATE_LABEL} <i>·</i> 日出 {hm(dt.sunrise)} <i>·</i> 日落 {hm(dt.sunset)} <i>·</i> {spots.length} 个机位</>}
    shutterLines={f => [`> mount ${f.en.toLowerCase()} · kyoto higashiyama`, `> sun ${hm(dt.sunrise)} → ${hm(dt.sunset)} · ${spots.length} spots`, '> ready']}
    status={<><span><i className="en-sq" />东山 · 秋日人像</span><span>机位 {spots.length}</span><span>模特 {MODEL.name}</span><span data-alert>14:00 阵雨 35%</span><span>太阳位置为真实计算 · 天气为模拟</span></>}>
    <div className="ex" data-face={face}>
      <Explorer code="EXPL" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} views={VIEWS} key={xpView} title="shoot/" sections={sections} />
      {face === 'plan' && <PlanFace spots={spots} sel={s.id} onSel={pick} t={t} onT={setT} view={view} onView={setView} book={book} onOpenSpot={() => setFace('spot')} onGenerate={generate} busy={busy} />}
      {face === 'spot' && <SpotFace spots={spots} s={s} onSel={pick} t={t} onT={setT} mode={mode} onMode={setMode} samples={samples[s.id] ?? []} onSample={sample} onSendGraph={sendGraph} onCopy={copy} lineSet={lineSet} />}
      {face === 'field' && <FieldFace spots={spots} now={now} onNow={setNow} done={done} busy={busy}
        onDone={id => { setDone(d => [...d, id]); say(<p>{spots.find(x => x.id === id)?.no} 号拍到了。</p>, 'field'); }}
        notes={fieldNotes} onNote={text => { const tag: Note['tag'] = /光|亮|暗|阴/.test(text) ? '光线' : /人|团|挤/.test(text) ? '人流' : /衣|色|围巾|服/.test(text) ? '服饰' : /雨|风|冷/.test(text) ? '天气' : '机位'; setFieldNotes(l => [...l, { at: now, text, tag, spot: order.find(p => now >= p.start && now < p.start + p.dur)?.id }]); }}
        onSituation={situation} proposal={proposal} onApply={() => { proposal?.apply(); setProposal(null); say(<p>已应用到计划，时间线和地图都更新了。</p>, 'field'); }} onDismiss={() => { setProposal(null); say(<p>好，按原计划。</p>, 'field'); }} />}
      {face === 'review' && <ReviewFace spots={spots} shots={shots} onPick={id => setShots(l => l.map(x => x.id === id ? { ...x, pick: !x.pick } : x))} notes={allNotes} organized={organized} onOrganize={organize}
        tab={rtab} onTab={setRtab} lessons={lessons} onLesson={lesson} handed={handed} onHand={hand} t={t} onT={setT} sel={s.id} onSel={pick} onOpenShot={setShotOpen} busy={busy} />}
      <AgentDock name={{ plan: '计划助手', spot: '机位助手', field: '现场助手', review: '回顾助手' }[face]} target={face === 'spot' ? `${s.no} · ${s.name}` : `X-061 · 东山 · 秋日人像`}
        plan={plan} suggestions={suggestions} events={ev[face]} busy={busy} onSend={send}
        placeholder={{ plan: '问计划，或「生成计划书」「检查光线」', spot: '问这个机位，或「生成样片」', field: '「下雨了」「晚到了」「人太多」', review: '「整理观察」，或问这一天' }[face]}
        footnote={face === 'field' ? '调整先给方案 · 你点应用才改' : face === 'review' ? '交给其他工作台需要你批准' : undefined} />
      {shotOpen && <div className="ex-light" onClick={() => setShotOpen(null)}><figure onClick={e => e.stopPropagation()}>
        <Photo seed={shotOpen.seed} scene={SCENE_OF[shotOpen.spot]} palette={LOOKS.find(l => l.id === (spots.find(x => x.id === shotOpen.spot)?.look ?? 'B'))?.palette} person={spots.find(x => x.id === shotOpen.spot)?.kind !== 'landscape'} night={shotOpen.spot === 'P6' && shotOpen.at > 17 * 60} />
        <figcaption><span className="rh-micro">{shotOpen.id} · {hm(shotOpen.at)}</span><b>{spots.find(x => x.id === shotOpen.spot)?.name ?? '雨天备选 · 疏水纪念馆'}</b><p>{'★'.repeat(shotOpen.rating)}{'☆'.repeat(3 - shotOpen.rating)}</p>
          <div><button className="rh-btn is-solid" onClick={() => { setShots(l => l.map(x => x.id === shotOpen.id ? { ...x, pick: !x.pick } : x)); setShotOpen(o => o && { ...o, pick: !o.pick }); }}>{shotOpen.pick ? '取消精选' : '加入精选'}</button><button className="rh-btn" onClick={() => setShotOpen(null)}>关闭</button></div></figcaption>
      </figure></div>}
    </div>
  </BenchFrame>;
}
const LESSONS_LEFT = (done: string[]) => 4 - done.length || undefined;
