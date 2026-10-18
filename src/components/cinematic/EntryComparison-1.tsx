import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGroup, useReducedMotion } from 'motion/react';
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Play, RotateCcw, SkipForward, X } from 'lucide-react';
import ArchiveField, { type ArchiveFieldHandle } from './ArchiveField';
import BootStage, { CinematicBrand, type BootStageHandle } from './BootStage';
import { BOOT_END, DEFAULT_CELL, FILM_END, type Cell } from './timeline';
import { entryWorkbenches, modulo, type EntryWorkbench } from './entryWorkbenches';
import './cinematic.css';
import './cinematic-polish.css';
import './entry-comparison.css';
import Logo from './WorkbenchLogo';
import ArchitecturalWorkbenchChooser, { type ArchitecturalDesign } from './ArchitecturalWorkbenchChooser';
import FileWorkbenchChooser from './FileWorkbenchChooser';
import CeremonyWorkbenchChooser, { ceremonyDesigns, type CeremonyDesign } from './CeremonyWorkbenchChooser';
import { flightQuad, markerQuad, matrixFor, rectQuad, type Quad } from './sealFlight';
import './entry-handoff.css';

type Variant = 'files' | 'workbenches';
type Stage = 'opening' | 'global' | 'chooser' | 'module' | 'detail';
type EntryDesign = ArchitecturalDesign | CeremonyDesign;
const entryDesigns: EntryDesign[] = ['matrix', 'glass', 'axis', ...ceremonyDesigns];
// Size of the flying logo during the handoff into Files, in CSS pixels.
const FLYER = 220;
const SEAL_FLIGHT = 1150;
const isCeremony = (design: EntryDesign): design is CeremonyDesign => (ceremonyDesigns as string[]).includes(design);


function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export default function EntryComparison() {
  const initialVariant = new URLSearchParams(window.location.search).get('variant') === 'workbenches' ? 'workbenches' : 'files';
  const reduced = !!useReducedMotion();
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [design, setDesign] = useState<EntryDesign>(() => {
    const choice = new URLSearchParams(window.location.search).get('design');
    return entryDesigns.includes(choice as EntryDesign) ? choice as EntryDesign : 'catalog';
  });
  const [stage, setStage] = useState<Stage>(reduced ? initialVariant === 'files' ? 'global' : 'chooser' : 'opening');
  const [selected, setSelected] = useState<Cell>({ ...DEFAULT_CELL });
  const [workbenchIndex, setWorkbenchIndex] = useState(0);
  const [orbitIndex, setOrbitIndex] = useState(0);
  const [picked, setPicked] = useState<EntryWorkbench | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [sceneSession, setSceneSession] = useState(0);
  const [transfer, setTransfer] = useState<EntryWorkbench | null>(null);
  const [runningDemo, setRunningDemo] = useState(false);
  const [bootVisible, setBootVisible] = useState(true);
  // Handoff into Files: the chooser stays on screen while it fades, the field
  // arrives, and the logo is laid onto the selected cassette as a seal.
  const [chooserHandoff, setChooserHandoff] = useState(false);
  const [arriving, setArriving] = useState(false);
  const [sealing, setSealing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<ArchiveFieldHandle>(null);
  const boot = useRef<BootStageHandle>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const transferLogo = useRef<HTMLDivElement>(null);
  const cornerLogo = useRef<HTMLDivElement>(null);
  const control = useRef<AbortController | null>(null);
  const animations = useRef<Animation[]>([]);
  const clock = useRef(17.76);
  const elapsed = useRef(0);
  const previous = useRef<number | null>(null);
  const stageRef = useRef(stage);
  const variantRef = useRef(variant);
  const fieldExtracting = useRef(false);
  const chooserRendered = useRef(false);
  const filmDone = useRef<(() => void) | null>(null);
  const [size, setSize] = useState({ width: 1280, height: 800 });
  stageRef.current = stage; variantRef.current = variant;
  const portrait = size.width < size.height * .8;
  const scale = Math.min(size.width / 1920, size.height / 1080);
  const sceneScale = portrait && stage !== 'opening' ? Math.max(size.width / 1920, size.height / 1080) * .76 : scale;
  const landing = (choice: Variant): Stage => choice === 'files' ? 'global' : 'chooser';
  const currentWorkbench = picked ?? entryWorkbenches[workbenchIndex];

  const cancel = useCallback(() => {
    control.current?.abort(); control.current = null;
    animations.current.splice(0).forEach(animation => animation.cancel());
    fieldExtracting.current = false;
    filmDone.current?.(); filmDone.current = null;
    setTransfer(null); setRunningDemo(false);
    setChooserHandoff(false); setArriving(false); setSealing(false);
  }, []);
  const reset = useCallback((choice: Variant = variantRef.current) => {
    cancel(); setPicked(null); setWorkbenchIndex(0); setOrbitIndex(0); setFileIndex(0);
    setSceneSession(session => session + 1);
    chooserRendered.current = false;
    setSelected({ ...DEFAULT_CELL }); setStage(landing(choice));
    clock.current = FILM_END;
    root.current?.focus({ preventScroll: true });
  }, [cancel]);
  function chooseVariant(choice: Variant) {
    setVariant(choice); variantRef.current = choice; reset(choice);
    const url = new URL(window.location.href); url.searchParams.set('variant', choice);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }
  function chooseDesign(choice: EntryDesign) {
    setDesign(choice); setVariant('workbenches'); variantRef.current = 'workbenches'; reset('workbenches');
    const url = new URL(window.location.href); url.searchParams.set('variant','workbenches'); url.searchParams.set('design',choice);
    window.history.replaceState(null,'',`${url.pathname}${url.search}`);
  }

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    document.title = `${variant === 'files' ? 'A · Files 优先' : 'B · 工作台优先'} — ReinLab 入口演示`;
  }, [variant]);
  useEffect(() => {
    let frame = 0;
    const draw = (now: number) => {
      const wallDelta = previous.current === null ? 0 : Math.max(0, (now - previous.current) / 1000);
      previous.current = now;
      if (document.hidden) { frame = requestAnimationFrame(draw); return; }
      const delta = Math.min(.045, wallDelta);
      elapsed.current += delta;
      const opening = stageRef.current === 'opening';
      if (opening) {
        clock.current = Math.min(FILM_END, clock.current + wallDelta);
        boot.current?.update(clock.current, true, 'LOCAL RESEARCHER');
        if (clock.current >= BOOT_END && bootVisible) setBootVisible(false);
        if (clock.current >= FILM_END) {
          stageRef.current = landing(variantRef.current);
          setStage(landing(variantRef.current));
          filmDone.current?.(); filmDone.current = null;
        }
      }
      // Keep the archival backdrop still while the logo selector is active.
      // Only the selected emblem needs to animate in this view.
      if (stageRef.current !== 'chooser' || !chooserRendered.current) {
        field.current?.update({ time: clock.current, elapsed: elapsed.current, delta,
          film: opening, detail: stageRef.current === 'detail' || fieldExtracting.current,
          reduced, portrait, visible: !opening || clock.current >= BOOT_END });
        chooserRendered.current = stageRef.current === 'chooser';
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [reduced, portrait, bootVisible]);
  useEffect(() => () => {
    control.current?.abort(); animations.current.forEach(animation => animation.cancel());
  }, []);
  useEffect(() => {
    if (reduced && stage === 'opening') {
      clock.current = FILM_END; setStage(landing(variant));
      filmDone.current?.(); filmDone.current = null;
    }
  }, [reduced, stage, variant]);

  function playOpening(at: number, signal?: AbortSignal) {
    return new Promise<void>(resolve => {
      filmDone.current = resolve;
      setPicked(null); setSelected({ ...DEFAULT_CELL }); setWorkbenchIndex(0); setOrbitIndex(0); setFileIndex(0);
      if (reduced) { setStage(landing(variantRef.current)); filmDone.current = null; resolve(); return; }
      clock.current = at; previous.current = null; field.current?.reset();
      chooserRendered.current = false;
      setBootVisible(true); setStage('opening'); stageRef.current = 'opening';
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  async function openWorkbench(workbench: EntryWorkbench, source?: HTMLElement, ownedSignal?: AbortSignal, sourceCell?: Cell) {
    if (transfer || (!ownedSignal && runningDemo)) return;
    if (!ownedSignal) { cancel(); control.current = new AbortController(); }
    const signal = ownedSignal ?? control.current!.signal;
    const bounds = root.current?.getBoundingClientRect();
    const origin = { x: bounds?.x ?? 0, y: bounds?.y ?? 0, width: bounds?.width ?? window.innerWidth, height: bounds?.height ?? window.innerHeight };
    const sourceBounds = source?.querySelector('.entry-logo')?.getBoundingClientRect();
    const sourceRect = sourceBounds && sourceBounds.width > 8 && sourceBounds.right > 0 && sourceBounds.left < window.innerWidth && sourceBounds.bottom > 0 && sourceBounds.top < window.innerHeight ? sourceBounds : undefined;
    const fromChooser = stageRef.current === 'chooser';
    let marked: HTMLElement | undefined;
    try {
      const index = entryWorkbenches.indexOf(workbench);
      setWorkbenchIndex(index);
      if (reduced) {
        setPicked(workbench); setFileIndex(0); setSelected({ ...DEFAULT_CELL }); setStage('module');
        return;
      }
      if (variantRef.current === 'files') {
        setSelected(sourceCell ?? { lane: 1, row: 12 + index });
        fieldExtracting.current = true;
        await wait(340, signal);
      }
      // The flying logo starts exactly where the chosen logo is on screen.
      const from: Quad = sourceRect
        ? rectQuad(sourceRect.x - origin.x, sourceRect.y - origin.y, sourceRect.width, sourceRect.height)
        : rectQuad(origin.width / 2 - FLYER / 2, origin.height / 2 - FLYER / 2, FLYER, FLYER);
      if (sourceRect && source) { marked = source; source.dataset.handoffSource = 'true'; }
      // Files arrives underneath while the chooser fades out above it.
      fieldExtracting.current = false;
      setTransfer(workbench); setSealing(true); setArriving(fromChooser); setChooserHandoff(fromChooser);
      setPicked(workbench); setFileIndex(0); setSelected({ ...DEFAULT_CELL }); setStage('module');
      await wait(30, signal);
      const flyer = transferLogo.current;
      if (!flyer) return;
      // Settle the archive camera on the selected cassette at once, so the field
      // is in place under the chooser as it fades (the old paper layer hid this).
      field.current?.update({ time: clock.current, elapsed: elapsed.current, delta: 1 / 60, film: false, detail: false, reduced: true, portrait, visible: true });
      flyer.style.transform = matrixFor(FLYER, FLYER, from);
      field.current?.pulse?.(DEFAULT_CELL);
      // Each frame, re-measure the seal on the selected cassette (the field is
      // still settling) and morph the logo's corners onto it.
      const seal = () => markerQuad(root.current?.querySelector('.cine-cassette.selected .entry-seal') ?? null, origin);
      await new Promise<void>((resolve, reject) => {
        const started = performance.now(); let frame = 0; let landing: Quad = from;
        const stop = () => { cancelAnimationFrame(frame); reject(new DOMException('Cancelled', 'AbortError')); };
        signal.addEventListener('abort', stop, { once: true });
        const step = (now: number) => {
          const progress = Math.min(1, (now - started) / SEAL_FLIGHT);
          landing = seal() ?? landing;
          flyer.style.transform = matrixFor(FLYER, FLYER, flightQuad(from, landing, progress));
          if (progress < 1) frame = requestAnimationFrame(step);
          else { signal.removeEventListener('abort', stop); resolve(); }
        };
        frame = requestAnimationFrame(step);
      });
      // The etched seal takes over from the flying logo in the same place.
      setSealing(false); flyer.style.opacity = '0';
      await wait(420, signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    } finally {
      if (marked) delete marked.dataset.handoffSource;
      if (!signal.aborted) {
        setTransfer(null); setChooserHandoff(false); setArriving(false); setSealing(false);
        fieldExtracting.current = false;
      }
    }
  }

  async function autoDemo() {
    if (runningDemo) { reset(); return; }
    cancel(); const controller = new AbortController(); control.current = controller;
    setRunningDemo(true);
    try {
      await playOpening(17.76, controller.signal);
      await wait(reduced ? 0 : 1200, controller.signal);
      const source = variantRef.current === 'workbenches' ? workbenchSource('curriculum') : undefined;
      await openWorkbench(entryWorkbenches[0], source ?? undefined, controller.signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    } finally { if (!controller.signal.aborted) setRunningDemo(false); }
  }

  function selectGlobal(index: number) {
    if (transfer || runningDemo) return;
    const next = modulo(index, entryWorkbenches.length);
    setWorkbenchIndex(next); setSelected({ lane: 1, row: 12 + next });
  }
  function selectFile(index: number, extract = false, sourceCell?: Cell) {
    if (transfer || runningDemo) return;
    setFileIndex(index); setSelected(sourceCell ?? { lane: 1, row: 12 + index });
    if (extract) setStage('detail');
  }
  const content = useMemo(() => ({
    title: picked?.title ?? '莱茵生命总档案', english: picked?.english ?? 'RHINE LAB / CENTRAL FILES',
    nameFor: (cell: Cell) => picked
      ? picked.files[modulo(cell.row - 12, 4)]
      : entryWorkbenches[modulo(cell.row - 12, 6)].title,
  }), [picked]);
  // Selected cassette front in Files: the archive face plus the workbench seal.
  const sealFace = useMemo(() => picked ? <>
    <span className="cassette-frost" /><span className="cassette-specular" />
    <span className="entry-seal"><i data-corner="0" /><i data-corner="1" /><i data-corner="2" /><i data-corner="3" /><Logo workbench={picked} still /></span>
    <span className="cassette-border" />
    <span className="cassette-slot" />
    <span className="cassette-screw screw-upper" /><span className="cassette-screw screw-lower" />
    <span className="cassette-etching">RHINE LAB<span>INTERNAL DATABASE</span></span>
    <span className="cassette-serial">X—{String(selected.row + 1).padStart(3, '0')}<span>{picked.english}</span></span>
    <span className="cassette-security-line"><i /><i /></span>
    <span className="cassette-security-tag">CONFIDENTIALITY:<b>GENERAL BUSINESS USE</b></span>
  </> : undefined, [picked, selected.row]);
  const steps = variant === 'files' ? ['开场', '总 Files', '工作台标识', '模块 Files'] : ['开场', '选择工作台', '标识转场', '模块 Files'];
  const step = stage === 'opening' ? 0 : transfer ? 2 : stage === 'module' || stage === 'detail' ? 3 : 1;
  const orbitWorkbench = entryWorkbenches[orbitIndex];
  function selectOrbit(index: number) {
    if (transfer || runningDemo) return;
    setOrbitIndex(modulo(index, entryWorkbenches.length));
  }
  function enterOrbit() {
    const source = workbenchSource(orbitWorkbench.id);
    void openWorkbench(orbitWorkbench, source ?? undefined);
  }
  function workbenchSource(id:string) {
    return root.current?.querySelector<HTMLElement>(`.file-workbench-mark[data-workbench="${id}"]`) ?? root.current?.querySelector<HTMLElement>(`[data-workbench="${id}"]`);
  }

  return <LayoutGroup id="entry-comparison"><main ref={root} className={`cinema-experience entry-comparison ${reduced ? 'cine-reduced' : ''}`} data-stage={stage} data-variant={variant} data-design={design} data-transferring={!!transfer} data-arriving={arriving} data-sealing={sealing} tabIndex={-1}
    aria-label="ReinLab 两种入口演示" onKeyDown={event => {
      if (transfer || runningDemo) return;
      if (stage === 'chooser' && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); selectOrbit(orbitIndex + (event.key === 'ArrowLeft' ? -1 : 1)); return; }
      if ((event.target as HTMLElement).closest('button,a,input,select,textarea')) return;
      if (stage === 'chooser' && event.key === 'Enter' && !isCeremony(design)) { event.preventDefault(); enterOrbit(); }
      if (event.key === 'Escape') { event.preventDefault(); if (stage === 'detail') setStage('module'); else reset(); }
      if (stage === 'global' && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); selectGlobal(workbenchIndex + (event.key === 'ArrowLeft' ? -1 : 1)); }
      if (stage === 'global' && event.key === 'Enter') { event.preventDefault(); void openWorkbench(entryWorkbenches[workbenchIndex]); }
    }}>
    <header className="entry-compare-bar">
      <span className="entry-study-label"><i />入口动线演示</span>
      <div className="entry-variant-buttons" role="group" aria-label="选择入口方案">
        <button aria-pressed={variant === 'files'} onClick={() => chooseVariant('files')}>A <span>Files 优先</span></button>
        <button aria-pressed={variant === 'workbenches'} onClick={() => chooseVariant('workbenches')}>B <span>工作台优先</span></button>
      </div>
      <div className="entry-demo-controls">
        <button onClick={() => { cancel(); void playOpening(1.76); }}><RotateCcw size={13} /><span>完整开场</span></button>
        <button onClick={() => void autoDemo()}><Play size={12} /><span>{runningDemo ? '停止演示' : '自动演示'}</span></button>
        <button onClick={() => reset()}><ArrowLeft size={13} /><span>回到入口</span></button>
      </div>
    </header>
    {variant === 'workbenches' && <nav className="entry-design-picker" aria-label="工作台入口设计">{([['catalog','档案匣架'],['drafting','制图详图'],['aperture','光圈对焦']] as const).map(([id,name])=><button className="entry-new-design" key={id} aria-pressed={design===id} onClick={()=>chooseDesign(id)}>{name}</button>)}<select aria-label="此前方案" value={isCeremony(design)?'':design} onChange={event=>{if(event.target.value)chooseDesign(event.target.value as EntryDesign);}}><option value="" disabled>此前方案 · 3</option><optgroup label="第二轮"><option value="matrix">浮雕矩阵</option><option value="glass">档案抽取</option><option value="axis">档案穿行</option></optgroup></select></nav>}

    <div ref={viewport} className="cine-scene-viewport entry-field-viewport" style={{ visibility: stage === 'opening' && bootVisible ? 'hidden' : 'visible' }} inert={stage === 'chooser' || !!transfer || stage === 'opening' || runningDemo} aria-hidden={stage === 'chooser' || !!transfer || stage === 'opening'}>
      <div className="cine-fixed-stage cine-model-stage" style={{ transform: `translate(-50%,-50%) scale(${sceneScale})` }}>
        {/* This study transfers the logo rather than the archive surface.
            Keep the real 3D face outside shared layout projection. */}
        <ArchiveField key={sceneSession} ref={field} selected={selected} content={content} sharedElementSurface="both" selectedFace={sealFace} onSelect={cell => {
          if (stage === 'global') void openWorkbench(entryWorkbenches[modulo(cell.row - 12, 6)], undefined, undefined, cell);
          if (stage === 'module') selectFile(modulo(cell.row - 12, 4), true, cell);
        }} />
      </div>
    </div>
    {stage === 'opening' && bootVisible && <div className="cine-fixed-stage cine-boot-stage" style={{ transform: `translate(-50%,-50%) scale(${scale})` }}><BootStage ref={boot} /></div>}
    {stage === 'opening' && <div className="entry-opening-note"><span>RHINE LAB / ACCESS SEQUENCE</span><button onClick={() => { clock.current = FILM_END; setStage(landing(variant)); filmDone.current?.(); filmDone.current = null; }}><SkipForward size={13} />跳过开场，比较入口</button></div>}

    {(stage === 'chooser' || chooserHandoff) && isCeremony(design) && <CeremonyWorkbenchChooser key={`${design}:${sceneSession}`} design={design} selected={orbitIndex} reduced={reduced} locked={!!transfer||runningDemo} handoff={chooserHandoff} onSelect={selectOrbit} onEnter={(workbench,source)=>void openWorkbench(workbench,source)}/>}
    {(stage === 'chooser' || chooserHandoff) && design==='matrix' && <div className="entry-chooser-shell" data-handoff={chooserHandoff}> <ArchitecturalWorkbenchChooser key={`${design}:${sceneSession}`} design={design} selected={orbitIndex} reduced={reduced} locked={!!transfer||runningDemo} onSelect={selectOrbit} onEnter={(workbench,source)=>void openWorkbench(workbench,source)}/></div>}
    {(stage === 'chooser' || chooserHandoff) && (design==='glass'||design==='axis') && <div className="entry-chooser-shell" data-handoff={chooserHandoff}> <FileWorkbenchChooser key={`${design}:${sceneSession}`} design={design} selected={orbitIndex} reduced={reduced} locked={!!transfer||runningDemo} onSelect={selectOrbit} onEnter={(workbench,source)=>void openWorkbench(workbench,source)}/></div>}

    {(stage === 'global' || stage === 'module' || stage === 'detail') && <>
      <div className="entry-brand"><CinematicBrand /></div>
      <div className="entry-files-heading">
        <span>{stage === 'global' ? 'RHINE LAB / CENTRAL FILES' : `${picked!.english} / FILES`}</span>
        <p>{stage === 'global' ? '总档案 · 每份档案指向一个工作台' : `${picked!.title} · 专属档案`}</p>
      </div>
      {picked && <div className="entry-module-identity"><div ref={cornerLogo}><Logo workbench={picked} still /></div><span>{picked.title}<small>{picked.english}</small></span></div>}
      <section className="entry-file-callout" inert={!!transfer || runningDemo}>
        <span className="entry-eyebrow">{stage === 'global' ? 'WORKBENCH ARCHIVE' : `${picked!.fileKind} ARCHIVE`}</span>
        <h1>FILE X—{String(selected.row + 1).padStart(3,'0')}</h1><div className="entry-file-rule"><i /></div>
        <h2>{stage === 'global' ? currentWorkbench.title : picked!.files[fileIndex]}</h2>
        <p>{stage === 'global' ? currentWorkbench.description : '一份档案，一段可以继续的探索。'}</p>
        {stage !== 'detail' && <button className="entry-access" onClick={() => stage === 'global' ? void openWorkbench(currentWorkbench) : setStage('detail')}>{stage === 'global' ? 'ACCESS WORKBENCH' : 'ACCESS FILE'}<ArrowRight size={17} /><span>{stage === 'global' ? '调阅工作台' : '抽取档案'}</span></button>}
      </section>
      {stage === 'global' && <nav className="entry-global-directory" aria-label="总 Files 的工作台档案" inert={!!transfer || runningDemo}>
        <span>WORKBENCH FILES / 06</span>
        {entryWorkbenches.map((workbench, index) => <button key={workbench.id} className={index === workbenchIndex ? 'active' : ''} onClick={() => void openWorkbench(workbench)}><span>X—{String(index + 13).padStart(3,'0')}</span><b>{workbench.title}</b><ArrowUpRight size={12} /></button>)}
      </nav>}
      {stage === 'global' && <div className="entry-selection-nav" inert={!!transfer || runningDemo}><button onClick={() => selectGlobal(workbenchIndex - 1)} aria-label="上一份工作台档案"><ChevronLeft size={19} /></button><div><span>ARCHIVE / {String(workbenchIndex + 1).padStart(2,'0')} OF 06</span><strong>{currentWorkbench.title}</strong></div><button onClick={() => selectGlobal(workbenchIndex + 1)} aria-label="下一份工作台档案"><ChevronRight size={19} /></button></div>}
      {stage === 'module' && <nav className="entry-module-files" aria-label={`${picked!.title}的 Files`} inert={!!transfer || runningDemo}>
        <span>{picked!.fileKind} FILES / 04</span>{picked!.files.map((name,index) => <button key={name} className={fileIndex === index ? 'active' : ''} onClick={() => selectFile(index,true)}><span>{String(index + 1).padStart(2,'0')}</span><b>{name}</b><ArrowUpRight size={12} /></button>)}
      </nav>}
      {stage === 'detail' && <article className="entry-file-detail" aria-label="档案调阅预览"><span className="entry-eyebrow">{picked!.fileKind} / FILE X—{String(selected.row+1).padStart(3,'0')}</span><h2>{picked!.files[fileIndex]}</h2><p>你已从{variant === 'files' ? '总 Files' : '工作台选择'}进入{picked!.title}，<br />并调阅了这份专属档案。</p><div className="entry-file-detail-rule" /><span className="entry-detail-note">{picked!.id === 'curriculum' ? '这里将交接给 OpenMAIC。演示停在进入课堂之前。' : '这里将进入具体的工作现场。当前仅演示入口与档案转场。'}</span><button onClick={() => setStage('module')}><ArrowLeft size={14} />返回模块 Files</button></article>}
    </>}

    {transfer && <div ref={transferLogo} className="entry-flyer" aria-hidden="true"><Logo workbench={transfer} still /></div>}
    <footer className="entry-path-footer"><div aria-label="当前入口路径">{steps.map((label,index) => <span key={label} className={index === step ? 'active' : ''}>{index > 0 && <ChevronRight size={10} />}<b>{label}</b></span>)}</div><span className="entry-local-note">入口预览 · 止于模块 Files</span></footer>
    <a className="entry-exit" href="/workbench-logos/index.html" aria-label="返回动态 LOGO 预览"><X size={12} />LOGOS</a>
    <div className="entry-sr-status" role="status">{stage === 'opening' ? '正在播放开场' : transfer ? `正在展开${transfer.title}` : stage === 'chooser' ? `当前选择：${orbitWorkbench.title}` : stage === 'global' ? '莱茵生命总 Files' : `${picked?.title}的${stage === 'detail' ? '档案调阅' : 'Files'}`}</div>
  </main></LayoutGroup>;
}
