import { useEffect, useMemo, useRef, useState } from 'react';
import type { BenchProps } from './WorkbenchStudio';
import './bench-creative.css';

/* ── Shots: script → shots → frames → film ── */
type Structure = '主张' | '引语' | '流程' | '层级' | '对照' | '组合';
type Transition = '推进' | '聚焦' | '淡入' | '上移';
const STRUCTURES: Structure[] = ['主张', '引语', '流程', '层级', '对照', '组合'];
const TRANSITIONS: Transition[] = ['推进', '聚焦', '淡入', '上移'];
const CAMERAS = ['静止', '缓推', '横移', '环绕'];
interface Shot { id: number; structure: Structure; transition: Transition; title: string; body: string; seconds: number; camera: string; variant: number; state: 'ready' | 'draft' }
interface Project { name: string; style: string; script: string }
const PROJECTS: Project[] = [
  { name: '工作台视觉系统', style: '纸白档案', script: '莱茵生命的工作台\n一个工作室，六个部门\n\n每一份档案都通向一个工作台\n档案编号是唯一的入口\n\n首先选择工作台，然后抽取档案，最后进入工作现场\n\n界面分为三层：档案场、阅读层、工作现场\n\n过去：一个大标题占据半屏\n现在：空间留给真正的工作\n\n纸白、灰绿、一点金\n细线与档案编号' },
  { name: '产品视频 · 分镜', style: '深海光环', script: 'Agent 时代：交互升维\n人们主要通过自然语言与模型交互\n\n大模型时代的交互局限\nLLM 时代：自然语言交互 ≈ 非智能手机\n\nAgent 爆发：从被动响应到主动执行\n3 月 Agent 爆发，AI 长出手脚\n\n交互方式仍未进化\n仍是语音控制，像用 Siri 操作智能手机\n\n复杂任务 vs 简单任务\n复杂任务交给 Agent，简单任务直接操作' },
  { name: '文章与表达', style: '纸白档案', script: '让理解发生\n课程不是信息的搬运\n\n理解需要三步：看见、追问、重述\n\n知识是分层的：概念、方法、问题\n\n记住与理解的区别\n记住：能复述；理解：能迁移' },
  { name: '图像与风格探索', style: '暮色胶片', script: '光与纸\n一组关于质感的练习\n\n晨光、正午、黄昏、夜\n\n高光与阴影的层级\n\n冷与暖的对照' },
];
const STYLES: Record<string, { bg: string; fg: string; accent: string; line: string }> = {
  '纸白档案': { bg: '#f1eee5', fg: '#1d211a', accent: '#a68b58', line: '#1d211a22' },
  '深海光环': { bg: '#12161a', fg: '#e8ede9', accent: '#9fc3b4', line: '#ffffff14' },
  '暮色胶片': { bg: '#1f1b17', fg: '#efe4d2', accent: '#d39b5e', line: '#ffffff12' },
};

function guess(title: string, body: string): Structure {
  const t = title + body;
  if (/vs|对照|过去|现在|区别|≈/.test(t)) return '对照';
  if (/首先|然后|最后|步|→/.test(t)) return '流程';
  if (/层|分为/.test(t)) return '层级';
  if (/[、，].*[、，].*[、，]/.test(body || title)) return '组合';
  if (/：/.test(body)) return '引语';
  return '主张';
}
function split(script: string): Shot[] {
  return script.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).slice(0, 16).map((part, i) => {
    const [title, ...rest] = part.split('\n').map(l => l.trim()).filter(Boolean);
    const body = rest.join('\n');
    return { id: i + 1, structure: i === 0 ? '主张' : guess(title, body), transition: TRANSITIONS[i % 4], title, body, seconds: i === 0 ? 4 : Math.min(9, 4 + Math.ceil((title.length + body.length) / 14)), camera: CAMERAS[i % 3], variant: 0, state: 'ready' as const };
  });
}

/** Renders one shot as a 16:9 frame. The same drawing is used for the editor, the player and the film strip. */
function Frame({ shot, style, small = false }: { shot: Shot; style: string; small?: boolean }) {
  const c = STYLES[style] ?? STYLES['纸白档案'];
  const v = shot.variant;
  const parts = (shot.body || shot.title).split(/[、，,\n：:]|vs|→/).map(s => s.trim()).filter(Boolean).slice(0, 4);
  const left = v === 1 ? 480 : 96;
  const anchor = v === 1 ? 'middle' : 'start';
  return <svg className="cr-frame" viewBox="0 0 960 540" preserveAspectRatio={small ? 'xMidYMid slice' : undefined} role="img" aria-label={`第 ${shot.id} 镜 · ${shot.title}`}>
    <rect width="960" height="540" fill={c.bg} />
    {!small && Array.from({ length: 11 }, (_, i) => <line key={i} x1={i * 96} x2={i * 96} y1="0" y2="540" stroke={c.line} />)}
    <text x="40" y="44" fill={c.fg} opacity=".45" fontSize="13" letterSpacing="3" fontFamily="IBM Plex Mono, monospace">{String(shot.id).padStart(2, '0')} / {shot.structure}</text>
    <text x="920" y="44" fill={c.fg} opacity=".35" fontSize="12" letterSpacing="3" textAnchor="end" fontFamily="IBM Plex Mono, monospace">RHINE LAB</text>
    {shot.structure === '主张' && <g>
      <line x1={v === 1 ? 420 : left} x2={v === 1 ? 540 : left + 70} y1="214" y2="214" stroke={c.accent} strokeWidth="3" />
      <text x={left} y="296" fill={c.fg} fontSize={shot.title.length > 14 ? 50 : 64} fontWeight="800" textAnchor={anchor} fontFamily="'Noto Sans SC','DM Sans',sans-serif">{shot.title}</text>
      {shot.body && <text x={left} y="350" fill={c.fg} opacity=".62" fontSize="22" textAnchor={anchor} fontFamily="'Noto Sans SC',sans-serif">{shot.body.split('\n')[0]}</text>}
    </g>}
    {shot.structure === '引语' && <g>
      <text x="96" y="230" fill={c.accent} fontSize="90" fontFamily="Georgia,serif">“</text>
      <text x="150" y="250" fill={c.fg} fontSize="40" fontWeight="700" fontFamily="'Noto Sans SC',sans-serif">{shot.title}</text>
      <rect x="150" y="290" width="660" height="70" fill={c.fg} opacity=".06" />
      <text x="172" y="334" fill={c.fg} opacity=".8" fontSize="24" fontFamily="'Noto Sans SC',sans-serif">{shot.body.split('\n')[0]}</text>
    </g>}
    {shot.structure === '流程' && <g>
      <text x="96" y="168" fill={c.fg} fontSize="34" fontWeight="700" fontFamily="'Noto Sans SC',sans-serif">{shot.title}</text>
      {(parts.length > 1 ? parts : ['选择', '抽取', '进入']).slice(0, 3).map((p, i) => <g key={i} transform={`translate(${96 + i * 276} 250)`}>
        <rect width="230" height="120" fill="none" stroke={i === 2 ? c.accent : c.fg} strokeOpacity={i === 2 ? 1 : .5} strokeWidth="1.5" />
        <text x="18" y="34" fill={c.accent} fontSize="14" fontFamily="IBM Plex Mono, monospace">0{i + 1}</text>
        <text x="18" y="80" fill={c.fg} fontSize={p.length > 9 ? 17 : 22} fontFamily="'Noto Sans SC',sans-serif">{p.slice(0, 13)}</text>
        {i < 2 && <path d="M238 60h30m-8-6 8 6-8 6" fill="none" stroke={c.fg} strokeOpacity=".6" strokeWidth="1.5" />}
      </g>)}
    </g>}
    {shot.structure === '层级' && <g>
      <text x="96" y="150" fill={c.fg} fontSize="32" fontWeight="700" fontFamily="'Noto Sans SC',sans-serif">{shot.title}</text>
      {(parts.length > 1 ? parts.slice(-3) : ['档案场', '阅读层', '工作现场']).map((p, i) => <g key={i} transform={`translate(${96 + i * 40} ${200 + i * 82})`}>
        <rect width={640 - i * 80} height="64" fill={i === 2 ? c.accent : c.fg} opacity={i === 2 ? .9 : .08 + i * .05} />
        <text x="22" y="40" fill={i === 2 ? c.bg : c.fg} fontSize="22" fontFamily="'Noto Sans SC',sans-serif">{p.slice(0, 16)}</text>
      </g>)}
    </g>}
    {shot.structure === '对照' && <g>
      <text x="480" y="140" fill={c.fg} fontSize="30" fontWeight="700" textAnchor="middle" fontFamily="'Noto Sans SC',sans-serif">{shot.title}</text>
      <line x1="480" x2="480" y1="190" y2="440" stroke={c.fg} strokeOpacity=".3" />
      {(shot.body ? shot.body.split(/[；;\n]/) : ['过去', '现在']).slice(0, 2).map((p, i) => <g key={i} transform={`translate(${i ? 520 : 120} 230)`}>
        <rect width="320" height="4" fill={i ? c.accent : c.fg} opacity={i ? 1 : .4} />
        <text x="0" y="60" fill={c.fg} opacity={i ? 1 : .6} fontSize="22" fontFamily="'Noto Sans SC',sans-serif">{p.trim().slice(0, 14)}</text>
        <text x="0" y="96" fill={c.fg} opacity=".45" fontSize="16" fontFamily="'Noto Sans SC',sans-serif">{p.trim().slice(14, 32)}</text>
      </g>)}
    </g>}
    {shot.structure === '组合' && <g>
      <text x="96" y="150" fill={c.fg} fontSize="32" fontWeight="700" fontFamily="'Noto Sans SC',sans-serif">{shot.title}</text>
      {(parts.length > 1 ? parts : ['纸白', '灰绿', '金', '细线']).slice(0, 4).map((p, i) => <g key={i} transform={`translate(${96 + (i % 2) * 390} ${200 + Math.floor(i / 2) * 130})`}>
        <rect width="360" height="110" fill={c.fg} opacity=".06" /><rect width="6" height="110" fill={i === 0 ? c.accent : c.fg} opacity={i === 0 ? 1 : .35} />
        <text x="26" y="64" fill={c.fg} fontSize="24" fontFamily="'Noto Sans SC',sans-serif">{p.slice(0, 12)}</text>
      </g>)}
    </g>}
    {v === 2 && <circle cx="842" cy="430" r="46" fill="none" stroke={c.accent} strokeWidth="2" />}
    <rect x="40" y="500" width={880 * Math.min(1, shot.seconds / 9)} height="2" fill={c.accent} opacity=".5" />
  </svg>;
}

export default function CreativeBench({ file, reduced }: BenchProps) {
  const project = PROJECTS[file];
  const [script, setScript] = useState(project.script);
  const [shots, setShots] = useState<Shot[]>(() => split(project.script));
  const [style, setStyle] = useState(project.style);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<'edit' | 'film'>('edit');
  const [splitting, setSplitting] = useState<null | 'ai'>(null);
  const [generating, setGenerating] = useState(false);
  const [candidates, setCandidates] = useState<number[] | null>(null);
  const [prompt, setPrompt] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [quality, setQuality] = useState('1080P');
  const [exporting, setExporting] = useState<number | null>(null);
  const total = shots.reduce((s, x) => s + x.seconds, 0);
  const starts = useMemo(() => { let t = 0; return shots.map(s => { const at = t; t += s.seconds; return at; }); }, [shots]);
  const atTime = Math.max(0, starts.findIndex((s, i) => time >= s && time < s + shots[i].seconds));
  const shot = shots[Math.min(sel, shots.length - 1)];
  const frameRef = useRef<number>(0);

  useEffect(() => { setPrompt(`${style}风格 · ${shot?.structure ?? ''}构图 · 「${shot?.title ?? ''}」· 镜头${shot?.camera ?? ''}`); setCandidates(null); }, [sel, style, shot?.structure, shot?.title, shot?.camera]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (t: number) => { const dt = (t - last) / 1000; last = t; setTime(v => { const next = v + dt; if (next >= total) { setPlaying(false); return total; } return next; }); frameRef.current = requestAnimationFrame(step); };
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [playing, total]);
  useEffect(() => { if (mode === 'film' && playing) setSel(atTime); }, [atTime, mode, playing]);

  function update(patch: Partial<Shot>) { setShots(list => list.map((s, i) => i === sel ? { ...s, ...patch } : s)); }
  function resplit(kind: 'ai' | 'local') {
    if (kind === 'local') { setShots(split(script)); setSel(0); return; }
    setSplitting('ai'); window.setTimeout(() => { setShots(split(script)); setSel(0); setSplitting(null); }, reduced ? 0 : 900);
  }
  function generate() { setGenerating(true); setCandidates(null); window.setTimeout(() => { setGenerating(false); setCandidates([0, 1, 2, 3]); }, reduced ? 0 : 1100); }
  const exportTimer = useRef<number>(0);
  useEffect(() => () => window.clearInterval(exportTimer.current), []);
  function exportFilm() { setExporting(0); let p = 0; exportTimer.current = window.setInterval(() => { p = Math.min(100, p + 7); setExporting(p); if (p >= 100) { window.clearInterval(exportTimer.current); window.setTimeout(() => setExporting(null), 1600); } }, reduced ? 10 : 90); }
  function seek(t: number) { setTime(Math.max(0, Math.min(total, t))); const i = starts.findIndex((s, k) => t >= s && t < s + shots[k].seconds); if (i >= 0) setSel(i); }
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return <div className="cr">
    <div className="cr-top">
      <b>{project.name}</b><span className="mono">{shots.length} 镜 · {fmt(total)}</span>
      <label>风格<select value={style} onChange={e => setStyle(e.target.value)}>{Object.keys(STYLES).map(s => <option key={s}>{s}</option>)}</select></label>
      <label>画幅<select defaultValue="16:9"><option>16:9 横屏</option><option disabled>9:16 竖屏（待接入）</option></select></label>
      <span className="cr-top-gap" />
      <label>导出<select value={quality} onChange={e => setQuality(e.target.value)}>{['1080P', '2K', '4K'].map(q => <option key={q}>{q}</option>)}</select></label>
      <button className="b solid" onClick={exportFilm} disabled={exporting !== null}>{exporting === null ? '导出 MP4' : exporting >= 100 ? '预演完成' : `导出中 ${exporting}%`}</button>
      {exporting !== null && <span className="chip sim">预演 · 未接入渲染服务，不生成文件</span>}
    </div>

    <section className="p cr-script">
      <header className="p-h"><b>① 文案</b><span>SCRIPT</span></header>
      <textarea value={script} onChange={e => setScript(e.target.value)} aria-label="文案" spellCheck={false} />
      <div className="cr-script-foot"><button className="b gold" onClick={() => resplit('ai')} disabled={!!splitting}>{splitting ? '切分中…' : 'AI 语义切分'}</button><button className="b" onClick={() => resplit('local')}>按空行切分</button><small>空行分镜，首行为标题</small></div>
      <div className="cr-legend"><b>结构</b>{STRUCTURES.map(s => <span key={s}>{s}</span>)}</div>
    </section>

    <section className="p cr-shots">
      <header className="p-h"><b>② 分镜</b><span>{shots.length} SHOTS</span></header>
      <ol className="p-body scroll-thin">{shots.map((s, i) => <li key={s.id} data-on={i === sel || undefined} onClick={() => setSel(i)}>
        <div className="cr-shot-row"><em className="num">{String(s.id).padStart(2, '0')}</em>
          <label>结构<select value={s.structure} onChange={e => setShots(l => l.map((x, k) => k === i ? { ...x, structure: e.target.value as Structure } : x))}>{STRUCTURES.map(o => <option key={o}>{o}</option>)}</select></label>
          <label>转场<select value={s.transition} onChange={e => setShots(l => l.map((x, k) => k === i ? { ...x, transition: e.target.value as Transition } : x))}>{TRANSITIONS.map(o => <option key={o}>{o}</option>)}</select></label>
          <label className="cr-sec"><input type="number" min={2} max={20} value={s.seconds} onChange={e => setShots(l => l.map((x, k) => k === i ? { ...x, seconds: Math.max(2, Math.min(20, +e.target.value || 2)) } : x))} />秒</label>
        </div>
        <input className="cr-shot-title" value={s.title} onChange={e => setShots(l => l.map((x, k) => k === i ? { ...x, title: e.target.value } : x))} aria-label={`第 ${s.id} 镜标题`} />
        <textarea className="cr-shot-body" rows={2} value={s.body} onChange={e => setShots(l => l.map((x, k) => k === i ? { ...x, body: e.target.value } : x))} aria-label={`第 ${s.id} 镜画面文字`} />
        <div className="cr-shot-tools"><button className="b ghost" disabled={i === 0} onClick={e => { e.stopPropagation(); setShots(l => { const c = [...l]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; }); setSel(i - 1); }}>↑</button><button className="b ghost" disabled={i === shots.length - 1} onClick={e => { e.stopPropagation(); setShots(l => { const c = [...l]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; return c; }); setSel(i + 1); }}>↓</button><button className="b ghost" onClick={e => { e.stopPropagation(); setShots(l => [...l.slice(0, i + 1), { ...s, id: l.length + 1 }, ...l.slice(i + 1)].map((x, k) => ({ ...x, id: k + 1 }))); }}>复制</button><button className="b ghost" disabled={shots.length < 2} onClick={e => { e.stopPropagation(); setShots(l => l.filter((_, k) => k !== i).map((x, k) => ({ ...x, id: k + 1 }))); setSel(Math.max(0, i - 1)); }}>删除</button></div>
      </li>)}</ol>
    </section>

    <section className="p cr-stage">
      <header className="p-h"><b>{mode === 'edit' ? '③ 画面编辑' : '④ 整片预览'}</b><span className="seg">{([['edit', '单镜编辑'], ['film', '整片预览']] as const).map(([m, n]) => <button key={m} aria-pressed={mode === m} onClick={() => { setMode(m); setPlaying(false); if (m === 'film') seek(starts[sel] ?? 0); }}>{n}</button>)}</span></header>
      <div className="cr-canvas"><div className="cr-canvas-in" key={mode === 'film' ? `f${atTime}` : `e${sel}-${shot?.variant}`} data-transition={mode === 'film' ? shots[atTime]?.transition : undefined}>{shot && <Frame shot={mode === 'film' ? shots[atTime] : shot} style={style} />}</div></div>
      {mode === 'edit' ? <div className="cr-gen">
        <div className="cr-gen-row"><label>镜头<span className="seg">{CAMERAS.map(c => <button key={c} aria-pressed={shot?.camera === c} onClick={() => update({ camera: c })}>{c}</button>)}</span></label><label>版式<span className="seg">{['左对齐', '居中', '加印记'].map((n, i) => <button key={n} aria-pressed={shot?.variant === i} onClick={() => update({ variant: i })}>{n}</button>)}</span></label></div>
        <div className="cr-gen-prompt"><textarea rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} aria-label="画面提示词" /><button className="b gold" onClick={generate} disabled={generating}>{generating ? '生成中…' : '生成 4 个候选'}</button></div>
        <div className="cr-cands">{generating ? [0, 1, 2, 3].map(i => <i key={i} className="cr-cand-wait" />) : candidates ? candidates.map(i => { const alt = { variant: i % 3, structure: i === 3 ? STRUCTURES[(STRUCTURES.indexOf(shot.structure) + 1) % 6] : shot.structure }; return <button key={i} onClick={() => update({ ...alt, state: 'ready' })} aria-label={`候选 ${i + 1}`}><Frame shot={{ ...shot, ...alt }} style={style} small /><span className="mono">候选 {i + 1}</span></button>; }) : <p>候选画面由版式规则在本地排出，用来比较构图；接入生成模型后会替换为生成结果。</p>}</div>
      </div> : <div className="cr-player">
        <button className="b solid" onClick={() => { if (time >= total) seek(0); setPlaying(v => !v); }}>{playing ? '❚❚' : '▶'}</button>
        <input type="range" min={0} max={total} step={.05} value={time} onChange={e => { setPlaying(false); seek(+e.target.value); }} aria-label="播放位置" />
        <span className="mono">{fmt(time)} / {fmt(total)}</span>
        <span className="cr-player-shot">第 {atTime + 1} 镜 · {shots[atTime]?.transition}</span>
      </div>}
    </section>

    <section className="p cr-timeline">
      <header className="p-h"><b>时间线</b><span className="mono">{fmt(total)}</span><span>点击画面跳转 · 时长在分镜栏修改</span></header>
      <div className="cr-tracks">
        <span className="cr-track-name">画面</span>
        <div className="cr-track cr-track-film">{shots.map((s, i) => <button key={s.id} style={{ flex: s.seconds }} data-on={i === sel || undefined} onClick={() => { setSel(i); seek(starts[i]); }}><Frame shot={s} style={style} small /><span className="mono">{String(s.id).padStart(2, '0')} {s.structure} {s.seconds}s</span></button>)}</div>
        <span className="cr-track-name">字幕</span>
        <div className="cr-track">{shots.map(s => <i key={s.id} style={{ flex: s.seconds }}>{s.title}</i>)}</div>
        <span className="cr-track-name">配音</span>
        <div className="cr-track cr-wave">{shots.map(s => <i key={s.id} style={{ flex: s.seconds }}>{Array.from({ length: s.seconds * 3 }, (_, k) => <b key={k} style={{ height: `${20 + Math.abs(Math.sin(s.id * 3 + k * 1.3)) * 70}%` }} />)}</i>)}</div>
        <span className="cr-track-name">音乐</span>
        <div className="cr-track cr-music"><i style={{ flex: 1 }}>Ambient · 72 BPM · 待选曲</i></div>
        <div className="cr-playhead" style={{ left: `calc(56px + (100% - 56px) * ${total ? time / total : 0})` }} />
      </div>
    </section>
  </div>;
}
