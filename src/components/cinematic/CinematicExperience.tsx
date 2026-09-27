import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LayoutGroup } from 'motion/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronLeft, ChevronRight, Grid2X2, Pause, Play, RotateCcw, SkipForward, SlidersHorizontal, Volume2, VolumeX, X } from 'lucide-react';
import { platforms, type Platform } from '../../model';
import { isLearningStore, LEARNING_KEY, subjectIds, type SubjectId } from '../classroom/learningState';
import BootStage, { CinematicBrand, type BootStageHandle } from './BootStage';
import LoginGate from './LoginGate';
import { AmbientScore, type AudioStatus } from './AmbientScore';
import { animateArchiveUnfold, startArchiveApproach, type OpeningRect } from './archiveOpening';
import { FrameMeter, type FrameReport } from './FrameMeter';
import ArchiveField, { nameFor, type ArchiveFieldHandle } from './ArchiveField';
import { enterOpenMAIC } from './openMaicPortal';
import { BOOT_END, chapters, clamp, DEFAULT_CELL, FILM_END, LANES, ROWS, sameCell, type Cell } from './timeline';
import './cinematic.css';
import './cinematic-polish.css';
import './login-entrance.css';
import './open-maic-portal.css';

type Mode = 'ready' | 'film' | 'archive' | 'detail' | 'classroom' | 'research';
type SharedElementSurface = 'archive' | 'classroom';
type SharedTransitionPhase = 'opening' | 'returning' | null;
const ImmersiveClassroom = lazy(() => import('../classroom/ImmersiveClassroom'));
const LearningClassroom = lazy(() => import('../classroom/LearningClassroom'));
const ResearchLab = lazy(() => import('../research/ResearchLab'));
const timecode = (time: number) => `${Math.floor(time / 60).toString().padStart(2, '0')}:${Math.floor(time % 60).toString().padStart(2, '0')}.${Math.floor((time % 1) * 10)}`;

export default function CinematicExperience({ active, reduced, replayRequest, classroomRequest, onWorkbench, onOpenWorkspace }: {
  active: boolean; reduced: boolean; replayRequest: number; classroomRequest: number;
  onWorkbench: () => void; onOpenWorkspace: (platform: Platform, workspace: string) => void;
}) {
  const fromOpenMAIC = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('return') === 'archive';
  const [mode, setMode] = useState<Mode>(fromOpenMAIC ? 'archive' : 'ready');
  const [portalArrival, setPortalArrival] = useState(fromOpenMAIC);
  const [legacyClassroom, setLegacyClassroom] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState(fromOpenMAIC ? FILM_END : 0);
  const [bootDone, setBootDone] = useState(fromOpenMAIC);
  const [identity, setIdentity] = useState('LOCAL RESEARCHER');
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>('off');
  const [volume, setVolume] = useState(.24);
  const [report, setReport] = useState<FrameReport>({ fps: 0, p95: 0, work: 0, frames: 0 });
  const [phaseReports, setPhaseReports] = useState<{ phase: string; report: FrameReport }[]>([]);
  const [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState<Cell>(fromOpenMAIC ? { lane: 1, row: 12 } : { ...DEFAULT_CELL });
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [softFlashes, setSoftFlashes] = useState(true);
  const [readyToRead, setReadyToRead] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [classroomImporting, setClassroomImporting] = useState(false);
  const [classroomImportError, setClassroomImportError] = useState('');
  const [researchImporting, setResearchImporting] = useState(false);
  const [researchImportError, setResearchImportError] = useState('');
  const [sharedElementSurface, setSharedElementSurface] = useState<SharedElementSurface>('archive');
  const [sharedTransitionPhase, setSharedTransitionPhase] = useState<SharedTransitionPhase>(null);
  const [classroomPreparing, setClassroomPreparing] = useState(false);
  const [researchPreparing, setResearchPreparing] = useState(false);
  const [researchReturning, setResearchReturning] = useState(false);
  const preparedResolve = useRef<(() => void) | null>(null);
  const onClassroomPrepared = useCallback(() => { preparedResolve.current?.(); preparedResolve.current = null; }, []);
  const [dollyPhase, setDollyPhase] = useState<'approaching' | 'near' | 'retreating' | null>(null);
  const dollyLocked = useRef(false);
  const dollyAnimation = useRef<Animation | null>(null);
  const openingApproach = useRef<ReturnType<typeof startArchiveApproach> | null>(null);
  const sceneViewport = useRef<HTMLDivElement>(null);
  const openingSource = useRef<OpeningRect | null>(null);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const root = useRef<HTMLDivElement>(null);
  const scene = useRef<ArchiveFieldHandle>(null);
  const bootScene = useRef<BootStageHandle>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const objectCaption = useRef<HTMLDivElement>(null);
  const audio = useRef<AmbientScore | null>(null);
  const meter = useRef(new FrameMeter());
  const meterPhase = useRef('');
  const loginTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const time = useRef(0);
  const elapsed = useRef(0);
  const lastReplay = useRef(replayRequest);
  const lastClassroomRequest = useRef(classroomRequest);
  const lastActive = useRef(false);
  const lastPublished = useRef(0);
  const drag = useRef<{ x: number; angle: number; pointer: number } | null>(null);
  const inspectAngle = useRef(0);
  const readyRef = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const classroomOpeningLock = useRef(false);
  const researchOpeningLock = useRef(false);
  const researchReturnLock = useRef(false);
  const researchReturnAnimation = useRef<Animation | null>(null);
  const sharedTransitionLock = useRef(false);
  const sharedTransitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sharedTransitionPhaseRef = useRef<SharedTransitionPhase>(null);
  const portrait = size.width < size.height * .8;
  const bootScale = Math.min(size.width / 1920, size.height / 1080);
  const sceneScale = portrait && mode !== 'film' ? Math.max(size.width / 1920, size.height / 1080) * .76 : bootScale;
  const isFilm = mode === 'film';
  useEffect(() => {
    if (!portalArrival) return;
    const timer = window.setTimeout(() => setPortalArrival(false), reduced ? 100 : 1550);
    window.history.replaceState(null, '', '/');
    return () => window.clearTimeout(timer);
  }, [portalArrival, reduced]);
  const archiveVisible = mode === 'archive';
  const detailVisible = mode === 'detail';
  const showArchive = archiveVisible || detailVisible;
  const visibleField = showArchive || mode === 'classroom' || mode === 'research' || isFilm && bootDone;
  const config = platforms[selected.lane];
  const isLearningCourse = config.id === 'learning';
  const isResearchLab = config.id === 'research';
  const chapter = [...chapters].reverse().find(c => clock >= c.time) ?? chapters[0];
  const finishSharedTransition = useCallback((phase: Exclude<SharedTransitionPhase, null>) => {
    if (sharedTransitionPhaseRef.current !== phase) return;
    sharedTransitionPhaseRef.current = null;
    sharedTransitionLock.current = false;
    if (sharedTransitionTimer.current) clearTimeout(sharedTransitionTimer.current);
    setSharedElementSurface(phase === 'opening' ? 'classroom' : 'archive');
    setSharedTransitionPhase(null);
    if (phase === 'returning') {
      const viewport = sceneViewport.current;
      setDollyPhase('retreating');
      // Let the archive settle into its shelf while the camera pulls back,
      // rather than starting a third motion after the retreat has stopped.
      dollyLocked.current = false;
      const animation = viewport?.animate(
        [{ transform: viewport.style.transform }, { transform: 'scale(1)' }],
        { duration: 820, easing: 'cubic-bezier(.32,.08,.2,1)', fill: 'forwards' },
      );
      dollyAnimation.current = animation ?? null;
      void animation?.finished.then(() => {
        if (viewport) { viewport.style.transform = ''; viewport.style.transformOrigin = ''; }
        animation.cancel();
        dollyLocked.current = false;
        setDollyPhase(null);
      }).catch(() => {});
      if (!animation) { dollyLocked.current = false; setDollyPhase(null); }
    }
  }, []);
  const finishOpeningTransition = useCallback(() => finishSharedTransition('opening'), [finishSharedTransition]);
  const finishReturningTransition = useCallback(() => finishSharedTransition('returning'), [finishSharedTransition]);
  useLayoutEffect(() => {
    if (sharedTransitionPhase !== 'opening' || !openingSource.current || !root.current || !sceneViewport.current) return;
    const opening = animateArchiveUnfold(root.current, sceneViewport.current, openingSource.current);
    let disposed = false;
    void opening.finished.then(() => {
      if (disposed) return;
      opening.settle();
      setDollyPhase('near');
      finishOpeningTransition();
    }).catch(() => {});
    return () => { disposed = true; opening.cancel(); };
  }, [sharedTransitionPhase, finishOpeningTransition]);
  const transitionSharedSurface = useCallback((phase: Exclude<SharedTransitionPhase, null>, allowed: boolean, update: () => void) => {
    const destination: SharedElementSurface = phase === 'opening' ? 'classroom' : 'archive';
    if (reduced || !allowed) {
      dollyAnimation.current?.cancel();
      dollyLocked.current = false; setDollyPhase(null);
      if (sceneViewport.current) sceneViewport.current.style.transform = '';
      setClassroomPreparing(false);
      setSharedElementSurface(destination);
      setSharedTransitionPhase(null);
      update();
      return;
    }
    if (sharedTransitionLock.current) return;
    sharedTransitionLock.current = true;
    sharedTransitionPhaseRef.current = phase;
    if (sharedTransitionTimer.current) clearTimeout(sharedTransitionTimer.current);
    // The opening target has already mounted and laid out offscreen. Transfer
    // ownership with its data loaded and its styles/layout already warmed.
    setSharedElementSurface(phase === 'opening' ? 'classroom' : 'archive');
    setClassroomPreparing(false);
    setSharedTransitionPhase(phase);
    update();
    sharedTransitionTimer.current = setTimeout(() => finishSharedTransition(phase), phase === 'opening' ? 2400 : 1100);
  }, [finishSharedTransition, portrait, reduced]);
  const openClassroom = useCallback(async (legacy = false, fromDetail = false) => {
    if (!legacy) { enterOpenMAIC('reinlab', reduced); return; }
    if (classroomOpeningLock.current) return;
    classroomOpeningLock.current = true;
    setClassroomImportError('');
    setClassroomImporting(true);
    setTimelineOpen(false);
    let approach: ReturnType<typeof startArchiveApproach> | null = null;
    try {
      const viewport = sceneViewport.current;
      const face = viewport?.querySelector('.cine-cassette.selected .cassette-front');
      if (!reduced && viewport && face && (fromDetail || mode === 'archive')) {
        // Start moving the archive on the click. The lesson can import and
        // finish its hidden layout during this first camera movement.
        dollyLocked.current = true;
        openingSource.current = face.getBoundingClientRect();
        setDollyPhase('approaching');
        approach = startArchiveApproach(viewport, openingSource.current);
        openingApproach.current = approach;
      } else {
        openingSource.current = null;
      }
      if (legacy) await import('../classroom/ImmersiveClassroom');
      else await import('../classroom/LearningClassroom');
      const prepared = new Promise<void>(resolve => { preparedResolve.current = resolve; });
      setLegacyClassroom(legacy);
      setClassroomPreparing(true);
      await prepared;
      // Finish the hidden lesson layout before unfolding; the camera is
      // already approaching the archive in parallel.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (approach) {
        await approach.finished;
        approach.settle();
        openingApproach.current = null;
      }
      transitionSharedSurface('opening', !!approach, () => {
        setLegacyClassroom(legacy);
        setMode('classroom');
      });
    } catch {
      approach?.cancel(); openingApproach.current = null;
      setClassroomPreparing(false); preparedResolve.current = null;
      dollyLocked.current = false; setDollyPhase(null);
      if (sceneViewport.current) { sceneViewport.current.style.transform = ''; sceneViewport.current.style.transformOrigin = ''; }
      setClassroomImportError('档案暂时无法展开，请稍后重试。');
    } finally {
      setClassroomImporting(false);
      classroomOpeningLock.current = false;
    }
  }, [mode, reduced, transitionSharedSurface]);
  const openResearch = useCallback(async (fromDetail = false) => {
    if (researchOpeningLock.current) return;
    researchOpeningLock.current = true;
    setResearchImporting(true);
    setResearchImportError('');
    setTimelineOpen(false);
    let approach: ReturnType<typeof startArchiveApproach> | null = null;
    try {
      const viewport = sceneViewport.current;
      const face = viewport?.querySelector<HTMLElement>('.cine-cassette.selected .cassette-front');
      if (!reduced && viewport && face && (fromDetail || mode === 'archive')) {
        dollyLocked.current = true;
        openingSource.current = face.getBoundingClientRect();
        setDollyPhase('approaching');
        approach = startArchiveApproach(viewport, openingSource.current);
        openingApproach.current = approach;
      } else {
        openingSource.current = null;
      }
      await import('../research/ResearchLab');
      setResearchPreparing(true);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (approach) {
        await approach.finished;
        approach.settle();
        openingApproach.current = null;
      }
      transitionSharedSurface('opening', !!approach, () => {
        setResearchPreparing(false);
        setMode('research');
      });
    } catch {
      approach?.cancel();
      openingApproach.current = null;
      setResearchPreparing(false);
      dollyLocked.current = false;
      setDollyPhase(null);
      if (sceneViewport.current) { sceneViewport.current.style.transform = ''; sceneViewport.current.style.transformOrigin = ''; }
      setResearchImportError('研究档案暂时无法展开，请稍后重试。');
    } finally {
      setResearchImporting(false);
      researchOpeningLock.current = false;
    }
  }, [mode, reduced, transitionSharedSurface]);
  const beginArchiveReturn = useCallback(() => {
    transitionSharedSurface('returning', mode === 'classroom', () => {
      setMode('archive'); setLegacyClassroom(false); setReadyToRead(false); inspectAngle.current = 0;
      scene.current?.inspect(0);
      root.current?.focus({ preventScroll: true });
    });
  }, [mode, transitionSharedSurface]);
  const completeArchiveReturn = useCallback(() => {
    setMode('archive'); setLegacyClassroom(false); setReadyToRead(false); inspectAngle.current = 0;
    setSharedElementSurface('archive');
    scene.current?.inspect(0);
    root.current?.focus({ preventScroll: true });
  }, []);
  const returnResearch = useCallback(async () => {
    if (researchReturnLock.current || sharedTransitionLock.current) return;
    researchReturnLock.current = true;
    const layer = root.current?.querySelector<HTMLElement>('.cine-research-layer');
    if (!reduced && layer) {
      setResearchReturning(true);
      const animation = layer.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.985)' }],
        { duration: 500, easing: 'cubic-bezier(.32,.08,.2,1)', fill: 'forwards' },
      );
      researchReturnAnimation.current = animation;
      await animation.finished.catch(() => {});
      animation.cancel();
      researchReturnAnimation.current = null;
    }
    setResearchReturning(false);
    setSharedElementSurface('archive');
    setMode('archive');
    setReadyToRead(false);
    inspectAngle.current = 0;
    scene.current?.inspect(0);
    root.current?.focus({ preventScroll: true });
    const viewport = sceneViewport.current;
    if (!reduced && viewport && dollyLocked.current) {
      setDollyPhase('retreating');
      dollyLocked.current = false;
      const animation = viewport.animate(
        [{ transform: viewport.style.transform }, { transform: 'scale(1)' }],
        { duration: 820, easing: 'cubic-bezier(.32,.08,.2,1)', fill: 'forwards' },
      );
      dollyAnimation.current = animation;
      await animation.finished.catch(() => {});
      animation.cancel();
    }
    if (viewport) { viewport.style.transform = ''; viewport.style.transformOrigin = ''; }
    setDollyPhase(null);
    researchReturnLock.current = false;
  }, [reduced]);
  function leave(action: () => void) {
    if (leaving) return;
    setPlaying(false);
    if (reduced) { action(); return; }
    setLeaving(true);
    leaveTimer.current = setTimeout(action, 420);
  }

  const start = useCallback(() => {
    scene.current?.reset(); time.current = 1.76; setClock(1.76); setBootDone(false);
    setSelected({ ...DEFAULT_CELL }); inspectAngle.current = 0;
    setMode('film'); setPlaying(true); setReadyToRead(false); setTimelineOpen(false);
    meter.current.reset();
    setPhaseReports([]);
    root.current?.focus({ preventScroll: true });
  }, []);
  const skip = useCallback(() => {
    setMode('archive'); setPlaying(false); setClock(26.56); time.current = 26.56;
    setTimelineOpen(false);
    scene.current?.reset(); inspectAngle.current = 0;
    setBootDone(true); root.current?.focus({ preventScroll: true });
  }, []);

  function ensureAudio() {
    audio.current ??= new AmbientScore(setAudioStatus);
    return audio.current;
  }
  function login(name: string) {
    setIdentity(name);
    // AudioContext is unlocked by this real user gesture. Credentials never leave the form.
    if (musicEnabled) void ensureAudio().start();
    if (reduced) skip();
    else loginTimer.current = setTimeout(start, 560);
  }
  function toggleMusic() {
    if (musicEnabled && (audioStatus === 'unavailable' || audioStatus === 'suspended')) { void ensureAudio().start(); return; }
    const next = !musicEnabled;
    setMusicEnabled(next);
    ensureAudio().setEnabled(next);
  }

  const select = useCallback((cell: Cell) => {
    if (mode !== 'archive') return;
    if (sameCell(cell, selected)) {
      setMode('detail'); inspectAngle.current = 0;
    } else {
      setSelected(cell); setReadyToRead(false);
    }
  }, [mode, selected]);
  const back = useCallback(() => {
    setMode('archive'); setLegacyClassroom(false); setReadyToRead(false); inspectAngle.current = 0;
    scene.current?.inspect(0);
    root.current?.focus({ preventScroll: true });
  }, []);
  const move = useCallback((axis: 'lane' | 'row', delta: number) => {
    if (mode !== 'archive') return;
    setSelected(s => ({ ...s, [axis]: clamp(s[axis] + delta, 0, axis === 'lane' ? LANES - 1 : ROWS - 1) }));
  }, [mode]);
  const seek = useCallback((at: number) => {
    time.current = clamp(at, 0, FILM_END);
    setClock(time.current); setBootDone(time.current >= BOOT_END - .08); setSelected({ ...DEFAULT_CELL }); setMode('film'); setPlaying(false);
  }, []);

  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (active && !lastActive.current) root.current?.focus({ preventScroll: true });
    if (!active) { setPlaying(false); setLeaving(false); }
    audio.current?.setVisible(active && !document.hidden);
    lastActive.current = active;
  }, [active]);
  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    if (loginTimer.current) clearTimeout(loginTimer.current);
    if (sharedTransitionTimer.current) clearTimeout(sharedTransitionTimer.current);
    dollyAnimation.current?.cancel();
    openingApproach.current?.cancel();
    researchReturnAnimation.current?.cancel();
    audio.current?.dispose();
  }, []);
  useEffect(() => {
    if (replayRequest === lastReplay.current) return;
    lastReplay.current = replayRequest;
    if (reduced) skip(); else start();
  }, [replayRequest, reduced, start, skip]);
  useEffect(() => {
    if (classroomRequest === lastClassroomRequest.current) return;
    lastClassroomRequest.current = classroomRequest;
    let subject: SubjectId = 'math';
    try { const saved: unknown = JSON.parse(localStorage.getItem(LEARNING_KEY) ?? 'null'); if (isLearningStore(saved)) subject = saved.active; } catch { /* Optional local state. */ }
    setSelected({ lane: 1, row: 12 + subjectIds.indexOf(subject) });
    setPlaying(false);
    void openClassroom(false);
  }, [classroomRequest, openClassroom]);
  const classroomMedia = useCallback((playing: boolean) => {
    audio.current?.setVolume(playing ? volume * .15 : volume);
  }, [volume]);
  useEffect(() => {
    if (reduced && mode === 'film') skip();
  }, [reduced, mode, skip]);
  useEffect(() => {
    if (!active || mode === 'classroom' || mode === 'research') return;
    let frame = 0, previous: number | null = null;
    const draw = (now: number) => {
      const updateStarted = performance.now();
      const hasPreviousFrame = previous !== null;
      const wallDelta = hasPreviousFrame ? Math.max(0, (now - previous!) / 1000) : 0;
      const delta = Math.min(.05, wallDelta);
      previous = now;
      elapsed.current += delta;
      if (isFilm && playing && !document.hidden) {
        time.current = Math.min(FILM_END, time.current + wallDelta * speed);
        if (time.current >= FILM_END) {
          setPlaying(false); setMode('archive'); setTimelineOpen(false);
          setClock(FILM_END); setBootDone(true);
        }
      }
      if (isFilm) {
        bootScene.current?.update(time.current, softFlashes, identity.toUpperCase());
        if (!bootDone && time.current >= BOOT_END - .08) setBootDone(true);
      }
      const fieldVisible = mode === 'archive' || mode === 'detail' || isFilm && time.current >= BOOT_END - .08;
      const status = dollyLocked.current ? undefined : scene.current?.update({
        time: time.current, elapsed: elapsed.current, delta,
        film: isFilm, detail: mode === 'detail', reduced, portrait, visible: fieldVisible,
      });
      if (status) {
        const reveal = clamp((status.detail - .6) / .4).toFixed(3);
        if (detailPanel.current && detailPanel.current.style.opacity !== reveal) {
          detailPanel.current.style.opacity = reveal;
          detailPanel.current.style.transform = `translateY(${(13 * (1 - Number(reveal))).toFixed(2)}px)`;
        }
        if (objectCaption.current && objectCaption.current.style.opacity !== reveal) objectCaption.current.style.opacity = reveal;
        const ready = mode === 'detail' && status.detail > .94;
        if (ready !== readyRef.current) { readyRef.current = ready; setReadyToRead(ready); }
      }
      const phase = isFilm ? fieldVisible ? 'arrival' : 'opening' : mode;
      if (phase !== meterPhase.current) {
        const previousPhase = meterPhase.current, completed = meter.current.report();
        if (completed.frames && ['opening', 'arrival', 'detail'].includes(previousPhase)) {
          setPhaseReports(records => [...records.slice(-3), { phase: previousPhase, report: completed }]);
        }
        meter.current.reset(); meterPhase.current = phase;
      }
      if (!document.hidden && hasPreviousFrame) meter.current.record(wallDelta * 1000, performance.now() - updateStarted);
      if (timelineOpen && now - lastPublished.current >= 500) {
        setClock(time.current); setReport(meter.current.report()); lastPublished.current = now;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active, isFilm, playing, speed, mode, reduced, portrait, timelineOpen, identity, softFlashes, bootDone]);
  useEffect(() => {
    const onHidden = () => { if (document.hidden) setPlaying(false); audio.current?.setVisible(active && !document.hidden); };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [active]);

  function onKey(event: React.KeyboardEvent) {
    if (classroomOpeningLock.current || researchOpeningLock.current || researchReturnLock.current || sharedTransitionLock.current || dollyPhase === 'approaching' || dollyPhase === 'retreating') { event.preventDefault(); return; }
    if (mode === 'research') {
      if (event.key === 'Escape' && !(event.target as HTMLElement).closest('input,select,textarea')) {
        event.preventDefault();
        void returnResearch();
      }
      return;
    }
    if (mode === 'classroom') return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') { event.preventDefault(); setTimelineOpen(v => !v); return; }
    if (event.key === 'Escape' && timelineOpen) { event.preventDefault(); setTimelineOpen(false); return; }
    if (event.key === 'Escape' && mode === 'detail') { event.preventDefault(); back(); return; }
    if ((event.target as HTMLElement).closest('input,select,textarea')) return;
    const onButton = !!(event.target as HTMLElement).closest('button');
    if (mode === 'archive') {
      if (event.key === 'ArrowLeft') { event.preventDefault(); move('lane', -1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move('lane', 1); }
      if (event.key === 'ArrowUp') { event.preventDefault(); move('row', -1); }
      if (event.key === 'ArrowDown') { event.preventDefault(); move('row', 1); }
      if (event.key === 'Enter' && !onButton) { event.preventDefault(); setMode('detail'); }
    }
    if (event.key === ' ' && isFilm && !onButton) { event.preventDefault(); setPlaying(p => !p); }
  }

  const soundControl = <button className="cine-sound-button" onClick={toggleMusic} aria-label={musicEnabled && audioStatus === 'playing' ? '静音背景音乐' : '开启背景音乐'} aria-pressed={musicEnabled && audioStatus === 'playing'}>{musicEnabled && audioStatus !== 'off' ? <Volume2 size={15} /> : <VolumeX size={15} />}<span>{audioStatus === 'loading' ? 'SOUND …' : musicEnabled && audioStatus === 'playing' ? 'SOUND ON' : 'SOUND OFF'}</span></button>;
  const showClassroom = classroomPreparing || mode === 'classroom' || sharedTransitionPhase === 'returning';
  const showResearch = researchPreparing || mode === 'research' || researchReturning;
  return <LayoutGroup id="reinlab-archive-classroom"><div className={`cinema-experience ${portrait ? 'portrait' : ''} ${reduced ? 'cine-reduced' : ''}`} ref={root} hidden={!active}
    data-mode={mode} data-dolly={dollyPhase ?? undefined} data-playing={playing} data-leaving={leaving} data-shared-transition={sharedTransitionPhase ?? undefined} tabIndex={-1} aria-label="莱茵生命沉浸式档案终端" onKeyDown={onKey}>
    <div ref={sceneViewport} className="cine-scene-viewport" inert={mode === 'classroom' || mode === 'research'} style={{ visibility: visibleField ? 'visible' : 'hidden' }}>
      <div className="cine-fixed-stage cine-model-stage" style={{ transform: `translate(-50%, -50%) scale(${sceneScale})` }}>
        <ArchiveField ref={scene} selected={selected} onSelect={select} sharedElementSurface={sharedElementSurface}
          sharedTransitionPhase={sharedTransitionPhase} onSharedTransitionComplete={finishReturningTransition} />
      </div>
    </div>
    {isFilm && !bootDone && <div className="cine-fixed-stage cine-boot-stage" style={{ transform: `translate(-50%, -50%) scale(${bootScale})` }}><BootStage ref={bootScene} /></div>}

    {mode === 'ready' && <LoginGate onLogin={login} reduced={reduced} music={musicEnabled} onMusicChange={setMusicEnabled} />}
    {portalArrival && <div className="rhine-portal-arrival" role="status"><div className="rhine-portal-folder" aria-hidden="true"><span>RHINE LAB / KNOWLEDGE DIVISION</span><i /></div><div className="rhine-portal-leaf"><small>INTERNAL DATABASE / X—013</small><span>RHINE LAB</span><i /><b>LEARNING ARCHIVE</b></div><p>莱茵生命 · 已返回沉浸档案</p></div>}

    {(showArchive || isFilm && bootDone) && <div className="cine-interactive-brand"><CinematicBrand /></div>}
    {(mode !== 'ready' && mode !== 'classroom' && mode !== 'research' || archiveVisible || detailVisible) && <nav className="cine-system-nav" aria-label="档案终端导航" inert={sharedTransitionPhase !== null}>
      {isFilm ? <button onClick={skip}>ENTER SYSTEM <span>跳过演出</span><ArrowUpRight size={17} /></button> : <>
        <button onClick={() => leave(onWorkbench)}><Grid2X2 size={14} /> 工作台</button>
        {mode === 'archive' && config.id === 'learning' && <button onClick={() => enterOpenMAIC('workspace', reduced)}>OpenMAIC · 聊天主页<ArrowUpRight size={14} /></button>}
        <button onClick={start} disabled={reduced} aria-label="重播完整演出"><RotateCcw size={14} /><span>REINITIALIZE</span></button>
      </>}
      {soundControl}
      <button onClick={() => { setTimelineOpen(v => !v); setClock(time.current); setReport(meter.current.report()); }} aria-label="性能与分镜调试" aria-expanded={timelineOpen}><SlidersHorizontal size={14} /></button>
    </nav>}

    {archiveVisible && <>
      <section className="cine-archive-callout">
        <div className="cine-callout-eyebrow">INTERNAL DATABASE <span>/ {config.title}</span></div>
        <button className="cine-file-title" onClick={() => setMode('detail')}>FILE NUMBER: <span key={selected.row + selected.lane * ROWS} className="cine-roll-text">X-{String(selected.row + 1).padStart(3, '0')}</span><ArrowUpRight size={25} /></button>
        <div className="cine-callout-rule"><i /></div>
        <div className="cine-file-summary"><span key={nameFor(selected)} className="cine-roll-text">{nameFor(selected)}</span><span>WORKSPACE ARCHIVE</span></div>
        <button className="cine-access-file" onClick={() => setMode('detail')}>ACCESS FILE <ArrowRight size={17} /><span>抽取档案</span></button>
      </section>
      <div className="cine-row-nav"><button aria-label="上一个档案" disabled={selected.row === 0} onClick={() => move('row', -1)}><ArrowUp size={16} /></button><div className="cine-file-ticks">{Array.from({ length: 8 }, (_, i) => {
        const target = Math.floor(selected.row / 8) * 8 + i;
        return <button key={i} aria-label={`选择档案 ${String(target + 1).padStart(3, '0')}`} className={target === selected.row ? 'active' : ''} onClick={() => setSelected(s => ({ ...s, row: target }))} />;
      })}</div><button aria-label="下一个档案" disabled={selected.row === ROWS - 1} onClick={() => move('row', 1)}><ArrowDown size={16} /></button></div>
      <div className="cine-column-nav"><button aria-label="上一个平台" disabled={selected.lane === 0} onClick={() => move('lane', -1)}><ChevronLeft size={20} /></button><div><span>COLUMN 0{selected.lane + 1} / 04</span><strong key={config.id} className="cine-roll-text">{config.title}</strong></div><button aria-label="下一个平台" disabled={selected.lane === LANES - 1} onClick={() => move('lane', 1)}><ChevronRight size={20} /></button></div>
      <div className="cine-array-counter"><span>ARCHIVE / SELECT</span><div><b>{String(selected.row + 1).padStart(2, '0')}</b><i>/</i><span>{ROWS}</span></div></div>
      <div className="cine-navigation-hint"><span>← → 切换平台</span><span>↑ ↓ 选择档案</span><span>ENTER 抽取</span></div>
    </>}

    {detailVisible && <>
      <button className="cine-back" onClick={back}><ArrowLeft size={17} /> ARCHIVE OVERVIEW <small>返回归位 · ESC</small></button>
      <div className="cine-inspect-surface" aria-label="拖动查看档案角度" role="group"
        onPointerDown={event => {
          if (!readyToRead) return;
          drag.current = { x: event.clientX, angle: inspectAngle.current, pointer: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (!drag.current) return;
          inspectAngle.current = clamp(drag.current.angle + (event.clientX - drag.current.x) * .14, -38, 38);
          scene.current?.inspect(inspectAngle.current);
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }} />
      <div className="cine-object-caption" ref={objectCaption}><span>NO.{String(selected.row + 1).padStart(3, '0')}</span><b>INTERNAL DATABASE</b><small>DRAG TO INSPECT ↔</small><div className="cine-angle-controls"><button aria-label="向左检查档案" disabled={!readyToRead} onClick={() => { inspectAngle.current = clamp(inspectAngle.current - 12, -38, 38); scene.current?.inspect(inspectAngle.current); }}><ChevronLeft size={15} /></button><button onClick={() => { inspectAngle.current = 0; scene.current?.inspect(0); }}>复位角度</button><button aria-label="向右检查档案" disabled={!readyToRead} onClick={() => { inspectAngle.current = clamp(inspectAngle.current + 12, -38, 38); scene.current?.inspect(inspectAngle.current); }}><ChevronRight size={15} /></button></div></div>
      <article className="cine-detail-panel" ref={detailPanel} style={{ pointerEvents: readyToRead ? 'auto' : 'none' }}>
        <div className="cine-detail-kicker">WORKSPACE / {config.english}</div>
        <h1>{nameFor(selected)}</h1><div className="cine-detail-subtitle">FILE X-{String(selected.row + 1).padStart(3, '0')} <span>·</span> {config.title}</div>
        <div className="cine-detail-rule" />
        <p>{isLearningCourse ? <>这份课程档案，保留着你走过的每一步。<br />打开它，主任会带你回到上次的学习位置。</> : isResearchLab ? <>这份研究档案，将假设、实验与证据放进同一间实验室。<br />观察不同方向怎样被检验，再决定下一步。</> : <>每一份档案，都是一个可以继续探索的世界。<br />在这里组织课题、保留对话，让问题沿着自己的路径生长。</>}</p>
        <dl><div><dt>档案类型</dt><dd>{isLearningCourse ? '课程档案 / 沉浸课堂' : isResearchLab ? '实验档案 / AI 研究实验室' : '研究工作区'}</dd></div><div><dt>{isLearningCourse ? '课程角色' : '内容结构'}</dt><dd>{isLearningCourse ? '主任 / 单元教授 / 终端维护' : isResearchLab ? '共享状态 / 实验流 / 讨论记录' : '对话树 / 回应卡片 / 交互组件'}</dd></div><div><dt>接入模式</dt><dd><Check size={12} /> 本地设计演示</dd></div></dl>
        <button className="cine-enter-workspace" aria-busy={classroomImporting || researchImporting} disabled={!readyToRead || classroomImporting || researchImporting} onPointerEnter={() => { if (isResearchLab) void import('../research/ResearchLab'); }} onFocus={() => { if (isResearchLab) void import('../research/ResearchLab'); }} onClick={() => { if (isLearningCourse) void openClassroom(false, true); else if (isResearchLab) void openResearch(true); else leave(() => onOpenWorkspace(config.id, nameFor(selected))); }}>{classroomImporting || researchImporting ? '正在调阅档案' : isLearningCourse ? '打开真实课程档案' : isResearchLab ? '进入研究实验室' : '进入工作区'} <ArrowUpRight size={20} /></button>
        <p className="cine-detail-note">{classroomImportError || researchImportError || (isLearningCourse ? '进入 OpenMAIC 的真实课程库，选择课程并从书签继续。' : isResearchLab ? '实验室与课堂并列，研究记录按档案独立保存。' : '原有的对话、分支和模板功能，都在档案里。')}</p>
      </article>
    </>}

    {(classroomPreparing || researchPreparing || researchReturning || sharedTransitionPhase || dollyPhase === 'approaching' || dollyPhase === 'retreating') && <div className="cine-transition-guard" aria-hidden="true" />}
    {showClassroom && <Suspense fallback={<div className="cine-course-loading" role="status">课程档案正在展开…</div>}>
      <div className="cine-classroom-layer" data-preparing={classroomPreparing || undefined} inert={classroomPreparing}>
        <div className="cine-classroom-backdrop" aria-hidden="true" />
        {legacyClassroom
          ? <ImmersiveClassroom reduced={reduced} preparing={classroomPreparing} onPrepared={onClassroomPrepared} sharedElementSurface={classroomPreparing ? 'classroom' : sharedElementSurface} sharedTransitionPhase={sharedTransitionPhase} soundControl={soundControl} onBack={completeArchiveReturn} onReturnStart={beginArchiveReturn} />
          : <LearningClassroom key={subjectIds[selected.row % subjectIds.length]} initialSubject={subjectIds[selected.row % subjectIds.length]} reduced={reduced} preparing={classroomPreparing} onPrepared={onClassroomPrepared} sharedElementSurface={classroomPreparing ? 'classroom' : sharedElementSurface} sharedTransitionPhase={sharedTransitionPhase} soundControl={soundControl} onBack={completeArchiveReturn} onReturnStart={beginArchiveReturn} onMediaPlaying={classroomMedia} />}
      </div>
    </Suspense>}
    {showResearch && <Suspense fallback={<div className="cine-course-loading" role="status">研究档案正在展开…</div>}>
      <div className="cine-classroom-layer cine-research-layer" data-preparing={researchPreparing || undefined} inert={researchPreparing || researchReturning}>
        <div className="cine-classroom-backdrop" aria-hidden="true" />
        <ResearchLab key={nameFor(selected)} archiveName={nameFor(selected)} reduced={reduced} onBack={() => void returnResearch()} soundControl={soundControl} />
      </div>
    </Suspense>}
    {timelineOpen && mode !== 'ready' && mode !== 'classroom' && mode !== 'research' && <section className="cine-transport expanded" aria-label="动画调试面板">
      <div className="cine-frame-report" role="status"><span><b>{report.fps.toFixed(1)}</b> FPS</span><span>P95 {report.p95.toFixed(1)} ms</span><span>更新 {report.work.toFixed(2)} ms</span><span>{mode === 'film' ? bootDone ? '阵列入场' : '开场' : mode === 'archive' ? '文档库' : '详情'} · {report.frames} 帧</span></div>
      {phaseReports.length > 0 && <div className="cine-phase-reports">{phaseReports.map((entry, i) => <span key={i}>{entry.phase === 'opening' ? '开场' : entry.phase === 'arrival' ? '阵列入场' : '抽取详情'} {entry.report.fps.toFixed(1)} FPS · P95 {entry.report.p95.toFixed(1)} ms</span>)}</div>}
      {timelineOpen && <div className="cine-chapters">{chapters.map(c => <button key={c.code} className={isFilm && chapter.code === c.code ? 'active' : ''} onClick={() => seek(c.time)}><span>{c.code}</span>{c.label}</button>)}</div>}
      <div className="cine-transport-main">
        <button className="cine-play-control" onClick={() => { if (!isFilm) { start(); } else if (time.current >= FILM_END) { start(); } else setPlaying(v => !v); }} aria-label={isFilm && playing ? '暂停演出' : '播放演出'}>{isFilm && playing ? <Pause size={14} /> : <Play size={14} />}</button>
        <span className="cine-timecode">{timecode(clock)} <i>/ 00:26.6</i></span>
        <input type="range" aria-label="动画进度" min={0} max={FILM_END} step={1 / 60} value={clock} onChange={e => seek(Number(e.target.value))} />
        <select aria-label="播放速度" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={.5}>0.5×</option><option value={1}>1×</option><option value={1.5}>1.5×</option></select>
        <button onClick={() => setTimelineOpen(v => !v)} aria-label="展开分镜" aria-expanded={timelineOpen}><SlidersHorizontal size={14} /></button>
        {isFilm ? <button onClick={skip} aria-label="跳过剩余演出"><SkipForward size={15} /></button> : <button aria-label="关闭时间线" onClick={() => setTimelineOpen(false)}><X size={15} /></button>}
      </div>
      <div className="cine-play-options"><label><input type="checkbox" checked={softFlashes} onChange={e => setSoftFlashes(e.target.checked)} />柔和闪切</label><label className="cine-volume-label">音乐<input type="range" aria-label="背景音乐音量" min={0} max={.6} step={.01} value={volume} onChange={e => { const value = Number(e.target.value); setVolume(value); audio.current?.setVolume(value); }} /></label><span>逐显示帧更新 · 未锁 25 FPS</span></div>
    </section>}
    {(mode !== 'ready' && mode !== 'classroom' && mode !== 'research' || archiveVisible || detailVisible) && <footer className="cine-footer" inert={sharedTransitionPhase !== null}><span><i /> LOCAL RESEARCH TERMINAL</span><span>{identity} <b>/</b> REINLAB</span><button onClick={() => leave(onWorkbench)}>WORKBENCH <ArrowUpRight size={12} /></button></footer>}
    <span className="cine-sr-status" role="status">{mode === 'ready' ? '演示登录，任意内容均可进入' : mode === 'classroom' ? '课程档案已展开；讲义、交互对象与手记分别保留' : mode === 'research' ? `研究档案${nameFor(selected)}已展开；共享状态、实验与讨论互相连接` : mode === 'film' ? playing ? '正在播放开场，结束后停留在文档库' : '演出已暂停' : mode === 'archive' ? `已选择${config.title}的${nameFor(selected)}` : `正在查看${nameFor(selected)}`}</span>
  </div></LayoutGroup>;
}
