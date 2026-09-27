import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, Circle, Copy, FileText, GitBranch, Layers2, Maximize2, PanelLeftClose, PanelLeftOpen, Play, Presentation, Square, Terminal, X } from 'lucide-react';
import { buildTree, initialTurns, newTurn, platforms, type Mode, type Platform, type Turn } from '../model';
import { EigenDiagram } from './Visuals';
import ShinyText from './reactbits/ShinyText';

function loadTurns(key: string, platform: Platform, fresh = false): Turn[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (Array.isArray(parsed) && parsed.length && parsed.every(t =>
      typeof t.id === 'string' && (t.parent === null || typeof t.parent === 'string')
      && typeof t.prompt === 'string' && typeof t.body === 'string' && typeof t.title === 'string'
      && ['intro', 'geometry', 'practice', 'summary', 'custom'].includes(t.kind)
      && ['complete', 'running', 'stopped'].includes(t.status)
    )) return parsed.map(t => t.status === 'running' ? { ...t, status: 'stopped', body: '上次的本地演示已中断。可以从这个节点继续探索。' } : t);
  } catch { /* Invalid or unavailable local storage falls back to examples. */ }
  return fresh ? [] : initialTurns(platform);
}

export default function Conversation({ platform, unit, workspace, storageScope, fresh = false, reduced, defaultMode, onBack, notify }: {
  platform: Platform; unit: string; workspace: string; storageScope: string; fresh?: boolean; reduced: boolean; defaultMode: Mode;
  onBack: () => void; notify: (text: string) => void;
}) {
  const storageKey = `reinlab-turns-v1:${storageScope}:${workspace}:${unit}`;
  const [turns, setTurns] = useState<Turn[]>(() => loadTurns(storageKey, platform, fresh));
  const [selected, setSelected] = useState(() => {
    const loaded = loadTurns(storageKey, platform, fresh);
    return loaded.at(-1)?.id ?? '';
  });
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [slidePositions, setSlidePositions] = useState<Record<string, number>>({});
  const [experimentValues, setExperimentValues] = useState<Record<string, number>>({});
  const [processOpen, setProcessOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState(0);
  const [focus, setFocus] = useState(false);
  const [accepted, setAccepted] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(`${storageKey}:accepted`) ?? '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
  });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const current = turns.find(t => t.id === selected) ?? turns.at(-1) ?? {
    id: '00', parent: null, title: '新的探索', prompt: '', body: '', kind: 'custom', status: 'complete',
  } satisfies Turn;
  const running = turns.find(t => t.status === 'running');
  const hasChild = turns.some(t => t.parent === selected);
  const slide = slidePositions[current.id] ?? 0;
  const config = platforms.find(p => p.id === platform)!;
  const learning = platform === 'learning';
  const orderedTurns = buildTree(turns);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(turns)); } catch { /* Session remains usable without storage. */ }
  }, [turns, storageKey]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') setFocus(false); };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);

  function submit() {
    if (!input.trim() || running) return;
    const next = newTurn(turns, selected || null, input.trim());
    setTurns(prev => [...prev, next]);
    setSelected(next.id);
    setInput('');
    setPhase(0);
    setProcessOpen(true);
    timers.current.forEach(clearTimeout);
    timers.current = [
      setTimeout(() => setPhase(1), 900),
      setTimeout(() => setPhase(2), 1900),
      setTimeout(() => {
        setTurns(prev => prev.map(t => t.id === next.id ? { ...t, status: 'complete',
          body: `已将「${next.prompt}」记录为这次探索的新问题。\n\n这是一条本地演示回应，用来体验分支创建、过程状态和卡片呈现，并非 DeepSeek 生成的答案。实际使用时，这里会呈现模型的完整回应及交互内容。\n\n你可以返回之前的节点，尝试从不同位置继续，观察对话树如何保留每一条路径。` } : t));
        setPhase(3);
      }, 3200),
    ];
  }

  function stop() {
    timers.current.forEach(clearTimeout);
    setTurns(prev => prev.map(t => t.status === 'running' ? { ...t, status: 'stopped', body: '本次演示已停止。输入和分支位置已保留，你可以从这里继续。' } : t));
    setPhase(0);
  }

  function accept() {
    const next = accepted.includes(current.id) ? accepted.filter(x => x !== current.id) : [...accepted, current.id];
    setAccepted(next);
    try { localStorage.setItem(`${storageKey}:accepted`, JSON.stringify(next)); } catch { /* Optional persistence. */ }
    notify(next.includes(current.id) ? '已将此节点加入重点笔记' : '已取消重点笔记');
  }

  function selectNode(id: string) {
    if (scrollRef.current) scrollPositions.current[selected] = scrollRef.current.scrollTop;
    setSelected(id);
  }

  const slideTitles = ['先建立直觉', '用交互检验', '把理解留下来'];
  return <div className={`conversation-view ${focus ? 'focused' : ''}`}>
    <div className="conversation-heading">
      <button className="icon-button" onClick={onBack} aria-label="返回工作区"><ArrowLeft size={18} /></button>
      <div><div className="eyebrow">{config.english} / {workspace}</div><h1>{unit}<span className="outline-label">探索中</span></h1></div>
      <div className="conversation-heading-end"><span className="demo-label"><i /> 本地演示</span><button className="icon-button" onClick={() => setFocus(v => !v)} aria-label={focus ? '退出专注模式' : '专注模式'}>{focus ? <X size={17} /> : <Maximize2 size={17} />}</button></div>
    </div>
    <div className={`conversation-layout ${treeOpen ? '' : 'tree-hidden'}`}>
      <aside className="conversation-tree">
        <div className="tree-title"><span><GitBranch size={15} /> 对话路径</span><button className="icon-button" onClick={() => setTreeOpen(false)} aria-label="收起对话树"><PanelLeftClose size={15} /></button></div>
        <p className="tree-description">每一次追问，都是新的可能。</p>
        <div className="tree-nodes">
          {orderedTurns.map(({ turn, depth }, index) => {
            const parentIndex = orderedTurns.findIndex(row => row.turn.id === turn.parent);
            if (parentIndex < 0) return null;
            return <span aria-hidden="true" className="tree-edge" key={`edge-${turn.id}`} style={{ '--parent-index': parentIndex, '--child-index': index, '--parent-depth': Math.min(orderedTurns[parentIndex].depth, 4), '--child-depth': Math.min(depth, 4) } as React.CSSProperties} />;
          })}
          {orderedTurns.map(({ turn, depth }) => <button key={turn.id} className={`tree-node ${turn.id === selected ? 'selected' : ''} ${turn.status === 'running' ? 'is-running' : ''}`} style={{ '--depth': Math.min(depth, 4) } as React.CSSProperties} onClick={() => selectNode(turn.id)} aria-current={turn.id === selected ? 'step' : undefined}>
            <span className="tree-connector" /><span className="tree-dot">{turn.status === 'complete' ? <Check size={9} /> : <Circle size={8} />}</span>
            <span className="tree-node-copy"><span className="mono">NODE {turn.id}{turn.parent && turns.filter(t => t.parent === turn.parent).length > 1 && <GitBranch size={10} />}</span><b>{turn.title}</b></span>
          </button>)}
        </div>
        <div className="tree-bottom"><span><i className="tiny-dot" /> {turns.length} 个节点</span><span>{turns.filter(t => turns.filter(s => s.parent === t.parent).length > 1 && t.parent).length ? '含分支' : '主路径'}</span></div>
        <div className="tree-note"><GitBranch size={16} /><p>从历史节点继续，<br />原来的探索也会被保留。</p></div>
      </aside>
      <section className="conversation-center">
        <div className="response-toolbar">
          <div className="response-position">{!treeOpen && <button className="icon-button" onClick={() => setTreeOpen(true)} aria-label="展开对话树"><PanelLeftOpen size={16} /></button>}<span className="mono">{turns.length ? `RESPONSE / ${current.id}` : 'AWAITING INPUT'}</span><span className="toolbar-separator" /><span>{!turns.length ? '准备就绪' : current.status === 'running' ? '正在生成' : current.status === 'stopped' ? '已停止' : '已完成'}</span></div>
          <div className="segmented"><button className={mode === 'document' ? 'active' : ''} onClick={() => setMode('document')} aria-pressed={mode === 'document'}><FileText size={13} /> 纵向阅读</button><button className={mode === 'slides' ? 'active' : ''} onClick={() => setMode('slides')} aria-pressed={mode === 'slides'}><Presentation size={14} /> 幻灯片</button></div>
        </div>
        <div className="response-scroll" ref={scrollRef}>
          {!turns.length ? <div className="empty-conversation"><Layers2 size={38} /><span className="eyebrow">A NEW EXPLORATION</span><h2>从一个好问题开始。</h2><p>在下方输入你的第一个问题。<br />每一轮完整对话，都会成为这份档案中的一个节点。</p><button className="secondary-button" onClick={() => { setInput('我想先建立对这个主题的直观理解。'); inputRef.current?.focus(); }}>帮我建立直觉 <ArrowUp size={14} /></button><small>当前为本地交互演示，不会发送到真实模型。</small></div> : <>
          <AnimatePresence mode="wait" initial={false}>
            <motion.article key={current.id} className="response-card"
              initial={reduced ? false : { opacity: 0, scaleY: .06, filter: 'blur(3px)' }}
              animate={{ opacity: 1, scaleY: 1, filter: 'blur(0px)' }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scaleY: .06, filter: 'blur(3px)' }}
              transition={{ duration: reduced ? 0 : .23, ease: [.22, 1, .36, 1] }}
              onAnimationComplete={() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollPositions.current[current.id] ?? 0; }}>
              <div className="card-topline"><span><span className="tiny-square" /> REINLAB KNOWLEDGE RECORD</span><span className="mono">RL—{current.id.padStart(3, '0')}</span></div>
              <div className="user-question"><span>你的问题</span><p>{current.prompt}</p></div>
              <button className={`process-toggle ${current.status === 'running' ? 'running' : ''}`} onClick={() => setProcessOpen(v => !v)} aria-expanded={processOpen}>
                <span className={current.status === 'running' ? 'breathing-dot' : 'process-check'}>{current.status !== 'running' && <Check size={12} />}</span>
                {current.status === 'running' ? <ShinyText text={['正在理解这次探索…', '正在整理内容结构…', '正在组织回应卡片…'][Math.min(phase, 2)]} color="#6e7862" shineColor="#bec5a3" disabled={reduced} speed={2.2} /> : <span>思考与工具过程 <small>· 演示记录</small></span>}
                <ChevronDown size={13} className={processOpen ? 'rotated' : ''} />
              </button>
              {processOpen && <div className="process-detail"><div><Check size={12} /><span>识别当前问题与分支位置</span></div><div>{current.status === 'running' && phase < 1 ? <Circle size={11} /> : <Check size={12} />}<span>组织卡片结构与显示组件</span></div><div><Terminal size={12} /><span>工具调用演示 · 未执行真实工具</span><span className="process-status">LOCAL</span></div><p>此处仅演示过程呈现，不是真实模型思考或工具日志。</p></div>}
              {current.status === 'running' ? <div className="generation-placeholder" aria-live="polite"><div className="skeleton-line long" /><div className="skeleton-line" /><div className="skeleton-line short" /><div className="skeleton-panel"><Layers2 size={28} /><span>正在将想法整理成一张卡片</span></div></div> : <>
                {mode === 'document' ? <div className="document-content">
                  <div className="response-kicker">EXPLORATION NOTE / {current.kind === 'custom' ? 'LOCAL PREVIEW' : learning ? 'LINEAR ALGEBRA' : config.english}</div>
                  <h2>{current.kind === 'custom' ? '让这次探索，继续向前。' : learning ? current.kind === 'summary' ? '把公式，还原成直觉。' : '有些方向，不会被改变。' : '让问题，逐渐清晰。'}</h2>
                  <p className="response-lead">{current.body}</p>
                  {current.kind !== 'custom' && learning && <><div className="equation"><span>Av = λv</span><p>方向的坚持，与尺度的改变。</p><span className="equation-number">( 01 )</span></div><EigenDiagram value={experimentValues[current.id] ?? 1.8} onChange={value => setExperimentValues(prev => ({ ...prev, [current.id]: value }))} /><div className="insight-note"><span>观察笔记</span><p>拖动上方的 λ。水平向量的长度改变了，但它始终沿着同一条直线。</p></div></>}
                  {current.kind !== 'custom' && !learning && <div className="exploration-table"><div><span>阶段</span><span>目标</span><span>状态</span></div>{['观察与收集', '比较与判断', '尝试与验证'].map((x, i) => <div key={x}><b>0{i + 1} / {x}</b><span>{['明确问题边界', '保留不同路径', '记录实际结果'][i]}</span><span className="status-text">{i ? '待探索' : '进行中'}</span></div>)}</div>}
                  <div className="response-footnote"><span>保留好奇，也保留证据。</span><span className="mono">{current.status === 'stopped' ? 'STOPPED' : 'END OF RECORD'} <span className="tiny-square" /></span></div>
                </div> : <div className="slide-container" onKeyDown={e => { if (e.target !== e.currentTarget && (e.target as HTMLElement).tagName === 'INPUT') return; if (e.key === 'ArrowRight') setSlidePositions(s => ({ ...s, [current.id]: Math.min(2, slide + 1) })); if (e.key === 'ArrowLeft') setSlidePositions(s => ({ ...s, [current.id]: Math.max(0, slide - 1) })); }}>
                  <AnimatePresence mode="wait" initial={false}><motion.div key={slide} className="slide" initial={{ opacity: 0, x: reduced ? 0 : 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: reduced ? 0 : -12 }} transition={{ duration: reduced ? 0 : .2 }}>
                    <span className="response-kicker">CHAPTER 0{slide + 1} / {current.kind === 'custom' ? 'LOCAL PREVIEW' : config.english}</span>
                    <h2>{current.kind === 'custom' ? ['这次新的追问', '本地交互演示', '沿着分支继续'][slide] : slideTitles[slide]}</h2>
                    {slide === 0 ? <><p className="response-lead">{current.body}</p>{learning && current.kind !== 'custom' && <div className="equation slide-equation"><span>Av = λv</span><p>不变的方向，变化的尺度。</p></div>}</> : slide === 1 && learning && current.kind !== 'custom' ? <EigenDiagram compact value={experimentValues[current.id] ?? 1.8} onChange={value => setExperimentValues(prev => ({ ...prev, [current.id]: value }))} /> : <div className="slide-takeaway"><span className="large-slide-number">0{slide + 1}</span><p>{slide === 1 ? '把想法变成可以验证的问题。比较不同路径，再用证据做出选择。' : '理解不止于一次回答。回到任意节点，换一个角度，再次出发。'}</p><button className="text-link" onClick={() => { inputRef.current?.focus(); setInput('从另一个角度解释这个问题'); }}>继续追问 <ArrowUp size={14} /></button></div>}
                  </motion.div></AnimatePresence>
                  <div className="slide-controls"><span className="mono">0{slide + 1} <i>/ 03</i></span><div className="slide-dots">{[0, 1, 2].map(s => <button aria-label={`第 ${s + 1} 页`} aria-current={slide === s ? 'true' : undefined} key={s} className={slide === s ? 'active' : ''} onClick={() => setSlidePositions(p => ({ ...p, [current.id]: s }))} />)}</div><div><button className="icon-button" disabled={slide === 0} aria-label="上一页" onClick={() => setSlidePositions(p => ({ ...p, [current.id]: slide - 1 }))}><ChevronLeft size={17} /></button><button className="icon-button" disabled={slide === 2} aria-label="下一页" onClick={() => setSlidePositions(p => ({ ...p, [current.id]: slide + 1 }))}><ChevronRight size={17} /></button></div></div>
                </div>}
              </>}
            </motion.article>
          </AnimatePresence>
          <div className="response-actions"><button onClick={accept}><Check size={13} />{accepted.includes(current.id) ? '已加入重点笔记' : '加入重点笔记'}</button><button onClick={async () => { try { await navigator.clipboard.writeText(`${current.prompt}\n\n${current.body}`); notify('已复制这一轮对话'); } catch { notify('无法访问剪贴板，请选中文字复制'); } }}><Copy size={13} />复制回应</button><span>内容仅用于交互设计演示</span></div>
          </>}
        </div>
        <div className="composer-area">
          <div className="composer-context"><span><GitBranch size={12} /> {turns.length ? `从节点 ${selected} 继续` : '即将创建第一个对话节点'}{hasChild && <b> · 将创建新分支</b>}</span>{turns.length > 0 && selected !== turns[turns.length - 1].id && <button onClick={() => selectNode(turns[turns.length - 1].id)}>回到最新 <ArrowDown size={12} /></button>}</div>
          <form className="composer" onSubmit={e => { e.preventDefault(); submit(); }}>
            <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} placeholder="输入你的问题，继续这次探索…" aria-label="输入你的问题" rows={2} maxLength={4000} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
            <div className="composer-bottom"><span><span className="model-dot" /> DeepSeek <span className="outline-label">演示模式</span></span><div><span className="shortcut-hint">⌘ / Ctrl ↵</span>{running ? <button type="button" className="send-button" aria-label="停止演示生成" onClick={stop}><Square size={14} /></button> : <button type="submit" className="send-button" disabled={!input.trim()} aria-label="发送问题"><ArrowUp size={18} /></button>}</div></div>
          </form>
          <p className="composer-disclaimer">{running ? <><Play size={10} /> 正在模拟生成，可切换节点查看历史</> : '你的思考值得被记录，每一条分支都不会丢失。'}</p>
        </div>
      </section>
    </div>
  </div>;
}
