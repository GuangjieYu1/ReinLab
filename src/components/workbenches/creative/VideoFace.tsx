import { useEffect, useRef, useState, type ReactNode } from 'react';
import AgentDock, { type DockDraft, type DockEvent, type Suggestion } from '../AgentDock';
import Explorer, { type ExplorerSection, type ExplorerView } from '../engineering/Explorer';
import { Mobius } from '../../rhine/RhineMark';
import Viewport, { lerp3 } from './Viewport';
import { ENTITIES } from './world';
import type { Shot } from './novel';
import { AUTO_CAMS, CHARS, DIALOGUE, LIGHTS0, PRICE, PRIMS, SCENE_PROMPT, type Cam, type Char, type Light, type V3 } from './videoModel';

// 创作台 · 视频面：参照 Intangible 的 Build → Compose → Visualize。
// 01 一句话搭白模（基本体逐个落入）→ 02 导演助手按镜头表自动摆机位、写运镜，可拖人物、拖机位、切到机位视角预演
// → 03 每镜生成成片（占位图 +「模拟生成」，带价格需审批），候选 v1–v4，可与白模叠加对比。底部画面 · 对白 · 音乐三轨时间轴。

type Mode = 'editor' | 'camera' | 'final' | 'overlay';
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let seq = 0; const uid = () => `v${++seq}`;
const easeIO = (t: number) => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

export default function VideoFace({ shots, art, reduced }: { shots: Shot[]; art: Record<string, number>; reduced: boolean }) {
  const [buildAt, setBuildAt] = useState<number | null>(null);
  const [prompt, setPrompt] = useState(SCENE_PROMPT);
  const [chars, setChars] = useState<Char[]>(CHARS);
  const [cams, setCams] = useState<Record<string, Cam>>({});
  const [lights, setLights] = useState<Record<string, Light>>(LIGHTS0);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>('editor');
  const [selChar, setSelChar] = useState<string | null>(null);
  const [finals, setFinals] = useState<Record<string, { v: number; pick: number }>>({});
  const [queue, setQueue] = useState<string[]>([]);
  const [spent, setSpent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);                 // 播放头（秒）
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是导演助手。小说面送来了第 2 章的 {shots.length} 个镜头。先用一句话描述场景，我搭一个低精度的白模；之后我按镜头表摆机位、写运镜，最后再出成片。</p> }]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, reduced ? 40 : ms)); };
  const push = (e: DockDraft) => { const id = e.id ?? uid(); setEvents(l => [...l, { ...e, id } as DockEvent]); return id; };
  const patch = (id: string, p: Partial<DockEvent>) => setEvents(l => l.map(e => e.id === id ? { ...e, ...p } as DockEvent : e));
  const say = (text: ReactNode) => push({ kind: 'agent', text, at: clock() });
  const approve = (title: string, effects: string[], action: string, run: () => void) => {
    const card = push({ kind: 'approval', action, title, effects, risk: 'write', state: 'pending', onApprove: () => {}, onReject: () => {} });
    patch(card, { onApprove: () => { patch(card, { state: 'approved' } as Partial<DockEvent>); run(); }, onReject: () => patch(card, { state: 'rejected' } as Partial<DockEvent>) } as Partial<DockEvent>);
  };

  const built = buildAt !== null;
  const shot = shots[sel], cam = cams[shot.no];
  const total = shots.reduce((s, x) => s + x.secs, 0);
  const starts = shots.map((_, i) => shots.slice(0, i).reduce((s, x) => s + x.secs, 0));
  const stage = Object.keys(finals).length ? 2 : Object.keys(cams).length ? 1 : 0;
  const blockedCount = Object.keys(cams).length;

  /* ———— 01 搭白模 ———— */
  const build = () => approve('生成白模 · 袋底洞', [`依据描述搭建 ${PRIMS.length} 个基本体 + ${CHARS.length} 个人物占位`, '人物占位绑定世界观实体（山姆、伊拉诺）'], 'blockout_generate', () => {
    setBusy(true); const tl = push({ kind: 'tool', action: 'blockout_generate', label: '解析描述 → 白模场景', state: 'running' });
    later(500, () => { setBuildAt(performance.now()); setMode('editor'); });
    later(500 + PRIMS.length * 90 + 500, () => { setBusy(false); patch(tl, { state: 'done', ms: 2600, detail: `${PRIMS.length} 个基本体 · 3 个人物占位` } as Partial<DockEvent>); say(<p>白模搭好了。拖空白处可以环绕，拖人物可以挪位置。下一步我按镜头表摆机位？</p>); });
  });
  /* ———— 02 摆机位 · 写分镜 ———— */
  const compose = () => approve('自动写分镜 · 摆机位', [`为 ${shots.length} 个镜头设置机位与运镜（推 / 横移 / 升）`, '镜头参数写回镜头表'], 'shot_compose', () => {
    setBusy(true); const tl = push({ kind: 'tool', action: 'shot_compose', label: `摆机位 · ${shots.length} 个镜头`, state: 'running' });
    shots.forEach((s, i) => later(300 + i * 380, () => { setCams(c => ({ ...c, [s.no]: { ...AUTO_CAMS[s.no], eye: [...AUTO_CAMS[s.no].eye] as V3, end: AUTO_CAMS[s.no].end ? [...AUTO_CAMS[s.no].end!] as V3 : undefined } })); setSel(i); }));
    later(300 + shots.length * 380 + 200, () => { setBusy(false); setMode('camera'); setSel(0); patch(tl, { state: 'done', ms: 2600, detail: `${shots.length} 个机位 · 3 个运镜` } as Partial<DockEvent>); say(<p>机位摆好了，已切到「机位视角」。点底部时间轴的 ▶ 可以预演整场；回到「编辑」可以拖橙色的机位和运镜终点。</p>); });
  });
  /* ———— 03 成片 ———— */
  const gen = (nos: string[]) => {
    const todo = nos.filter(n => cams[n]); if (!todo.length) return;
    approve(`生成成片 · ${todo.length} 个镜头`, [`${todo.join('、')}`, `白模参考 + 世界观人物三视图（自动附带）`, `价格 ¥${(PRICE * todo.length).toFixed(1)}（每镜 ¥${PRICE} · 模拟）`], 'video_generate', () => {
      setQueue(q => [...q, ...todo]);
      todo.forEach((n, i) => later(900 + i * 1100, () => { setFinals(f => ({ ...f, [n]: { v: (f[n]?.v ?? 0) + 4, pick: 0 } })); setQueue(q => q.filter(x => x !== n)); setSpent(s => s + PRICE); if (n === shot.no || i === 0) setMode('final'); }));
      later(900 + todo.length * 1100, () => say(<p>{todo.length} 个镜头出了成片，各有 v1–v4 四个候选（占位 · 模拟生成）。我先预选了 v1，可以在检查器里换。</p>));
    });
  };
  const check = () => {
    setBusy(true); const tl = push({ kind: 'tool', action: 'continuity_check', label: '设定冲突检查 · 镜头 × 世界观', state: 'running' });
    later(1100, () => {
      setBusy(false); const bad = shots.filter(s => lights[s.no] !== '黄昏');
      patch(tl, { state: 'done', ms: 1100, detail: bad.length ? `${bad.length} 处光线不一致` : '通过' } as Partial<DockEvent>);
      if (!bad.length) { say(<p>镜头与世界观一致，光线连贯。</p>); return; }
      push({ kind: 'card', body: <div className="vf-issue"><span className="rh-micro">▲ 连续性 · 光线</span><b>同一场戏的光线不一致</b><p>镜 01 是黄昏，{bad.map(b => b.no).join('、')} 的光线却是正午。人物三视图与服装一致，没有其他问题。</p>
        <button onClick={() => { setLights(l => Object.fromEntries(Object.keys(l).map(k => [k, '黄昏'])) as Record<string, Light>); say(<p>已把整场统一为黄昏光线。</p>); }}><em>A</em>统一为黄昏</button></div> });
    });
  };
  const onSend = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    if (!built || /搭|白模|场景/.test(text)) { if (text.length > 12 && !/^搭/.test(text)) setPrompt(text); return build(); }
    if (/机位|分镜/.test(text)) return compose();
    if (/成片|生成|出片/.test(text)) return gen(shots.map(s => s.no));
    if (/检查|冲突|一致/.test(text)) return check();
    later(500, () => say(<p>可以说：搭白模、自动摆机位、生成成片、检查一致性。</p>));
  };

  /* ———— 播放：播放头推进，视口按镜头切换并沿运镜插值 ———— */
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => { const dt = (now - last) / 1000; last = now; setT(v => { const nv = v + dt; if (nv >= total) { setPlaying(false); return total; } return nv; }); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, total]);
  useEffect(() => { if (!playing) return; const i = starts.findIndex((s, k) => t >= s && t < s + shots[k].secs); if (i >= 0 && i !== sel) setSel(i); }, [t, playing, starts, shots, sel]);
  const p = playing ? Math.min(1, (t - starts[sel]) / shot.secs) : 0;
  const viewCam = cam ? { eye: cam.end ? lerp3(cam.eye, cam.end, easeIO(p)) : cam.eye, target: cam.target, fov: cam.fov } : null;
  const fin = finals[shot.no];
  const showFinal = (mode === 'final' || mode === 'overlay' || (playing && fin)) && fin;
  const vpMode: 'editor' | 'camera' = mode === 'editor' || !viewCam ? 'editor' : 'camera';

  const suggestions: Suggestion[] = !built ? [{ id: 'b', label: '搭建白模', onClick: build }]
    : !blockedCount ? [{ id: 'c', label: '自动写分镜 · 摆机位', onClick: compose }, { id: 'k', label: '检查一致性', onClick: check }]
    : [...(shots.some(s => !finals[s.no]) ? [{ id: 'g', label: `生成全部成片 · ¥${(PRICE * shots.filter(s => !finals[s.no]).length).toFixed(1)}`, onClick: () => gen(shots.filter(s => !finals[s.no]).map(s => s.no)) }] : []), { id: 'k', label: '检查一致性', onClick: check }, { id: 'p', label: playing ? '暂停预演' : '预演整场', onClick: () => { if (t >= total) setT(0); setPlaying(v => !v); setMode(m => m === 'editor' ? 'camera' : m); } }];

  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState<ExplorerView>('files');
  const sections: ExplorerSection[] = [{ id: 'shots', title: '镜头表 · 第 2 章', count: shots.length, grow: true, body: <div className="vf-shots">
    {shots.map((s, i) => { const st = finals[s.no] ? '▶' : cams[s.no] ? '▣' : '▢'; return <button key={s.no} aria-current={i === sel || undefined} data-q={queue.includes(s.no) || undefined} onClick={() => { setSel(i); setPlaying(false); setT(starts[i]); }}>
      <i className="vf-thumb" data-st={st}>{st === '▶' ? <span className="vf-thumb-ph" /> : null}<b>{st}</b></i>
      <span><em>{s.no}</em><b>{s.size} · {s.move}</b><small>{s.desc}</small></span><small>{s.secs}s</small></button>; })}
  </div> }];

  return <div className="vf rh">
    <Explorer code="CRTV" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title="video/" sections={sections} />
    <section className="vf-center" data-wb-panel>
      <header className="dv-bar vf-bar" data-busy={busy || queue.length > 0 || undefined}>
        <div className="dv-bar-id"><b>VIDEO</b><small>视频<br />PREVIS</small></div>
        <ol className="vf-steps">{['BUILD · 白模', 'COMPOSE · 机位', 'VISUALIZE · 成片'].map((x, i) => <li key={x} data-s={i < stage ? 'done' : i === stage ? 'now' : undefined}><em>{String(i + 1).padStart(2, '0')}</em>{x}</li>)}</ol>
        <div className="vf-stats">
          <span><b>{shots.length}/{shots.length}</b><small>镜头表</small></span><span><b>{blockedCount}/{shots.length}</b><small>白模</small></span><span><b>{Object.keys(finals).length}/{shots.length}</b><small>成片</small></span>
          <span>{queue.length ? <Mobius stages={['排队', '生成', '回传']} current={1} running width={46} /> : <b>0</b>}<small>队列 {queue.length}</small></span><span><b>¥{spent.toFixed(1)}</b><small>本项目已花</small></span>
        </div>
      </header>
      <div className="vf-stage" data-surface="darkroom">
        <div className="vf-view">
        <div className="vf-modes" role="group" aria-label="查看方式">{([['editor', '编辑'], ['camera', '机位视角'], ['final', '成片'], ['overlay', '叠加对比']] as [Mode, string][]).map(([m, l]) => <button key={m} aria-pressed={mode === m} disabled={(m !== 'editor' && !cam) || ((m === 'final' || m === 'overlay') && !fin)} onClick={() => { setMode(m); setPlaying(false); }}>{l}</button>)}</div>
        <Viewport prims={PRIMS} chars={chars} buildAt={buildAt} mode={vpMode} cam={viewCam} editCam={mode === 'editor' ? cam ?? null : null} light={lights[shot.no]} selChar={selChar} onSelChar={setSelChar}
          onMoveChar={(id, pos) => setChars(cs => cs.map(c => c.id === id ? { ...c, p: pos } : c))} onMoveCam={(which, pos) => setCams(c => ({ ...c, [shot.no]: { ...c[shot.no], [which]: pos } }))}
          dim={showFinal ? (mode === 'overlay' ? .45 : .82) : 0} labels={!showFinal} />
        {showFinal && <div className="vf-final" data-overlay={mode === 'overlay' || undefined} data-v={fin.pick}>
          <span className="vf-final-tag">模拟生成 · {shot.no} · v{fin.pick + 1}</span><p>{shot.desc}</p><small>占位图 · 不连接视频模型 · 构图取自白模机位</small></div>}
        {!built && <form className="vf-prompt" onSubmit={e => { e.preventDefault(); build(); }}>
          <span className="vf-ghost" aria-hidden="true">BUILD</span>
          <span className="rh-micro">01 · BUILD · 用一句话描述场景</span>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} />
          <div><small>参照 Intangible：自然语言 → 低精度三维白模 → 机位与分镜 → 成片</small><button className="rh-btn is-solid">搭建白模 →</button></div>
        </form>}
        {built && <div className="vf-hint rh-micro">{mode === 'editor' ? '拖空白处环绕 · Shift 拖动平移 · 滚轮缩放 · 拖人物移动 · 拖橙色机位 / 终点' : mode === 'camera' ? `机位视角 · ${shot.size} · ${shot.move} · FOV ${cam?.fov ?? '—'}°` : ''}</div>}
        </div>
        <Inspector shot={shot} cam={cam} light={lights[shot.no]} art={art} fin={fin} queued={queue.includes(shot.no)} chars={chars} selChar={selChar}
          onLight={l => setLights(x => ({ ...x, [shot.no]: l }))} onGen={() => gen([shot.no])} onPick={k => { setFinals(f => ({ ...f, [shot.no]: { ...f[shot.no], pick: k } })); setMode('final'); }} />
      </div>
      <Timeline shots={shots} starts={starts} total={total} t={t} sel={sel} playing={playing} finals={finals} cams={cams}
        onPlay={() => { if (!blockedCount) return; if (t >= total) setT(0); setPlaying(v => !v); setMode(m => m === 'editor' ? 'camera' : m); }} onSeek={x => { setPlaying(false); setT(x); const i = starts.findIndex((s, k) => x >= s && x < s + shots[k].secs); if (i >= 0) setSel(i); }} />
    </section>
    <AgentDock name="导演助手" target={`第 2 章 · ${shots.length} 个镜头 · ¥${spent.toFixed(1)}`} plan={{ stages: ['搭白模', '摆机位', '检查一致性', '生成成片'], current: !built ? 0 : !blockedCount ? 1 : stage === 2 ? 3 : 2 }}
      suggestions={suggestions} events={events} busy={busy} onSend={onSend} placeholder="例如：搭白模 · 自动摆机位 · 生成成片" />
  </div>;
}

function Inspector({ shot, cam, light, art, fin, queued, chars, selChar, onLight, onGen, onPick }: {
  shot: Shot; cam?: Cam; light: Light; art: Record<string, number>; fin?: { v: number; pick: number }; queued: boolean; chars: Char[]; selChar: string | null;
  onLight: (l: Light) => void; onGen: () => void; onPick: (k: number) => void;
}) {
  const refs = shot.cast.map(id => ENTITIES.find(e => e.id === id)!).filter(Boolean);
  const sc = chars.find(c => c.id === selChar);
  return <aside className="vf-insp">
    <header><em>{shot.no}</em><span><b>{shot.size} · {shot.move}</b><small>{shot.secs}s · {cam ? '已摆机位' : '未摆机位'}</small></span></header>
    <p className="vf-desc">{shot.desc}</p>
    <dl><dt>机位</dt><dd>{cam ? `(${cam.eye.map(v => v.toFixed(1)).join(', ')})` : '—'}</dd><dt>视角</dt><dd>{cam ? `${cam.fov}°` : '—'}</dd><dt>运镜</dt><dd>{cam?.end ? `${shot.move} · 有终点` : shot.move}</dd>
      <dt>光线</dt><dd className="vf-light">{(['黄昏', '正午'] as Light[]).map(l => <button key={l} aria-pressed={light === l} onClick={() => onLight(l)}>{l}</button>)}</dd></dl>
    {sc && <p className="vf-sel">■ 选中 {sc.name} · ({sc.p[0].toFixed(1)}, {sc.p[2].toFixed(1)})</p>}
    <section><span className="rh-micro">参考 · 人物三视图（自动附带）</span>
      {refs.length ? <div className="vf-refs">{refs.map(e => <span key={e.id}><i className="cr-ph" data-small data-empty={!art[e.id] || undefined}><svg viewBox="0 0 40 48"><circle cx="20" cy="17" r="8" /><path d="M5 48 C 6 32, 34 32, 35 48 Z" /></svg></i><b>{e.name}</b><small>{art[e.id] ? `三视图 v${art[e.id]}` : '还没有三视图'}</small></span>)}</div> : <small className="vf-none">本镜没有出场人物</small>}</section>
    <section><span className="rh-micro">候选 · CANDIDATES</span>
      {fin ? <div className="vf-cands">{[0, 1, 2, 3].map(k => <button key={k} aria-pressed={fin.pick === k} data-v={k} onClick={() => onPick(k)}><span>v{k + 1}</span></button>)}</div> : <small className="vf-none">{queued ? '生成中…' : '还没有成片'}</small>}
      <button className="rh-btn is-solid vf-gen" onClick={onGen} disabled={!cam || queued}>{queued ? '排队中…' : fin ? '重新生成' : '生成成片'}<span>¥{PRICE.toFixed(1)}</span></button></section>
  </aside>;
}

function Timeline({ shots, starts, total, t, sel, playing, finals, cams, onPlay, onSeek }: {
  shots: Shot[]; starts: number[]; total: number; t: number; sel: number; playing: boolean; finals: Record<string, unknown>; cams: Record<string, Cam>; onPlay: () => void; onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const seek = (x: number) => { const r = ref.current!.getBoundingClientRect(); onSeek(Math.max(0, Math.min(total - .01, ((x - r.left - 64) / (r.width - 64)) * total))); };
  return <footer className="vf-tl" ref={ref} onPointerDown={e => { if ((e.target as HTMLElement).closest('button')) return; e.currentTarget.setPointerCapture(e.pointerId); seek(e.clientX); }} onPointerMove={e => { if (e.buttons && !(e.target as HTMLElement).closest('button')) seek(e.clientX); }}>
    <div className="vf-tl-head"><button className="sw-play" onClick={onPlay} aria-label={playing ? '暂停' : '播放'}><svg viewBox="0 0 12 12">{playing ? <><rect x="2" y="1.5" width="3" height="9" /><rect x="7" y="1.5" width="3" height="9" /></> : <path d="M3 1.5 L10.5 6 L3 10.5 Z" />}</svg></button><small>{t.toFixed(1)}s / {total}s</small></div>
    <div className="vf-tracks">
      <div className="vf-track"><em>画面</em><div>{shots.map((s, i) => <span key={s.no} style={{ left: `${starts[i] / total * 100}%`, width: `${s.secs / total * 100}%` }} data-st={finals[s.no] ? 'final' : cams[s.no] ? 'block' : 'none'} aria-current={i === sel || undefined}><b>{s.no.replace('镜 ', '')}</b>{s.size}</span>)}</div></div>
      <div className="vf-track"><em>对白</em><div>{shots.map((s, i) => DIALOGUE[s.no] && <span key={s.no} className="is-dia" style={{ left: `${starts[i] / total * 100}%`, width: `${s.secs / total * 100}%` }}>{DIALOGUE[s.no]}</span>)}</div></div>
      <div className="vf-track"><em>音乐</em><div><span className="is-music" style={{ left: '0%', width: '100%' }}>主题 · 风笛与弦乐（占位）<i /></span></div></div>
      <b className="vf-head" style={{ left: `calc(64px + (100% - 64px) * ${t / total})` }} />
    </div>
  </footer>;
}
