import { useEffect, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../BenchFrame';
import AgentDock, { type DockDraft, type DockEvent, type Suggestion } from '../AgentDock';
import Explorer, { Tree, type ExplorerSection, type ExplorerView } from '../engineering/Explorer';
import Crosshair from '../engineering/Crosshair';
import type { BenchProps } from '../WorkbenchStudio';
import { AUDIT, ENTITIES, KIND, RELATIONS, TIMELINE, WORK, type Entity, type Issue, type Kind } from './world';
import { CHAPTERS, CONTINUE, SHOTS, TONES, type Chapter } from './novel';
import NovelFace, { MARKS } from './NovelFace';
import VideoFace from './VideoFace';
import '../engineering/dev.css';
import './creative.css';

// 创作台 CRTV：一部作品 = 世界观 → 小说 → 视频。世界观是创作台的「本体」，小说与视频都引用它。
// 01 世界观：关系图 / 年表 / 地图 + 设定卡（立绘、三视图为占位图，标「模拟生成」）+ 设定顾问（矛盾检查参照 CanonKit：人物 / 世界 / 情节 / 时间线）。
// 02 小说、03 视频按顺序随后设计。全部为前端示例。

type Face = 'world' | 'novel' | 'video';
type View = 'graph' | 'timeline' | 'map';
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `c${++seq}`;
const ent = (id: string) => ENTITIES.find(e => e.id === id)!;

export default function CreativeStudio({ file, reduced, chrome }: BenchProps) {
  const [face, setFace] = useState<Face>('world');
  const [view, setView] = useState<View>('graph');
  const [sel, setSel] = useState<string>('sam');
  const [audited, setAudited] = useState(false);
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [art, setArt] = useState<Record<string, number>>({ sam: 1, elanor: 1 }); // 立绘 / 三视图生成到第几版（0 = 未生成）
  const [ping, setPing] = useState<{ id: string; n: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>(() => JSON.parse(JSON.stringify(CHAPTERS)));
  const [scene, setScene] = useState('c3s2');
  const [novelView, setNovelView] = useState<'text' | 'beats'>('text');
  const [typing, setTyping] = useState<string | null>(null);
  const [shots, setShots] = useState(false);
  const faceRef = useRef<Face>('world'); faceRef.current = face;
  const [novelEvents, setNovelEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是写作助手。正文里的人物、地点、物件会自动对照世界观；把光标停在段末，我会给出补全，按 <kbd>Tab</kbd> 接受。试试第 3 章最后一段。</p> }]);
  const [events, setEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是《{WORK.title}》的设定顾问。世界观里有 {ENTITIES.length} 个实体、{RELATIONS.length} 条关系。小说和镜头里提到的人和物都会对照这里检查。要我先做一次「检查矛盾」吗？</p> }]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? 40 : ms)); };
  // 两个面各有自己的对话：动作发生在哪个面，事件就记在哪个面的助手里。
  const setFor = () => faceRef.current === 'novel' ? setNovelEvents : setEvents;
  const push = (e: DockDraft) => { const id = e.id ?? uid(); const set = setFor(); set(l => [...l, { ...e, id } as DockEvent]); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => { const f = (l: DockEvent[]) => l.map(e => e.id === id ? { ...e, ...p } as DockEvent : e); setEvents(f); setNovelEvents(f); };
  const say = (text: ReactNode) => push({ kind: 'agent', text, at: clock() });
  const pick = (id: string) => { setSel(id); setPing({ id, n: Date.now() }); };

  const open = audited ? AUDIT.filter(i => !resolved[i.id]) : [];
  const issuesOf = (id: string) => open.filter(i => i.ents.includes(id));
  const audit = () => {
    setBusy(true);
    const t = push({ kind: 'tool', action: 'continuity_audit', label: '检查矛盾 · 世界观 + 小说第 1–3 章 + 12 个镜头', state: 'running' }); const t0 = performance.now();
    later(1500, () => {
      setBusy(false); setAudited(true);
      patch(t, { state: 'done', ms: performance.now() - t0, detail: `${AUDIT.length} 条 · 人物 2 · 世界 1 · 情节 1 · 时间线 1` } as Partial<DockEvent>);
      push({ kind: 'card', body: <AuditCard issues={AUDIT} onPick={i => { pick(i.ents[0]); if (i.cat === '时间线') setView('timeline'); else if (i.id === 'A2') setView('graph'); }} /> });
      pick(AUDIT[0].ents[0]);
    });
  };
  const setText = (para: string, text: string) => setChapters(cs => cs.map(c => ({ ...c, scenes: c.scenes.map(sc => ({ ...sc, paras: sc.paras.map(p => p.id === para ? { ...p, text } : p) })) })));
  const paraText = (para: string) => chapters.flatMap(c => c.scenes.flatMap(sc => sc.paras)).find(p => p.id === para)?.text ?? '';
  const resolve = (i: Issue, choice: string) => {
    // 正文里的冲突：按选项直接改写原文片段。
    const m = MARKS[i.id], fix = m?.fixes[i.options.indexOf(choice)];
    if (m && fix) setText(m.para, paraText(m.para).replace(m.quote, fix));
    setResolved(r => ({ ...r, [i.id]: choice }));
    say(<p>已处理 <b>{i.id} · {i.title}</b>：{choice}。{/伏笔|主线/.test(choice) ? '我会在后续检查中把它当作有意的设定，不再提出。' : ''}</p>);
  };
  const gen = (id: string) => {
    const e = ent(id);
    const card = push({ kind: 'approval', action: 'gen_turnaround', title: `生成「${e.name}」的立绘与三视图`, effects: ['依据外貌设定生成 1 张立绘 + 正 / 侧 / 背三视图', '视频面生成镜头时会自动作为一致性参考', '模拟生成 · 约 ¥1.2'], risk: 'write', state: 'pending', onApprove: () => {}, onReject: () => {} });
    patch(card, { onApprove: () => { patch(card, { state: 'approved' } as Partial<DockEvent>); setBusy(true); const t = push({ kind: 'tool', action: 'gen_turnaround', label: `${e.name} · 立绘 + 三视图`, state: 'running' }); later(1600, () => { setBusy(false); setArt(a => ({ ...a, [id]: (a[id] ?? 0) + 1 })); patch(t, { state: 'done', ms: 1600, detail: '模拟生成 · 占位图' } as Partial<DockEvent>); setPing({ id, n: Date.now() }); }); }, onReject: () => patch(card, { state: 'rejected' } as Partial<DockEvent>) } as Partial<DockEvent>);
  };
  const onSend = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    const hit = ENTITIES.find(e => text.includes(e.name));
    if (/矛盾|检查|冲突/.test(text)) return audit();
    if (/三视图|立绘|生成/.test(text) && hit) return gen(hit.id);
    if (hit) { pick(hit.id); later(500, () => say(<p><b>{hit.name}</b>：{hit.tagline}。{hit.appears.length ? `出现于 ${hit.appears.join('、')}。` : ''}</p>)); return; }
    later(500, () => say(<p>可以让我：检查矛盾、为某个人物生成三视图，或者问某个实体的设定（比如「梅里是谁」）。</p>));
  };
  const reason = (i: Issue, text: string) => {
    push({ kind: 'user', text: `${i.id}：${text}`, at: clock() });
    later(700, () => { setResolved(r => ({ ...r, [i.id]: `说明：${text}` })); say(<p>理解，<b>{i.id}</b> 记为有意的写法，后续检查不再提出。</p>); });
  };
  const sceneOf = (id: string) => chapters.flatMap(c => c.scenes).find(x => x.id === id)!;
  const moveScene = (id: string, to: string, index: number) => setChapters(cs => {
    const sc = cs.flatMap(c => c.scenes).find(x => x.id === id)!; const without = cs.map(c => ({ ...c, scenes: c.scenes.filter(x => x.id !== id) }));
    return without.map(c => c.id === to ? { ...c, scenes: [...c.scenes.slice(0, index), sc, ...c.scenes.slice(index)] } : c);
  });
  const approve = (title: string, effects: string[], action: string, run: () => void) => {
    const card = push({ kind: 'approval', action, title, effects, risk: 'write', state: 'pending', onApprove: () => {}, onReject: () => {} });
    patch(card, { onApprove: () => { patch(card, { state: 'approved' } as Partial<DockEvent>); run(); }, onReject: () => patch(card, { state: 'rejected' } as Partial<DockEvent>) } as Partial<DockEvent>);
  };
  const continueScene = () => {
    const sc = sceneOf(scene), add = CONTINUE[scene] ?? '她在页边写下一行小字，又用拇指轻轻抹平，像怕吵醒什么。';
    approve(`续写「${sc.title}」`, ['在本场末尾追加 1 段', '对照世界观，不引入新实体'], 'write_continue', () => {
      const id = `x${Date.now()}`; setChapters(cs => cs.map(c => ({ ...c, scenes: c.scenes.map(x => x.id === scene ? { ...x, paras: [...x.paras, { id, text: '' }] } : x) })));
      setTyping(id); let k = 0; const step = () => { k += 2; setText(id, add.slice(0, k)); if (k < add.length) later(28, step); else setTyping(null); }; later(200, step);
    });
  };
  const retone = () => {
    const sc = sceneOf(scene), p = sc.paras[0], tone = TONES[0];
    approve(`改写语气 · ${tone.label}`, [`改写「${sc.title}」第一段`, '原文保留在历史里，可撤回'], 'write_retone', () => { setText(p.id, tone.apply(p.text)); say(<p>已改写成{tone.label}的版本。</p>); });
  };
  const toShots = () => approve('转为分镜 · 第 2 章', ['把「信使与客人」拆成 6 个镜头草稿', '带上出场人物与地点，发到视频面'], 'shot_from_scene', () => {
    setBusy(true); const t = push({ kind: 'tool', action: 'shot_from_scene', label: '第 2 章 → 6 个镜头', state: 'running' });
    later(1300, () => { setBusy(false); setShots(true); patch(t, { state: 'done', ms: 1300, detail: '视频面已解锁' } as Partial<DockEvent>);
      push({ kind: 'card', body: <div className="cr-shots"><span className="rh-micro">SHOT LIST · 镜头草稿 · 发到视频面</span>{SHOTS.map(x => <div key={x.no}><em>{x.no}</em><b>{x.size} · {x.move}</b><span>{x.desc}</span><small>{x.secs}s</small></div>)}</div> }); });
  });
  const novelSend = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    if (/续写/.test(text)) return continueScene();
    if (/语气|改写/.test(text)) return retone();
    if (/分镜/.test(text)) return toShots();
    if (/检查|一致|矛盾/.test(text)) return audit();
    later(500, () => say(<p>我可以：续写本场、改写语气、一致性检查、把一章转为分镜。</p>));
  };
  const cur = ent(sel);
  const suggestions: Suggestion[] = [
    { id: 'a', label: audited ? '重新检查矛盾' : '检查矛盾', onClick: audit },
    ...(cur.kind === 'person' ? [{ id: 'g', label: `生成「${cur.name}」三视图`, onClick: () => gen(cur.id) }] : []),
    { id: 'q', label: '「西去」是什么规则？', onClick: () => onSend('西去 是什么规则') },
  ];

  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState<ExplorerView>('files');
  const sections: ExplorerSection[] = [{ id: 'index', title: `《${WORK.title}》 · 条目索引`, count: ENTITIES.length, grow: true, body: <Tree
    nodes={(Object.keys(KIND) as Kind[]).map(k => ({ name: KIND[k].zh, path: k, children: ENTITIES.filter(e => e.kind === k).map(e => ({ name: e.name, path: e.id, ext: k === 'person' ? '人' : k === 'place' ? '地' : k === 'faction' ? '势' : k === 'object' ? '物' : '规', meta: <span className="cr-xp-meta" data-bad={issuesOf(e.id).length > 0 || undefined}>{issuesOf(e.id).length ? '▲ 冲突' : `${e.appears.length} 处`}</span> })) }))}
    active={sel} onOpen={id => { if (ENTITIES.some(e => e.id === id)) pick(id); }} /> },
    { id: 'tl', title: '年表', count: TIMELINE.length, body: <div className="dv-xp-list">{TIMELINE.map(t => <button key={t.text} onClick={() => { setView('timeline'); if (t.who[0]) pick(t.who[0]); }}><b>{Math.floor(t.year)}</b><small>{t.text}</small></button>)}</div> },
  ];

  return <BenchFrame code="CRTV" section="004" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => { if (id === 'video' && !shots) return; setFace(id as Face); }}
    faces={[{ id: 'world', label: '世界观', en: 'WORLD', badge: open.length }, { id: 'novel', label: '小说', en: 'NOVEL', badge: open.filter(i => MARKS[i.id]).length }, { id: 'video', label: '视频', en: 'VIDEO', locked: !shots, badge: shots ? SHOTS.length : 0 }]}
    strip={<>《{WORK.title}》 <i>·</i> {WORK.genre} <i>·</i> 实体 {ENTITIES.length} <i>·</i> 冲突 {open.length}</>}
    shutterLines={f => [`> open work · ${WORK.title}`, `> face · ${f.en.toLowerCase()}`, '> ready']}
    status={<><span><i className="en-sq" />《{WORK.title}》</span><span>人物 {ENTITIES.filter(e => e.kind === 'person').length}</span><span>地点 {ENTITIES.filter(e => e.kind === 'place').length}</span><span data-alert={open.length > 0 || undefined}>设定冲突 {open.length}</span><span>示例数据 · 不连接模型</span></>}>
    {face === 'novel' ? <div className="cr rh">
      <Explorer code="CRTV" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title="novel/" badges={{ files: open.filter(i => MARKS[i.id]).length || undefined }}
        sections={[{ id: 'toc', title: `《${WORK.title}》 · 卷一`, grow: true, body: <Tree nodes={chapters.map(c => ({ name: `${c.no} ${c.title}`, path: c.id, children: c.scenes.map(x => ({ name: x.title, path: x.id, ext: '场', meta: <span className="cr-xp-meta">{x.paras.reduce((n, p) => n + p.text.length, 0)} 字</span> })) }))} active={scene} onOpen={id => { if (chapters.some(c => c.scenes.some(x => x.id === id))) setScene(id); }} /> },
          { id: 'world', title: '世界观引用', count: ENTITIES.length, folded: true, body: <div className="dv-xp-list">{ENTITIES.filter(e => e.kind === 'person').map(e => <div key={e.id}><b>{e.name}</b><small>{e.tagline}</small></div>)}</div> }]} />
      <section className="cr-center" data-wb-panel>
        <header className="dv-bar cr-bar">
          <div className="dv-bar-id"><b>NOVEL</b><small>小说<br />MANUSCRIPT</small></div>
          <div className="cr-work"><small>WORK · {WORK.genre} · 卷一</small><strong>《{WORK.title}》</strong><span>{chapters.reduce((n, c) => n + c.scenes.reduce((m, x) => m + x.paras.reduce((k, p) => k + p.text.length, 0), 0), 0)} 字 · {chapters.length} 章 · {chapters.reduce((n, c) => n + c.scenes.length, 0)} 场</span></div>
          <div className="rq-seg cr-seg" role="group" aria-label="视图"><button aria-pressed={novelView === 'text'} onClick={() => setNovelView('text')}><b>¶</b>正文</button><button aria-pressed={novelView === 'beats'} onClick={() => setNovelView('beats')}><b>▦</b>节拍板</button></div>
        </header>
        <div className="cr-novel" key={novelView}><NovelFace chapters={chapters} setText={setText} moveScene={moveScene} scene={scene} setScene={setScene} issues={open} onResolve={(i, c) => resolve(i, c)} onReason={reason} typing={typing} view={novelView} /></div>
      </section>
      <AgentDock name="写作助手" target={`《${WORK.title}》 · ${sceneOf(scene).title}`} plan={{ stages: ['起草', '一致性检查', '处理标注', '转为分镜'], current: shots ? 3 : audited ? (open.some(i => MARKS[i.id]) ? 2 : 3) : 0 }}
        suggestions={[{ id: 'c', label: '续写本场', onClick: continueScene }, { id: 't', label: '改写语气 · 更克制', onClick: retone }, { id: 'a', label: audited ? '重新检查一致性' : '一致性检查', onClick: audit }, { id: 's', label: shots ? '分镜已发到视频面' : '转为分镜 →', onClick: toShots }]}
        events={novelEvents} busy={busy} onSend={novelSend} placeholder="例如：续写本场 · 改写语气 · 转为分镜" />
    </div> : face === 'video' ? <VideoFace shots={SHOTS} art={art} reduced={reduced} /> : <div className="cr rh">
      <Explorer code="CRTV" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title="world/" sections={sections} badges={{ files: open.length || undefined }} />
      <section className="cr-center" data-wb-panel>
        <header className="dv-bar cr-bar">
          <div className="dv-bar-id"><b>WORLD</b><small>世界观<br />CANON</small></div>
          <div className="cr-work"><small>WORK · {WORK.genre}</small><strong>《{WORK.title}》</strong><span>{WORK.logline}</span></div>
          <div className="rq-seg cr-seg" role="group" aria-label="视图">{([['graph', '◎', '关系图'], ['timeline', '—', '年表'], ['map', '⌖', '地图']] as [View, string, string][]).map(([v, g, l]) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}><b>{g}</b>{l}</button>)}</div>
        </header>
        <div className="cr-body">
          <div className="cr-view" key={view}>
            {view === 'graph' ? <Graph sel={sel} onPick={pick} flagged={id => issuesOf(id).length > 0} audited={audited} resolved={resolved} />
              : view === 'timeline' ? <Timeline sel={sel} onPick={pick} flagAge={audited && !resolved.A1} fixed={resolved.A1} />
              : <MapView sel={sel} onPick={pick} />}
          </div>
          <EntityCard key={sel} e={cur} art={art[cur.id] ?? 0} issues={issuesOf(cur.id)} ping={ping?.id === cur.id ? ping.n : 0} onGen={() => gen(cur.id)} onPick={pick} onResolve={resolve} />
        </div>
      </section>
      <AgentDock name="设定顾问" target={`《${WORK.title}》 · ${ENTITIES.length} 个实体 · 冲突 ${open.length}`} plan={{ stages: ['建立条目', '检查矛盾', '补全设定', '交给小说'], current: audited ? (open.length ? 1 : 2) : 0 }}
        suggestions={suggestions} events={events} busy={busy} onSend={onSend} placeholder="例如：检查矛盾 · 生成伊拉诺的三视图 · 梅里是谁" />
    </div>}
  </BenchFrame>;
}

/* ———— 关系图 ———— */
function Graph({ sel, onPick, flagged, audited, resolved }: { sel: string; onPick: (id: string) => void; flagged: (id: string) => boolean; audited: boolean; resolved: Record<string, string> }) {
  const people = ENTITIES.filter(e => e.kind === 'person');
  const rels = [...RELATIONS, ...(resolved.A2 && !/保留/.test(resolved.A2) ? [{ a: 'sam', b: 'merry', label: '每年夏天的客人' }] : [])];
  return <div className="cr-graph">
    <Crosshair />
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{rels.map(r => { const a = ent(r.a), b = ent(r.b); const one = 'oneWay' in r && r.oneWay && audited && !resolved.A2; return <line key={r.a + r.b} x1={a.x} y1={a.y} x2={b.x} y2={b.y} data-sel={r.a === sel || r.b === sel || undefined} data-bad={one || undefined} vectorEffect="non-scaling-stroke" />; })}</svg>
    {rels.map(r => { const a = ent(r.a), b = ent(r.b); return <span key={'l' + r.a + r.b} className="cr-elabel" data-sel={r.a === sel || r.b === sel || undefined} style={{ left: `${(a.x! + b.x!) / 2}%`, top: `${(a.y! + b.y!) / 2}%` }}>{r.label}{'oneWay' in r && r.oneWay ? ' →' : ''}</span>; })}
    {people.map((p, i) => <button key={p.id} className="cr-person" aria-current={p.id === sel || undefined} data-bad={flagged(p.id) || undefined} style={{ left: `${p.x}%`, top: `${p.y}%`, animationDelay: `${i * 60}ms` }} onClick={() => onPick(p.id)}>
      <Portrait id={p.id} small /><b>{p.name}</b><small>{p.tagline}</small>{flagged(p.id) && <i>▲</i>}</button>)}
  </div>;
}

/* ———— 年表 ———— */
function Timeline({ sel, onPick, flagAge, fixed }: { sel: string; onPick: (id: string) => void; flagAge: boolean; fixed?: string }) {
  const people = ENTITIES.filter(e => e.kind === 'person');
  const lanes = [{ id: 'world', name: '世界' }, ...people.map(p => ({ id: p.id, name: p.name }))];
  const x = (i: number) => 6 + (i / (TIMELINE.length - 1)) * 88;
  return <div className="cr-timeline">
    <div className="cr-tl-axis">{TIMELINE.map((t, i) => <span key={i} style={{ left: `${x(i)}%` }}><b>{t.year % 1 ? `${Math.floor(t.year)} 秋` : t.year}</b></span>)}</div>
    {lanes.map(l => <div key={l.id} className="cr-lane" data-sel={l.id === sel || undefined}><em onClick={() => l.id !== 'world' && onPick(l.id)}>{l.name}</em>
      <div>{TIMELINE.map((t, i) => (l.id === 'world' ? t.who.length === 0 : t.who.includes(l.id)) && <button key={i} className="cr-ev" data-end={i >= TIMELINE.length - 2 || undefined} data-flag={flagAge && t.flag === 'age' && l.id === 'sam' || undefined} style={{ left: `${x(i)}%` }} onClick={() => l.id !== 'world' && onPick(l.id)} title={t.text}><i />{l.id === 'world' || l.id === sel ? <span>{t.flag === 'age' && fixed?.includes('四十一') ? t.text.replace('三十出头的山姆', '四十一岁的山姆') : t.text}</span> : null}</button>)}</div></div>)}
    {flagAge && <p className="cr-tl-note">■ 时间线冲突：山姆生于 1380 年，1421 年应是 41 岁，年表却写「三十出头」。</p>}
  </div>;
}

/* ———— 地图 ———— */
function MapView({ sel, onPick }: { sel: string; onPick: (id: string) => void }) {
  const places = ENTITIES.filter(e => e.map);
  return <div className="cr-map">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path className="cr-sea" d="M0 72 C 18 66, 26 82, 44 76 S 72 62, 100 70 L100 100 L0 100 Z" />
      <path className="cr-coast" d="M0 72 C 18 66, 26 82, 44 76 S 72 62, 100 70" vectorEffect="non-scaling-stroke" />
      {[[62, 66, 76], [66, 70, 82], [70, 64, 86]].map(([x1, y1, y2], i) => <line key={i} x1={x1} y1={y1} x2={x1 + 2} y2={y2} className="cr-pier" vectorEffect="non-scaling-stroke" />)}
      {Array.from({ length: 9 }, (_, i) => <path key={i} className="cr-contour" d={`M0 ${20 + i * 5} C 30 ${14 + i * 5}, 60 ${28 + i * 5}, 100 ${18 + i * 5}`} vectorEffect="non-scaling-stroke" />)}
    </svg>
    <i className="cr-fog" /><i className="cr-fog is-2" />
    {places.map(p => <button key={p.id} className="cr-place" aria-current={p.id === sel || undefined} style={{ left: `${p.map![0]}%`, top: `${p.map![1]}%` }} onClick={() => onPick(p.id)}><i /><b>{p.name}</b><small>{p.tagline}</small></button>)}
    <span className="cr-map-legend rh-micro">中洲西北 · 手绘示意（非比例）· 海雾每 40 秒漂过一次</span>
  </div>;
}

/* ———— 设定卡 ———— */
function EntityCard({ e, art, issues, ping, onGen, onPick, onResolve }: { e: Entity; art: number; issues: Issue[]; ping: number; onGen: () => void; onPick: (id: string) => void; onResolve: (i: Issue, c: string) => void }) {
  const rels = RELATIONS.filter(r => r.a === e.id || r.b === e.id);
  return <aside className="cr-card">
    {ping ? <i className="en-flashring" key={ping} /> : null}
    <header><span className="rh-micro">{KIND[e.kind].en} · {KIND[e.kind].zh}</span><h2>{e.name}</h2><p>{e.tagline}</p></header>
    {e.kind === 'person' && <section className="cr-art">
      <div className="cr-portrait"><Portrait id={e.id} gen={art} /><span className="cr-sim">{art ? `模拟生成 · v${art}` : '未生成'}</span></div>
      <div className="cr-turn">{['正', '侧', '背'].map((v, i) => <figure key={v}><Silhouette view={i} gen={art} /><figcaption>{v}</figcaption></figure>)}</div>
      <button className="rh-btn" onClick={onGen}>{art ? '重新生成三视图' : '生成立绘与三视图'}</button>
    </section>}
    {issues.map(i => <section key={i.id} className="cr-issue"><span className="rh-micro">▲ {i.cat} · {i.id} · {i.where}</span><b>{i.title}</b><p>{i.detail}</p>
      <div>{i.options.map((o, k) => <button key={o} onClick={() => onResolve(i, o)}><em>{String.fromCharCode(65 + k)}</em>{o}</button>)}</div></section>)}
    <dl>{e.facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    {e.voice && <section className="cr-voice"><span className="rh-micro">VOICE · 声线</span><p>{e.voice}</p><span className="cr-wave" aria-hidden="true">{Array.from({ length: 28 }, (_, i) => <i key={i} style={{ transform: `scaleY(${.25 + Math.abs(Math.sin(i * 1.7 + e.id.length)) * .75})` }} />)}</span><small>试听 · 模拟</small></section>}
    {rels.length > 0 && <section className="cr-rels"><span className="rh-micro">RELATIONS · 关系</span>{rels.map(r => { const other = r.a === e.id ? r.b : r.a; return <button key={r.a + r.b} onClick={() => onPick(other)}><b>{ent(other).name}</b><span>{r.label}{r.oneWay && r.a !== e.id ? '（对方单方面）' : ''}</span></button>; })}</section>}
    <section className="cr-appears"><span className="rh-micro">APPEARS IN · 出现于</span><div>{e.appears.map(a => <span key={a} data-video={/镜/.test(a) || undefined}>{a}</span>)}</div></section>
  </aside>;
}

/** 占位立绘：斜线底 + 剪影，标「模拟生成」。 */
function Portrait({ id, small, gen = 1 }: { id: string; small?: boolean; gen?: number }) {
  const hue = (id.charCodeAt(0) * 7) % 5;
  return <span className="cr-ph" data-small={small || undefined} data-empty={!gen || undefined} data-tone={hue}>
    <svg viewBox="0 0 40 48" aria-hidden="true"><circle cx="20" cy="17" r="8" /><path d="M5 48 C 6 32, 34 32, 35 48 Z" /></svg>
  </span>;
}
function Silhouette({ view, gen }: { view: number; gen: number }) {
  return <span className="cr-ph cr-sil" data-empty={!gen || undefined}><svg viewBox="0 0 20 48" aria-hidden="true">
    {view === 1 ? <><ellipse cx="10" cy="7" rx="3.4" ry="4" /><path d="M8 12 L12 12 L13 30 L12 47 L9 47 L8 30 Z" /></> : <><circle cx="10" cy="7" r="4" /><path d="M4 13 L16 13 L17 30 L14 47 L11 47 L10 32 L9 47 L6 47 L3 30 Z" />{view === 2 && <path d="M6 13 L14 13 L13 20 L7 20 Z" className="cr-back" />}</>}
  </svg></span>;
}

function AuditCard({ issues, onPick }: { issues: Issue[]; onPick: (i: Issue) => void }) {
  return <div className="cr-audit"><span className="rh-micro">CONTINUITY AUDIT · 参照 CanonKit 的问题类型</span>
    {issues.map(i => <button key={i.id} onClick={() => onPick(i)}><em data-cat={i.cat}>{i.cat}</em><span><b>{i.id} · {i.title}</b><small>{i.where}</small></span></button>)}</div>;
}
