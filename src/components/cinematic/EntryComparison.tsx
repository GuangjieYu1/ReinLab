import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGroup, useReducedMotion } from 'motion/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, ChevronLeft, ChevronRight, Play, RotateCcw, SkipForward, X } from 'lucide-react';
import ArchiveField, { type ArchiveFieldHandle, type FieldStatus } from './ArchiveField';
import BootStage, { CinematicBrand, type BootStageHandle } from './BootStage';
import { BOOT_END, DEFAULT_CELL, FILM_END, type Cell } from './timeline';
import { countLabel, entryWorkbenches, modulo, WORKBENCH_COUNT, type EntryWorkbench } from './entryWorkbenches';
import './cinematic.css';
import './cinematic-polish.css';
import './entry-comparison.css';
import Logo from './WorkbenchLogo';
import ArchitecturalWorkbenchChooser, { type ArchitecturalDesign } from './ArchitecturalWorkbenchChooser';
import FileWorkbenchChooser from './FileWorkbenchChooser';
import CeremonyWorkbenchChooser, { ceremonyDesigns, SECTION_CODES, type CeremonyDesign } from './CeremonyWorkbenchChooser';
import { flightQuad, markerQuad, matrixFor, rectQuad, type Quad } from './sealFlight';
import './entry-handoff.css';
import './files-editorial.css';
import FilePreview, { type SlipAnchor } from '../entry/FilePreview';
import { startTransit, transitActive, TRANSIT_END } from '../entry/transitStore';
import '../entry/entry-shell.css';
import { navigate } from '../../nav';

type Variant = 'files' | 'workbenches';
type Stage = 'opening' | 'global' | 'chooser' | 'module' | 'detail';
type EntryDesign = ArchitecturalDesign | CeremonyDesign;
const entryDesigns: EntryDesign[] = ['matrix', 'glass', 'axis', ...ceremonyDesigns];
// Size of the flying logo during the handoff into Files, in CSS pixels.
const FLYER = 220;
const SEAL_FLIGHT = 1150;
// Workbench-first entry: the opening plays the authorization ring and hands
// over to the chooser at 17.7 s, before the welcome panel and the Files wave.
const RING_START = 14.48;
const RING_HANDOFF = 17.7;
const openingStart = (choice: Variant) => choice === 'workbenches' ? RING_START : 17.76;
const openingEnd = (choice: Variant) => choice === 'workbenches' ? RING_HANDOFF : FILM_END;
const isCeremony = (design: EntryDesign): design is CeremonyDesign => (ceremonyDesigns as string[]).includes(design);


function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

// A workbench page links back with ?return=<workbench>&file=<n>; Files then
// opens on that workbench's module list with the file selected, no opening.
function returnTarget() {
  const query = new URLSearchParams(window.location.search);
  const workbench = entryWorkbenches.find(item => item.id === query.get('return'));
  if (!workbench) return null;
  return { workbench, index: entryWorkbenches.indexOf(workbench), file: Math.min(3, Math.max(0, Number(query.get('file')) || 0)) };
}

// shell='entry' is the product entry after the pseudo login: no comparison
// chrome, straight into the chooser with the design picked by the caller.
export default function EntryComparison({ shell = 'study', initialDesign, hold = false, onLock }: { shell?: 'study' | 'entry'; initialDesign?: CeremonyDesign; hold?: boolean; onLock?: () => void } = {}) {
  const entry = shell === 'entry';
  const [back] = useState(returnTarget);
  // 从工作台返回时，上一页留下的档案页在这里收拢回档案预览卡。
  // 从工作台经标识转场返回：标识会飞回档案盒的印章，之后档案小票再从档案盒里抽出、放到它右边。
  const [returnTransit] = useState(() => entry && !!back && transitActive());
  const initialVariant = entry || new URLSearchParams(window.location.search).get('variant') === 'workbenches' ? 'workbenches' : 'files';
  const reduced = !!useReducedMotion();
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [design, setDesign] = useState<EntryDesign>(() => {
    if (initialDesign) return initialDesign;
    const choice = new URLSearchParams(window.location.search).get('design');
    return entryDesigns.includes(choice as EntryDesign) ? choice as EntryDesign : 'quantum';
  });
  const [stage, setStage] = useState<Stage>(back ? (returnTransit ? 'detail' : 'module') : entry ? 'chooser' : reduced ? initialVariant === 'files' ? 'global' : 'chooser' : 'opening');
  const [selected, setSelected] = useState<Cell>(back ? { lane: 1, row: 12 + back.file } : { ...DEFAULT_CELL });
  const [workbenchIndex, setWorkbenchIndex] = useState(back?.index ?? 0);
  const [orbitIndex, setOrbitIndex] = useState(back?.index ?? 0);
  const [picked, setPicked] = useState<EntryWorkbench | null>(back?.workbench ?? null);
  const [fileIndex, setFileIndex] = useState(back?.file ?? 0);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [sceneSession, setSceneSession] = useState(0);
  const [transfer, setTransfer] = useState<EntryWorkbench | null>(null);
  const [runningDemo, setRunningDemo] = useState(false);
  const [bootVisible, setBootVisible] = useState(!entry);
  // Handoff into Files: the chooser stays on screen while it fades, the field
  // arrives, and the logo is laid onto the selected cassette as a seal.
  const [chooserHandoff, setChooserHandoff] = useState(false);
  const [arriving, setArriving] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [stamped, setStamped] = useState(false);
  // 正式入口专用：档案预览的收起、从 Files 返回选台的标识回飞、从工作台返回时的入场。
  const [detailClosing, setDetailClosing] = useState(false);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [backFlyer, setBackFlyer] = useState<EntryWorkbench | null>(null);
  const [leavingFiles, setLeavingFiles] = useState(false);
  const [chooserReturning, setChooserReturning] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  const [fromDetail, setFromDetail] = useState(false);
  const [previewOrigin, setPreviewOrigin] = useState<SlipAnchor | null>(null);
  // 抽取档案：档案盒真正抽出到位（档案场返回的 detail 进度）之后，小票才从盒里抽出来。
  const [extracting, setExtracting] = useState(false);
  const [cardReady, setCardReady] = useState(false);
  // 档案盒里那张小票此刻在屏幕上的位置，与档案盒上缘（盒口）的高度：小票从盒口取出、放回。档案盒本身是 0×0 的 3D 容器，取它的正面。
  const boxRect = (): SlipAnchor | null => {
    const slip = root.current?.querySelector('.cine-cassette.selected .entry-slip-inside')?.getBoundingClientRect();
    const front = root.current?.querySelector('.cine-cassette.selected .cassette-front')?.getBoundingClientRect();
    return slip && front && slip.width > 4 ? { slip, lip: front.top } : null;
  };
  const fieldStatus = useRef<FieldStatus | null>(null);
  const wheel = useRef({ sum: 0, at: 0 });
  // 进入模块 Files 时把焦点放到入口上（焦点不在任何控件里时），方向键与回车直接可用。
  useEffect(() => { if (entry && stage === 'module' && (!document.activeElement || document.activeElement === document.body)) root.current?.focus({ preventScroll: true }); }, [entry, stage]);
  const waitExtract = useRef(false);
  const onExtracted = useRef<() => void>(() => {});
  const cardReadyRef = useRef(false);
  // 档案小票取下后预取工作台页面的代码与样式：点「继续工作」后切换页面不必临时加载、解析。
  useEffect(() => { if (entry && stage === 'detail') void import('../workbenches/WorkbenchStudio'); }, [entry, stage]);
  useEffect(() => {
    if (!returnTransit) return;
    // 标识落回印章后，档案小票从档案盒里抽出、放到它右边。
    const reveal = () => {
      setPreviewOrigin(boxRect());
      cardReadyRef.current = true; setCardReady(true);
    };
    if (!transitActive()) { reveal(); return; }
    window.addEventListener(TRANSIT_END, reveal, { once: true });
    return () => window.removeEventListener(TRANSIT_END, reveal);
  }, [returnTransit]);
  const [returnArrive, setReturnArrive] = useState(entry && !!back);
  const backLogo = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<ArchiveFieldHandle>(null);
  const boot = useRef<BootStageHandle>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const transferLogo = useRef<HTMLDivElement>(null);
  const cornerLogo = useRef<HTMLDivElement>(null);
  const control = useRef<AbortController | null>(null);
  const animations = useRef<Animation[]>([]);
  const clock = useRef(back || entry ? FILM_END : openingStart(initialVariant));
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
    setChooserHandoff(false); setArriving(false); setSealing(false); setStamped(false);
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
    if (!returnArrive) return;
    const pulse = window.setTimeout(() => field.current?.pulse?.(DEFAULT_CELL), 380);
    const done = window.setTimeout(() => setReturnArrive(false), 1300);
    return () => { clearTimeout(pulse); clearTimeout(done); };
  }, [returnArrive]);
  useEffect(() => {
    if (!back) return;
    const url = new URL(window.location.href); url.searchParams.delete('return'); url.searchParams.delete('file');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, [back]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    document.title = entry ? 'REINLAB — 莱茵生命研究终端' : `${variant === 'files' ? 'A · Files 优先' : 'B · 工作台优先'} — ReinLab 入口演示`;
  }, [variant, entry]);
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
        clock.current = Math.min(openingEnd(variantRef.current), clock.current + wallDelta);
        boot.current?.update(clock.current, true, 'LOCAL RESEARCHER');
        if (clock.current >= BOOT_END && bootVisible) setBootVisible(false);
        if (clock.current >= openingEnd(variantRef.current)) {
          stageRef.current = landing(variantRef.current);
          setStage(landing(variantRef.current));
          filmDone.current?.(); filmDone.current = null;
        }
      }
      // Keep the archival backdrop still while the logo selector is active.
      // Only the selected emblem needs to animate in this view.
      if (stageRef.current !== 'chooser' || !chooserRendered.current) {
        fieldStatus.current = field.current?.update({ time: clock.current, elapsed: elapsed.current, delta,
          film: opening, detail: stageRef.current === 'detail' || fieldExtracting.current,
          reduced, portrait, visible: !opening || clock.current >= BOOT_END }) ?? null;
        if (waitExtract.current && stageRef.current === 'detail' && (fieldStatus.current?.detail ?? 0) > .72) { waitExtract.current = false; onExtracted.current(); }
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
      // 正式入口：Files 阅读层与 128 个档案盒的内容更新放进并发渲染，标识先起飞，不抢这一帧。
      const toModule = () => { setPicked(workbench); setFileIndex(0); setSelected({ ...DEFAULT_CELL }); setStage('module'); };
      if (entry) startTransition(toModule); else toModule();
      await wait(30, signal);
      const flyer = transferLogo.current;
      if (!flyer) return;
      // Settle the archive camera on the selected cassette at once, so the field
      // is in place under the chooser as it fades (the old paper layer hid this).
      field.current?.update({ time: clock.current, elapsed: elapsed.current, delta: 1 / 60, film: false, detail: false, reduced: true, portrait, visible: true });
      flyer.style.transform = matrixFor(FLYER, FLYER, from);
      // Each frame, re-measure the seal on the selected cassette (the field is
      // still settling) and morph the logo's corners onto it.
      // Files 页提交（并发渲染可能晚一两帧）后先把档案场镜头一次性就位，再开始追踪印章；
      // 否则头几帧量到的是未就位的印章位置，标识会先飞向左上角。
      let settled = false;
      const seal = () => {
        if (stageRef.current !== 'module') return null;
        if (!settled) {
          field.current?.update({ time: clock.current, elapsed: elapsed.current, delta: 1 / 60, film: false, detail: false, reduced: true, portrait, visible: true });
          settled = true;
        }
        const quad = markerQuad(root.current?.querySelector('.cine-cassette.selected .entry-seal') ?? null, origin);
        if (!quad) return null;
        const cx = quad.reduce((sum, [x]) => sum + x, 0) / 4, cy = quad.reduce((sum, [, y]) => sum + y, 0) / 4;
        return cx > 0 && cy > 0 && cx < origin.width && cy < origin.height ? quad : null;
      };
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
      // The stamped seal takes over from the flying logo in the same place,
      // and the archive answers the stamp with a wave from that cassette.
      setSealing(false); setStamped(true); flyer.style.opacity = '0';
      field.current?.pulse?.(DEFAULT_CELL);
      await wait(560, signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    } finally {
      if (marked) delete marked.dataset.handoffSource;
      if (!signal.aborted) {
        setTransfer(null); setChooserHandoff(false); setArriving(false); setSealing(false); setStamped(false);
        fieldExtracting.current = false;
      }
    }
  }

  async function autoDemo() {
    if (runningDemo) { reset(); return; }
    cancel(); const controller = new AbortController(); control.current = controller;
    setRunningDemo(true);
    try {
      await playOpening(openingStart(variantRef.current), controller.signal);
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
    // 正式入口的档案场无限：从列表选档案时留在当前这一列、当前这一轮里，换到同一轮的那一格。
    const cell = sourceCell ?? (entry ? { lane: selected.lane, row: selected.row - modulo(selected.row - 12, 4) + index } : { lane: 1, row: 12 + index });
    if (entry && picked) {
      const workbench = workbenchOfLane(cell.lane);
      // 换列：选中格立即移动（镜头先走），整页换成新工作台放进并发渲染，不卡住镜头。
      if (workbench !== picked) { const k = entryWorkbenches.indexOf(workbench); startTransition(() => { setPicked(workbench); setWorkbenchIndex(k); setOrbitIndex(k); }); }
    }
    setFileIndex(index); setSelected(cell);
    if (extract) accessFile(index);
  }
  // 无限档案场的浏览：↑↓ / 滚轮在同一列里前后移动（档案按 4 份一轮循环），←→ 换列（每一列是一个工作台，7 个工作台循环）。
  function stepFile(delta: number) {
    if (stage !== 'module' || openingFile || extracting || transfer || runningDemo) return;
    const row = selected.row + delta;
    selectFile(modulo(row - 12, 4), false, { lane: selected.lane, row });
  }
  function stepColumn(delta: number) {
    if (stage !== 'module' || openingFile || extracting || transfer || runningDemo) return;
    const lane = selected.lane + delta;
    selectFile(modulo(selected.row - 12, 4), false, { lane, row: selected.row });
  }
  // 抽取档案: the curriculum file keeps its OpenMAIC handoff sheet; the other
  // five workbenches open their working page for the chosen file.
  function accessFile(index = fileIndex) {
    if (!picked || transfer || runningDemo || leaving) return;
    // 正式入口：任何工作台的 File 都先展示档案小票，再由「继续工作」进入。
    if (entry && !reduced) {
      if (openingFile || extracting || stage !== 'module') return;
      // 1. 印章闪光、档案盒立即开始抬升；列表与档案号同时分层退开。
      setPreviewNote(null); setDetailClosing(false); setCardReady(false); cardReadyRef.current = false; setOpeningFile(true); setExtracting(true);
      fieldExtracting.current = true;
      // 3. 档案盒抽出到位的那一刻，小票从盒子右缘抽出、放到它右边；万一迟迟未到位，1.6 秒后照常抽出。
      const reveal = () => {
        if (cardReadyRef.current) return;
        waitExtract.current = false; cardReadyRef.current = true;
        setPreviewOrigin(boxRect()); setCardReady(true); setExtracting(false);
      };
      onExtracted.current = reveal; waitExtract.current = true;
      // 2. 阅读层退完后进入 detail（档案场早已在抽取中，不会停顿）。
      window.setTimeout(() => { setOpeningFile(false); setStage('detail'); fieldExtracting.current = false; }, 320);
      window.setTimeout(() => { if (waitExtract.current) reveal(); }, 1600);
      return;
    }
    if (entry || picked.id === 'curriculum') { setPreviewNote(null); setDetailClosing(false); setStage('detail'); return; }
    goWorkbench(index);
  }
  function goWorkbench(index = fileIndex) {
    if (!picked) return;
    const query = new URLSearchParams({ preview: 'workbench', studio: picked.id, file: String(index), from: entry ? 'entry' : variant });
    if (variant === 'workbenches') query.set('design', design);
    const target = `${window.location.pathname}?${query}`;
    if (reduced) { navigate(target); return; }
    setLeaving(`${picked.files[index]}`);
    window.setTimeout(() => navigate(target), 560);
  }
  function continueFile() {
    if (!picked) return;
    if (entry && !reduced) {
      // 进入工作台：小票插回档案盒 → 打开档案盒取出文档（见 EmblemTransit）。
      if (detailClosing || transitActive()) return;
      const workbench = picked, file = fileIndex;
      const query = new URLSearchParams({ preview: 'workbench', studio: workbench.id, file: String(file), from: 'entry', design });
      const front = root.current?.querySelector('.cine-cassette.selected .cassette-front')?.getBoundingClientRect();
      // 小票先从盒口放回档案盒，再打开档案盒取出文档。
      setPreviewOrigin(boxRect()); setDetailClosing(true);
      window.setTimeout(() => {
        setCardReady(false); cardReadyRef.current = false;
        const seal = root.current?.querySelector('.cine-cassette.selected .entry-seal')?.getBoundingClientRect();
        const from = seal && seal.width > 4 ? seal : (front ?? new DOMRect(window.innerWidth / 2 - 40, window.innerHeight / 2 - 40, 80, 80));
        startTransit({ direction: 'enter', workbench, from, land: '.wb-crumb-logo', target: `${window.location.pathname}?${query}`,
          caption: { code: SECTION_CODES[entryWorkbenches.indexOf(workbench)], title: workbench.title, name: workbench.files[file], fileNo: `X—${String(file + 13).padStart(3, '0')}` } });
      }, 600);
      return;
    }
    goWorkbench(fileIndex);
  }
  function closeDetail() {
    if (!entry || reduced) { setStage('module'); return; }
    if (detailClosing) return;
    // 倒放：卡片缩回档案盒（按它此刻的位置），档案盒落回架上，列表与档案号随后从两侧滑回。
    setPreviewOrigin(boxRect()); setDetailClosing(true);
    window.setTimeout(() => { setDetailClosing(false); setCardReady(false); cardReadyRef.current = false; setStage('module'); setFromDetail(true); window.setTimeout(() => setFromDetail(false), 1000); }, 600);
  }
  // 从 Files 返回选台：Files 分层退场，印章上的标识抬起飞回画面中央，再交给选台入场。
  async function leaveToChooser() {
    if (!picked || transfer || backFlyer || leavingFiles) return;
    const workbench = picked, index = entryWorkbenches.indexOf(workbench);
    const bounds = root.current?.getBoundingClientRect();
    const origin = { x: bounds?.x ?? 0, y: bounds?.y ?? 0, width: bounds?.width ?? window.innerWidth, height: bounds?.height ?? window.innerHeight };
    const from = markerQuad(root.current?.querySelector('.cine-cassette.selected .entry-seal') ?? null, origin);
    const centre = rectQuad(origin.width / 2 - FLYER / 2, origin.height / 2 - FLYER / 2, FLYER, FLYER);
    // 1. Files 阅读层分层退场，印章上的标识抬起开始回飞。
    setLeavingFiles(true); setBackFlyer(workbench);
    await new Promise(r => requestAnimationFrame(() => r(null)));
    const flyer = backLogo.current;
    if (!flyer || !from || reduced) {
      cancel(); setPicked(null); setStage('chooser'); setWorkbenchIndex(index); setOrbitIndex(index); setLeavingFiles(false); setBackFlyer(null);
      return;
    }
    flyer.style.transform = matrixFor(FLYER, FLYER, from);
    const started = performance.now(), FLIGHT = 1150, SWAP = 420;
    let swapped = false;
    // 选台上这个工作台标识的真实位置；选台挂上之前先朝画面中央飞。
    const target = () => {
      const node = root.current?.querySelector('.ceremony [data-ceremony-source="true"]');
      const box = node?.getBoundingClientRect();
      if (!box || box.width < 8) return centre;
      const side = Math.min(box.width, box.height);
      return rectQuad(box.left - origin.x + (box.width - side) / 2, box.top - origin.y + (box.height - side) / 2, side, side);
    };
    await new Promise<void>(resolve => {
      const step = (now: number) => {
        const t = now - started;
        if (!swapped && t >= SWAP) {
          // 2. 阅读层退完后切到选台：不重建档案场，选台以就位状态出现（不重播开场）。
          swapped = true;
          cancel(); setPicked(null); setFileIndex(0); setSelected({ ...DEFAULT_CELL });
          clock.current = FILM_END; chooserRendered.current = false;
          setWorkbenchIndex(index); setOrbitIndex(index); setChooserReturning(true); setStage('chooser'); setLeavingFiles(false);
        }
        const progress = Math.min(1, t / FLIGHT);
        flyer.style.transform = matrixFor(FLYER, FLYER, flightQuad(from, swapped ? target() : centre, progress));
        if (progress < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    // 3. 标识落在选台的同一位置，交还给选台自己的标识。
    flyer.style.opacity = '0'; setChooserReturning(false);
    window.setTimeout(() => setBackFlyer(null), 520);
  }
  // Back out of a module's Files to where the workbench was chosen, keeping it selected.
  function leaveModule() {
    if (transfer || runningDemo || leaving) return;
    if (entry && !reduced) { void leaveToChooser(); return; }
    const index = picked ? entryWorkbenches.indexOf(picked) : workbenchIndex;
    reset();
    setWorkbenchIndex(index); setOrbitIndex(index);
    if (variantRef.current === 'files') setSelected({ lane: 1, row: 12 + index });
  }
  // 正式入口的无限档案场：每一列是一个工作台（7 个循环），进入模块 Files 时所选工作台落在选中的那一列。
  // 只在工作台从别处换过来时（选台、返回）重新对齐；换列时先移动选中格、再在并发渲染里换工作台，列与工作台的对应关系不变。
  const laneAnchor = useRef(picked ? entryWorkbenches.indexOf(picked) - selected.lane : 0), lastPicked = useRef(picked);
  if (picked !== lastPicked.current) {
    lastPicked.current = picked;
    if (entry && picked && modulo(laneAnchor.current + selected.lane, WORKBENCH_COUNT) !== entryWorkbenches.indexOf(picked)) laneAnchor.current = entryWorkbenches.indexOf(picked) - selected.lane;
  }
  const workbenchOfLane = (lane: number) => entryWorkbenches[modulo(laneAnchor.current + lane, WORKBENCH_COUNT)];
  const content = useMemo(() => ({
    title: picked?.title ?? '莱茵生命总档案', english: picked?.english ?? 'RHINE LAB / CENTRAL FILES',
    nameFor: (cell: Cell) => picked
      ? (entry ? workbenchOfLane(cell.lane) : picked).files[modulo(cell.row - 12, 4)]
      : entryWorkbenches[modulo(cell.row - 12, WORKBENCH_COUNT)].title,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [picked, entry]);
  // Selected cassette front in Files: the archive face plus the workbench seal.
  const sealFace = useMemo(() => picked ? <>
    <span className="cassette-frost" /><span className="cassette-specular" />
    <span className="entry-seal"><i data-corner="0" /><i data-corner="1" /><i data-corner="2" /><i data-corner="3" /><Logo workbench={picked} still /></span>
    {entry && <span className="entry-slip-inside" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
    <span className="cassette-border" />
    <span className="cassette-slot" />
    <span className="cassette-screw screw-upper" /><span className="cassette-screw screw-lower" />
    <span className="cassette-etching">RHINE LAB<span>INTERNAL DATABASE</span></span>
    <span className="cassette-serial">X—{String(entry ? modulo(selected.row - 12, 4) + 13 : selected.row + 1).padStart(3, '0')}<span>{picked.english}</span></span>
    <span className="cassette-security-line"><i /><i /></span>
    <span className="cassette-security-tag">CONFIDENTIALITY:<b>GENERAL BUSINESS USE</b></span>
  </> : undefined, [picked, selected.row, entry]);
  const steps = entry ? ['登录', '选择工作台', '标识转场', '模块 Files'] : variant === 'files' ? ['开场', '总 Files', '工作台标识', '模块 Files'] : ['开场', '选择工作台', '标识转场', '模块 Files'];
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

  return <LayoutGroup id="entry-comparison"><main ref={root} className={`cinema-experience entry-comparison ${reduced ? 'cine-reduced' : ''}`} data-stage={stage} data-variant={variant} data-design={design} data-transferring={!!transfer} data-arriving={arriving} data-sealing={sealing} data-stamped={stamped} data-shell={shell} data-leaving={leavingFiles ? 'files' : openingFile ? 'list' : undefined} data-from-detail={fromDetail || undefined} data-extracting={extracting || undefined} data-slip-out={cardReady || undefined} data-return-arrive={returnArrive || undefined} tabIndex={-1}
    aria-label={entry ? 'ReinLab 入口' : 'ReinLab 两种入口演示'} onWheel={event => {
      // 滚轮在同一列里前后移动：累计到一格的量才走一格，连续滚动时每 110ms 至多一格。
      if (!entry || stage !== 'module') return;
      const w = wheel.current, now = performance.now();
      w.sum += event.deltaY;
      if (Math.abs(w.sum) < 40 || now - w.at < 110) return;
      w.at = now; const dir = Math.sign(w.sum); w.sum = 0; stepFile(dir);
    }} onKeyDown={event => {
      if (transfer || runningDemo) return;
      if (entry && stage === 'module' && event.key.startsWith('Arrow')) {
        // 方向键不会激活按钮：焦点停在按钮上时也照常浏览档案场。
        event.preventDefault();
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') stepFile(event.key === 'ArrowDown' ? 1 : -1); else stepColumn(event.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (stage === 'chooser' && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); selectOrbit(orbitIndex + (event.key === 'ArrowLeft' ? -1 : 1)); return; }
      // Esc 不是按钮的激活键：焦点停在按钮上时也照常返回。
      if (event.key !== 'Escape' && (event.target as HTMLElement).closest('button,a,input,select,textarea')) return;
      if (stage === 'chooser' && event.key === 'Enter' && !isCeremony(design)) { event.preventDefault(); enterOrbit(); }
      if (event.key === 'Escape') { event.preventDefault(); if (stage === 'detail') closeDetail(); else if (stage === 'module') leaveModule(); else if (entry && onLock) onLock(); else reset(); }
      if (stage === 'global' && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); selectGlobal(workbenchIndex + (event.key === 'ArrowLeft' ? -1 : 1)); }
      if (entry && stage === 'module' && event.key === 'Enter') { event.preventDefault(); accessFile(); return; }
      if (stage === 'global' && event.key === 'Enter') { event.preventDefault(); void openWorkbench(entryWorkbenches[workbenchIndex]); }
    }}>
    {!entry && <header className="entry-compare-bar">
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
    </header>}
    {!entry && variant === 'workbenches' && <nav className="entry-design-picker" aria-label="工作台入口设计">{([['quantum','量子涨落'],['mobius','莫比乌斯环'],['fractal','分形与群'],['lorenz','混沌吸引子'],['crystal','晶带轴'],['drafting','制图详图'],['aperture','光圈对焦']] as const).map(([id,name])=><button className="entry-new-design" key={id} aria-pressed={design===id} onClick={()=>chooseDesign(id)}>{name}</button>)}<select aria-label="此前方案" value={(['quantum','mobius','fractal','lorenz','crystal','drafting','aperture'] as string[]).includes(design)?'':design} onChange={event=>{if(event.target.value)chooseDesign(event.target.value as EntryDesign);}}><option value="" disabled>此前方案 · 5</option><optgroup label="第四轮"><option value="helix">授权双螺旋</option></optgroup><optgroup label="第三轮"><option value="catalog">档案匣架</option></optgroup><optgroup label="第二轮"><option value="matrix">浮雕矩阵</option><option value="glass">档案抽取</option><option value="axis">档案穿行</option></optgroup></select></nav>}

    <div ref={viewport} className="cine-scene-viewport entry-field-viewport" style={{ visibility: stage === 'opening' && bootVisible ? 'hidden' : 'visible' }} inert={stage === 'chooser' || !!transfer || stage === 'opening' || runningDemo} aria-hidden={stage === 'chooser' || !!transfer || stage === 'opening'}>
      <div className="cine-fixed-stage cine-model-stage" style={{ transform: `translate(-50%,-50%) scale(${sceneScale})` }}>
        {/* This study transfers the logo rather than the archive surface.
            Keep the real 3D face outside shared layout projection. */}
        <ArchiveField key={sceneSession} ref={field} selected={selected} content={content} sharedElementSurface="both" selectedFace={sealFace} infinite={entry} onSelect={cell => {
          if (stage === 'global') void openWorkbench(entryWorkbenches[modulo(cell.row - 12, WORKBENCH_COUNT)], undefined, undefined, cell);
          if (stage === 'module') { const index = modulo(cell.row - 12, 4); selectFile(index, entry ? cell.lane === selected.lane && cell.row === selected.row : index === fileIndex, cell); }
        }} />
      </div>
    </div>
    {stage === 'opening' && bootVisible && <div className="cine-fixed-stage cine-boot-stage" style={{ transform: `translate(-50%,-50%) scale(${scale})` }}><BootStage ref={boot} /></div>}
    {!entry && stage === 'opening' && <div className="entry-opening-note"><span>RHINE LAB / ACCESS SEQUENCE</span><button onClick={() => { clock.current = FILM_END; setStage(landing(variant)); filmDone.current?.(); filmDone.current = null; }}><SkipForward size={13} />跳过开场，比较入口</button></div>}

    {(stage === 'chooser' || chooserHandoff) && !hold && isCeremony(design) && <CeremonyWorkbenchChooser key={`${design}:${sceneSession}`} design={design} selected={orbitIndex} reduced={reduced} locked={!!transfer||runningDemo} handoff={chooserHandoff} returning={chooserReturning} onSelect={selectOrbit} onEnter={(workbench,source)=>void openWorkbench(workbench,source)}/>}
    {(stage === 'chooser' || chooserHandoff) && design==='matrix' && <div className="entry-chooser-shell" data-handoff={chooserHandoff}> <ArchitecturalWorkbenchChooser key={`${design}:${sceneSession}`} design={design} selected={orbitIndex} reduced={reduced} locked={!!transfer||runningDemo} onSelect={selectOrbit} onEnter={(workbench,source)=>void openWorkbench(workbench,source)}/></div>}
    {(stage === 'chooser' || chooserHandoff) && (design==='glass'||design==='axis') && <div className="entry-chooser-shell" data-handoff={chooserHandoff}> <FileWorkbenchChooser key={`${design}:${sceneSession}`} design={design} selected={orbitIndex} reduced={reduced} locked={!!transfer||runningDemo} onSelect={selectOrbit} onEnter={(workbench,source)=>void openWorkbench(workbench,source)}/></div>}

    {(stage === 'global' || stage === 'module' || stage === 'detail') && (() => {
      // Files pages (第五轮编辑式): the archive field stays as the stage, the
      // reading layer sits on a paper veil — ink section block, a large file
      // number, an indexed file list, and a leader line into the field.
      const global = stage === 'global', pickedIndex = picked ? entryWorkbenches.indexOf(picked) : workbenchIndex;
      const fileNo = entry ? `X—${String(fileIndex + 13).padStart(3,'0')}` : `X—${String(selected.row + 1).padStart(3,'0')}`;
      const code = SECTION_CODES[global ? workbenchIndex : pickedIndex];
      return <>
      <div className="fx-veil" aria-hidden="true" />
      <div className="entry-brand"><CinematicBrand /></div>
      <div className="entry-files-heading fx-heading">
        <b>FILES</b><span>{global ? 'RHINE LAB / CENTRAL FILES' : `${picked!.english} / FILES`}</span>
        <p>{global ? '总档案 · 每份档案指向一个工作台' : `${picked!.title} · 专属档案`}</p>
      </div>
      {picked && <div className="entry-module-identity fx-identity"><div ref={cornerLogo}><Logo workbench={picked} still /></div><span><b>{SECTION_CODES[pickedIndex]}</b>{picked.title}<small>{picked.english}</small></span></div>}
      <section className="entry-file-callout fx-callout" inert={!!transfer || runningDemo}>
        <span className="fx-eyebrow"><b>{global ? 'WORKBENCH' : picked!.fileKind}</b>ARCHIVE · {global ? `${String(workbenchIndex + 1).padStart(2,'0')} / ${countLabel}` : `${String(fileIndex + 1).padStart(2,'0')} / 04`}</span>
        <h1 key={fileNo}><small>FILE</small>{fileNo}</h1>
        <h2 key={`${fileNo}-name`}>{global ? currentWorkbench.title : picked!.files[fileIndex]}</h2>
        <p>{global ? currentWorkbench.description : '一份档案，一段可以继续的探索。'}</p>
        <div className="fx-meta"><span>SECTION<b>{code}</b></span><span>KIND<b>{global ? 'WORKBENCH' : picked!.fileKind}</b></span><span>ACCESS<b>LOCAL PREVIEW</b></span></div>
        {stage !== 'detail' && <button className="entry-access fx-access" onClick={() => global ? void openWorkbench(currentWorkbench) : accessFile()}><span>{global ? 'ACCESS WORKBENCH' : 'ACCESS FILE'}</span><small>{global ? '调阅工作台' : picked!.id === 'curriculum' ? '抽取档案' : '抽取档案 · 进入工作现场'}</small><ArrowRight size={17} /></button>}
      </section>
      {global && <nav className="entry-global-directory fx-list" aria-label="总 Files 的工作台档案" inert={!!transfer || runningDemo}>
        <span className="fx-list-head"><b>WORKBENCH FILES</b>{countLabel}</span>
        {entryWorkbenches.map((workbench, index) => <button key={workbench.id} className={index === workbenchIndex ? 'active' : ''} onClick={() => void openWorkbench(workbench)}><i /><em>{SECTION_CODES[index]}</em><b>{workbench.title}</b><small>X—{String(index + 13).padStart(3,'0')}</small><ArrowUpRight size={14} /></button>)}
      </nav>}
      {global && <div className="entry-selection-nav fx-step" inert={!!transfer || runningDemo}><button onClick={() => selectGlobal(workbenchIndex - 1)} aria-label="上一份工作台档案"><ChevronLeft size={19} /></button><div><span>ARCHIVE / {String(workbenchIndex + 1).padStart(2,'0')} OF {countLabel}</span><strong>{currentWorkbench.title}</strong></div><button onClick={() => selectGlobal(workbenchIndex + 1)} aria-label="下一份工作台档案"><ChevronRight size={19} /></button></div>}
      {stage === 'module' && <nav className="entry-module-files fx-list" aria-label={`${picked!.title}的 Files`} inert={!!transfer || runningDemo}>
        <span className="fx-list-head"><b>{picked!.fileKind} FILES</b>04</span>
        {picked!.files.map((name,index) => <button key={name} className={fileIndex === index ? 'active' : ''} onClick={() => selectFile(index, fileIndex === index)} title={fileIndex === index ? '再次点击抽取档案' : undefined}><i /><em>{String(index + 1).padStart(2,'0')}</em><b>{name}</b><small>X—{String(index + 13).padStart(3,'0')}</small><ArrowUpRight size={14} /></button>)}
        <button className="fx-back" onClick={leaveModule}><ArrowLeft size={14} /><b>{variant === 'workbenches' ? '返回工作台选择' : '返回总 Files'}</b><small>ESC</small></button>
      </nav>}
      {entry && stage === 'module' && <div className="fx-nav" inert={!!transfer || runningDemo || openingFile}>
        <div className="fx-nav-count" aria-live="polite"><span>ARCHIVE / SELECT</span><b key={fileIndex}>{String(fileIndex + 1).padStart(2, '0')}</b><i>/</i><em>04</em></div>
        <div className="fx-nav-rows">
          <button onClick={() => stepFile(-1)} aria-label="上一份档案"><ArrowUp size={18} /></button>
          <span className="fx-ticks" aria-hidden="true">{picked!.files.map((_, k) => <i key={k} data-on={k === fileIndex || undefined} />)}</span>
          <button onClick={() => stepFile(1)} aria-label="下一份档案"><ArrowDown size={18} /></button>
        </div>
        <div className="fx-nav-cols">
          <button onClick={() => stepColumn(-1)} aria-label="上一列（上一个工作台）"><ArrowLeft size={18} /></button>
          <div><small>COLUMN {String(pickedIndex + 1).padStart(2, '0')} / {String(WORKBENCH_COUNT).padStart(2, '0')}</small><b key={picked!.id}>{picked!.title}</b></div>
          <button className="fx-nav-next" onClick={() => stepColumn(1)} aria-label="下一列（下一个工作台）"><ArrowRight size={18} /></button>
        </div>
        <p className="fx-nav-keys">← → 切换列 <i>/</i> ↑ ↓ 前后档案 <i>/</i> ENTER 调阅</p>
      </div>}
      {stage === 'detail' && entry && cardReady && <FilePreview workbench={picked!} index={fileIndex} fileNo={fileNo} code={code} closing={detailClosing} note={previewNote} origin={previewOrigin} onContinue={continueFile} onBack={closeDetail} />}
      {stage === 'detail' && !entry && <article className="entry-file-detail fx-detail" aria-label="档案调阅预览">
        <header><b>{code}</b><span>{picked!.fileKind} / FILE {fileNo}</span><i>×</i></header>
        <div className="fx-detail-body">
          <span className="fx-eyebrow"><b>OPENED</b>{variant === 'files' ? '经由总 Files' : '经由工作台选择'}</span>
          <h2>{picked!.files[fileIndex]}</h2>
          <p>你已从{variant === 'files' ? '总 Files' : '工作台选择'}进入{picked!.title}，<br />并调阅了这份专属档案。</p>
          <dl><div><dt>WORKBENCH</dt><dd>{picked!.title}</dd></div><div><dt>FILE</dt><dd>{fileNo}</dd></div><div><dt>INDEX</dt><dd>{String(fileIndex + 1).padStart(2,'0')} / 04</dd></div></dl>
          <span className="entry-detail-note">{picked!.id === 'curriculum' ? '这里将交接给 OpenMAIC。演示停在进入课堂之前。' : '这里将进入具体的工作现场。当前仅演示入口与档案转场。'}</span>
          <button onClick={() => setStage('module')}><ArrowLeft size={14} />返回模块 Files</button>
        </div>
      </article>}
      <FilesLeader root={root} active={!transfer && stage !== 'detail'} label={global ? code : fileNo} />
      <div className="fx-line" aria-hidden="true" data-status={extracting ? 'extracting' : undefined}>{extracting
        ? <><b key="x">正在抽取 {fileNo} · {picked!.files[fileIndex]}</b><span>EXTRACTING · UNSEALING ARCHIVE</span></>
        : <><b>{global ? '每一份档案，都通向一个工作台。' : picked!.description}</b><span>{global ? 'EVERY FILE OPENS A WORKBENCH' : `${picked!.english} · ${picked!.fileKind} ARCHIVE`}</span></>}</div>
      </>;
    })()}

    {leaving && picked && <div className="fx-leave" role="status"><span><b>{SECTION_CODES[entryWorkbenches.indexOf(picked)]}</b>FILE X—{String(fileIndex + 13).padStart(3,'0')}</span><strong>{leaving}</strong><small>正在进入{picked.title}</small></div>}
    {transfer && <div ref={transferLogo} className="entry-flyer" aria-hidden="true"><Logo workbench={transfer} still /></div>}
    {backFlyer && <div ref={backLogo} className="entry-flyer entry-back-flyer" aria-hidden="true"><Logo workbench={backFlyer} still /></div>}
    <footer className="entry-path-footer"><div aria-label="当前入口路径">{steps.map((label,index) => <span key={label} className={index === step ? 'active' : ''}>{index > 0 && <ChevronRight size={10} />}{entry && onLock && index === 0 && stage === 'chooser' ? <button className="entry-lock" onClick={onLock} title="锁定并返回登录（Esc）"><b>{label}</b><small>LOCK · ESC</small></button> : <b>{label}</b>}</span>)}</div><span className="entry-local-note">{entry ? '本地预览 · 示例数据' : '入口预览 · 止于模块 Files'}</span></footer>
    {!entry && <a className="entry-exit" href="/workbench-logos/index.html" aria-label="返回动态 LOGO 预览"><X size={12} />LOGOS</a>}
    <div className="entry-sr-status" role="status">{stage === 'opening' ? '正在播放开场' : transfer ? `正在展开${transfer.title}` : stage === 'chooser' ? `当前选择：${orbitWorkbench.title}` : stage === 'global' ? '莱茵生命总 Files' : `${picked?.title}的${stage === 'detail' ? '档案调阅' : 'Files'}`}</div>
  </main></LayoutGroup>;
}

/** A leader line from the selected cassette in the archive field to the file callout. */
function FilesLeader({ root, active, label }: { root: { current: HTMLElement | null }; active: boolean; label: string }) {
  const line = useRef<SVGPolylineElement>(null), dot = useRef<SVGCircleElement>(null), tag = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const tick = () => {
      const host = root.current, face = host?.querySelector('.cine-cassette.selected .cassette-top'), callout = host?.querySelector('.fx-callout h1');
      if (host && face && callout && line.current && dot.current && tag.current) {
        const h = host.getBoundingClientRect(), r = face.getBoundingClientRect(), c = callout.getBoundingClientRect();
        if (r.width > 2) {
          const ax = r.left - h.left + r.width / 2, ay = r.top - h.top + r.height / 2, bx = c.left - h.left - 18, by = c.top - h.top + c.height * .5;
          const mx = Math.max(ax + 40, bx - 70);
          line.current.setAttribute('points', `${ax.toFixed(1)},${ay.toFixed(1)} ${mx.toFixed(1)},${by.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`);
          dot.current.setAttribute('cx', ax.toFixed(1)); dot.current.setAttribute('cy', ay.toFixed(1));
          tag.current.style.transform = `translate(${(ax + 12).toFixed(1)}px, ${(ay - 30).toFixed(1)}px)`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, root]);
  return <div className="fx-leader" data-active={active} aria-hidden="true">
    <svg><polyline ref={line} points="0,0 0,0" /><circle ref={dot} r={5} /></svg>
    <span ref={tag} className="fx-leader-tag">{label}</span>
  </div>;
}
