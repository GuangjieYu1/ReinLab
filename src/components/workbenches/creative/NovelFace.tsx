import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ENTITIES, KIND, type Issue } from './world';
import { scrollWithin } from '../scrollWithin';
import { COMPLETIONS, type Chapter, type Scene } from './novel';

// 创作台 · 小说面：沉浸式写作区。世界观实体自动下划线（悬停看设定卡）；Tab 接受补全；
// 设定冲突以波浪线 + 页边标注卡出现，带修改选项，也可以写下理由短提交（与需求面同一套机制）。节拍板可拖动排序。

const ALIAS: Record<string, string> = { 红皮书: 'redbook' };
const NAMES = [...ENTITIES.map(e => [e.name, e.id] as [string, string]), ...Object.entries(ALIAS)].sort((a, b) => b[0].length - a[0].length);
const ent = (id: string) => ENTITIES.find(e => e.id === id)!;
/** 正文里的冲突片段：哪条问题、在哪一段、标哪几个字、每个选项怎么改。 */
export const MARKS: Record<string, { para: string; quote: string; fixes: (string | null)[] }> = {
  A3: { para: 'p8', quote: '他伸出十指，按住书页', fixes: ['他伸出九根手指，按住书页', '他用掌心按住书页'] },
  A4: { para: 'p5', quote: '「银风号，」信使说，「他们是这么叫它的。」', fixes: [null, '「船是白色的，」信使说，「没有名字。」'] },
};

export default function NovelFace({ chapters, setText, moveScene, scene, setScene, issues, onResolve, onReason, typing, view }: {
  chapters: Chapter[]; setText: (para: string, text: string) => void; moveScene: (id: string, to: string, index: number) => void;
  scene: string; setScene: (id: string) => void; issues: Issue[]; onResolve: (i: Issue, choice: string, idx: number) => void; onReason: (i: Issue, text: string) => void;
  typing: string | null; view: 'text' | 'beats';
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollWithin(box.current?.querySelector(`[data-scene="${scene}"]`), 'start'); }, [scene]);
  if (view === 'beats') return <Beats chapters={chapters} scene={scene} setScene={setScene} moveScene={moveScene} />;
  const current = chapters.flatMap(c => c.scenes).find(s => s.id === scene)!;
  return <div className="nv">
    <div className="nv-ms" ref={box}>
      <span className="nv-ghost" aria-hidden="true">NOVEL</span>
      {chapters.map(c => <section key={c.id} className="nv-ch">
        <header><em>{c.no}</em><h2>{c.title}</h2><small>{c.scenes.reduce((n, s) => n + s.paras.reduce((m, p) => m + p.text.length, 0), 0)} 字</small></header>
        {c.scenes.map((s, si) => <div key={s.id} className="nv-scene" data-scene={s.id} data-on={s.id === scene || undefined} onMouseDown={() => s.id !== scene && setScene(s.id)}>
          <span className="nv-scene-mark">{String(si + 1).padStart(2, '0')} · {s.title}</span>
          {s.paras.map(p => { const mine = issues.filter(i => MARKS[i.id]?.para === p.id);
            return <div key={p.id} className="nv-row" data-has-notes={mine.length ? true : undefined}>
              <ParaEdit id={p.id} text={p.text} marks={mine.map(i => ({ quote: MARKS[i.id].quote, kind: i.cat }))} onText={t => setText(p.id, t)} typing={typing === p.id} />
              {mine.length > 0 && <div className="nv-notes">{mine.map(i => <Note key={i.id} i={i} onResolve={onResolve} onReason={onReason} />)}</div>}
            </div>; })}
        </div>)}
      </section>)}
    </div>
    <SceneCard s={current} />
  </div>;
}

/** 一段正文：渲染层（实体下划线 + 冲突波浪线）+ 透明 textarea；光标在段末时给出补全，Tab 接受。 */
function ParaEdit({ id, text, marks, onText, typing }: { id: string; text: string; marks: { quote: string; kind: string }[]; onText: (t: string) => void; typing: boolean }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [ghost, setGhost] = useState('');
  const ask = (t: string) => { const el = area.current; if (!el || el.selectionStart !== t.length) { setGhost(''); return; } const hit = COMPLETIONS.find(([k]) => t.endsWith(k)); setGhost(hit ? hit[1] : ''); };
  useLayoutEffect(() => { if (area.current) { area.current.style.height = '0px'; area.current.style.height = `${area.current.scrollHeight}px`; } }, [text, focused]);
  // 渲染：先切出冲突片段，再在每个片段里找实体名。
  const parts: { t: string; mark?: string }[] = [];
  let rest = text;
  while (rest) { const hit = marks.map(m => ({ ...m, i: rest.indexOf(m.quote) })).filter(m => m.i >= 0).sort((a, b) => a.i - b.i)[0]; if (!hit) { parts.push({ t: rest }); break; } if (hit.i) parts.push({ t: rest.slice(0, hit.i) }); parts.push({ t: hit.quote, mark: hit.kind }); rest = rest.slice(hit.i + hit.quote.length); }
  const terms = (t: string) => { const out: { t: string; id?: string }[] = []; let i = 0, buf = ''; while (i < t.length) { const n = NAMES.find(([name]) => t.startsWith(name, i)); if (n) { if (buf) out.push({ t: buf }); buf = ''; out.push({ t: n[0], id: n[1] }); i += n[0].length; } else { buf += t[i]; i++; } } if (buf) out.push({ t: buf }); return out; };
  return <div className="nv-para" data-focused={focused || undefined} data-typing={typing || undefined} onMouseDown={e => { if (!focused && !(e.target as HTMLElement).closest('.nv-term-card')) { e.preventDefault(); area.current?.focus(); const l = text.length; area.current?.setSelectionRange(l, l); } }}>
    <div className="nv-mirror" aria-hidden={focused || undefined}>
      {parts.map((p, k) => <span key={k} className={p.mark ? 'nv-mark' : undefined} data-kind={p.mark}>{terms(p.t).map((s, j) => s.id
        ? <span key={j} className="nv-term" data-kind={ent(s.id).kind}>{s.t}<span className="nv-term-card"><small>{KIND[ent(s.id).kind].zh} · 世界观</small><b>{ent(s.id).name}</b>{ent(s.id).tagline}</span></span>
        : <Fragment key={j}>{s.t}</Fragment>)}</span>)}
      {focused && ghost && <span className="nv-ghost-text">{ghost}<kbd>Tab</kbd></span>}
      {typing && <span className="nv-caret">▍</span>}
      {'​'}
    </div>
    <textarea ref={area} value={text} rows={1} spellCheck={false} aria-label={`段落 ${id}`}
      onFocus={() => { setFocused(true); ask(text); }} onBlur={() => { setFocused(false); setGhost(''); }}
      onChange={e => { onText(e.target.value); ask(e.target.value); }} onSelect={e => ask(e.currentTarget.value)}
      onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Tab' && ghost) { e.preventDefault(); const t = text + ghost; onText(t); setGhost(''); requestAnimationFrame(() => area.current?.setSelectionRange(t.length, t.length)); } else if (e.key === 'Escape') setGhost(''); }} />
  </div>;
}

function Note({ i, onResolve, onReason }: { i: Issue; onResolve: (i: Issue, c: string, idx: number) => void; onReason: (i: Issue, t: string) => void }) {
  const [draft, setDraft] = useState('');
  return <article className="rq-note nv-note" data-kind={i.cat === '世界' ? 'term' : 'conflict'}>
    <header><i />{i.cat}<em>{i.id} · {i.where.replace('小说 · ', '')}</em></header>
    <strong>{i.title}</strong>
    <div className="rq-thread"><p data-who="model"><i>设定</i>{i.detail}</p></div>
    <div className="rq-options">{i.options.map((o, k) => <button key={o} onClick={() => onResolve(i, o, k)}><em>{String.fromCharCode(65 + k)}</em>{o}</button>)}</div>
    <form className="rq-reply" onSubmit={e => { e.preventDefault(); if (draft.trim()) { onReason(i, draft.trim()); setDraft(''); } }}><input value={draft} onChange={e => setDraft(e.target.value)} placeholder="是故意的？写下理由…" /><button className="rh-btn" disabled={!draft.trim()}>短提交</button></form>
  </article>;
}

/** 本场：出场人物、地点、年表位置、大纲节拍。 */
function SceneCard({ s }: { s: Scene }) {
  return <aside className="nv-sc" key={s.id}>
    <header><span className="rh-ph-no">场</span><span><b>{s.title}</b><small>THIS SCENE · 本场</small></span></header>
    <section><span className="rh-micro">CAST · 出场</span><div className="nv-cast">{s.cast.map(c => <span key={c}><i className="cr-ph" data-small><svg viewBox="0 0 40 48"><circle cx="20" cy="17" r="8" /><path d="M5 48 C 6 32, 34 32, 35 48 Z" /></svg></i><b>{ent(c).name}</b><small>{ent(c).tagline}</small></span>)}</div></section>
    <section><span className="rh-micro">PLACE · 地点</span><p><b>{ent(s.place).name}</b> · {ent(s.place).tagline}</p></section>
    <section><span className="rh-micro">TIMELINE · 年表位置</span><p className="nv-when">夏尔历 {s.when}</p></section>
    <section><span className="rh-micro">BEAT · 大纲节拍</span><p className="nv-beat">{s.beat}</p></section>
    <section><span className="rh-micro">WORDS</span><p>{s.paras.reduce((n, p) => n + p.text.length, 0)} 字 · {s.paras.length} 段</p></section>
  </aside>;
}

/** 节拍板：每章一列，场景卡片可拖动到任意位置。 */
function Beats({ chapters, scene, setScene, moveScene }: { chapters: Chapter[]; scene: string; setScene: (id: string) => void; moveScene: (id: string, to: string, index: number) => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  return <div className="nv-beats">{chapters.map(c => <section key={c.id} onDragOver={e => { e.preventDefault(); setOver(`${c.id}:end`); }} onDrop={() => { if (drag) moveScene(drag, c.id, c.scenes.length); setDrag(null); setOver(null); }}>
    <header><em>{c.no}</em><b>{c.title}</b><small>{c.scenes.length} 场</small></header>
    {c.scenes.map((s, i) => <article key={s.id} draggable onDragStart={() => setDrag(s.id)} onDragEnd={() => { setDrag(null); setOver(null); }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setOver(`${c.id}:${i}`); }} onDrop={e => { e.stopPropagation(); if (drag) moveScene(drag, c.id, i); setDrag(null); setOver(null); }}
      data-drag={drag === s.id || undefined} data-over={over === `${c.id}:${i}` || undefined} aria-current={s.id === scene || undefined} onClick={() => setScene(s.id)} style={{ '--i': i } as CSSProperties}>
      <span className="rh-micro">{s.beat}</span><b>{s.title}</b><p>{s.paras[0]?.text.slice(0, 46)}…</p>
      <footer>{s.cast.map(x => <i key={x}>{ent(x).name}</i>)}<small>{s.paras.reduce((n, p) => n + p.text.length, 0)} 字</small></footer>
    </article>)}
    <div className="nv-drop" data-over={over === `${c.id}:end` || undefined}>拖到这里</div>
  </section>)}</div>;
}
