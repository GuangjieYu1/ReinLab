import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import Logo from './WorkbenchLogo';
import { entryWorkbenches, modulo, type EntryWorkbench } from './entryWorkbenches';
import './ceremony-workbenches.css';

/*
 * Third-round entry designs, built as CSS 3D scenes in the archive's own
 * material (frosted glass cassettes, paper, grey-green ink, a little gold).
 * One camera rig drives every scene: its pitch / yaw / dolly are registered
 * CSS properties, so openings, departures, pointer parallax and the objects
 * that turn to face the viewer all move together.
 *
 *  - an opening: how the six existing logos arrive in the scene;
 *  - a departure: what happens after a logo is chosen. It ends with the chosen
 *    logo facing the viewer, where EntryComparison picks it up and lays it onto
 *    the archive cassette in Files.
 * The logo SVGs themselves are never modified; they are only placed and timed.
 */
export type CeremonyDesign = 'catalog' | 'drafting' | 'aperture';
export const ceremonyDesigns: CeremonyDesign[] = ['catalog', 'drafting', 'aperture'];

type Props = { design: CeremonyDesign; selected: number; reduced: boolean; locked: boolean; handoff?: boolean;
  onSelect: (index: number) => void; onEnter: (workbench: EntryWorkbench, source?: HTMLElement) => void };
type Phase = 'intro' | 'idle' | 'leaving';
type SceneProps = { selected: number; phase: Phase; reduced: boolean; logoDelay: (index: number) => number; pick: (index: number) => void; enter: () => void };

const settings: Record<CeremonyDesign, { label: string; intro: number; leave: number; logo: number; hint: string }> = {
  catalog: { label: 'CASSETTE RACK / DRAWER A', intro: 2900, leave: 1150, logo: 2150, hint: '点击标签抽出档案匣 · 点击档案匣进入' },
  drafting: { label: 'PLAN & ELEVATION / PLATE 01', intro: 3300, leave: 1250, logo: 2500, hint: '点击平面图上的工位 · 点击立面进入' },
  aperture: { label: 'APERTURE / FOCUS BARREL', intro: 3100, leave: 1250, logo: 2350, hint: '点击环上的工作台对焦 · 点击镜心进入' },
};
const shortNames = ['课程', '研究', '工程', '创作', '自动化', '规划探索'];
const fileCode = (index: number) => `X—${String(13 + index).padStart(3, '0')}`;
const vars = (values: Record<string, string | number>) => values as CSSProperties;

function Emblem({ workbench, live, reduced, wait = 0, source = false }: { workbench: EntryWorkbench; live: boolean; reduced: boolean; wait?: number; source?: boolean }) {
  return <span className="ceremony-emblem" data-workbench={workbench.id} data-ceremony-source={source ? 'true' : undefined}>
    <Logo key={`${workbench.id}:${live}`} workbench={workbench} still={reduced || !live} startAt={.4} delay={live && !reduced ? wait : 0} />
  </span>;
}

/** A box with six faces, centred on its parent's origin. */
function Slab({ w, h, d, className = '', front, top, children }: { w: number; h: number; d: number; className?: string; front?: ReactNode; top?: ReactNode; children?: ReactNode }) {
  return <div className={`c3-slab ${className}`} style={vars({ '--w': `${w}px`, '--h': `${h}px`, '--d': `${d}px` })}>
    <div className="c3-face c3-back" /><div className="c3-face c3-left" /><div className="c3-face c3-right" /><div className="c3-face c3-bottom" />
    <div className="c3-face c3-top">{top}</div>
    <div className="c3-face c3-front">{front}</div>
    {children}
  </div>;
}

/** Front of a glass cassette, matching the archive cassettes in Files. */
function GlassFace({ workbench, index, emblem }: { workbench: EntryWorkbench; index: number; emblem: ReactNode }) {
  return <>
    <span className="c3-frost" /><span className="c3-border" /><span className="c3-slot" />
    <span className="c3-screw c3-screw-a" /><span className="c3-screw c3-screw-b" />
    <span className="c3-etch">RHINE LAB<small>INTERNAL DATABASE</small></span>
    <span className="c3-seal">{emblem}</span>
    <span className="c3-meta"><b>{workbench.code}</b><strong>{workbench.title}</strong><small>{workbench.english}</small></span>
    <span className="c3-serial">{fileCode(index)}<small>{workbench.fileKind} ARCHIVE</small></span>
  </>;
}

export default function CeremonyWorkbenchChooser({ design, selected, reduced, locked, handoff = false, onSelect, onEnter }: Props) {
  const root = useRef<HTMLElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const enterRef = useRef(onEnter); enterRef.current = onEnter;
  const config = settings[design];
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [take, setTake] = useState(0);
  const [phase, setPhase] = useState<Phase>(reduced ? 'idle' : 'intro');
  const [introIndex, setIntroIndex] = useState(selected);
  const previous = useRef(selected);
  const active = entryWorkbenches[selected];

  useEffect(() => {
    const element = root.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (reduced) { setPhase('idle'); return; }
    setPhase('intro');
    const timer = setTimeout(() => setPhase(value => value === 'intro' ? 'idle' : value), config.intro);
    return () => clearTimeout(timer);
  }, [take, reduced, config.intro]);
  useEffect(() => {
    // Any change of selection ends the opening; the chosen logo then plays immediately.
    if (previous.current === selected) return;
    previous.current = selected;
    setIntroIndex(-1); setPhase(value => value === 'intro' ? 'idle' : value);
  }, [selected]);
  useEffect(() => {
    if (phase !== 'leaving') return;
    const timer = setTimeout(() => {
      const source = root.current?.querySelector<HTMLElement>('[data-ceremony-source="true"]') ?? undefined;
      enterRef.current(entryWorkbenches[selected], source);
    }, reduced ? 0 : config.leave);
    return () => clearTimeout(timer);
  }, [phase, selected, reduced, config.leave]);
  useEffect(() => {
    // EntryComparison skips its own Enter shortcut for these designs so that
    // the keyboard path also plays the departure choreography.
    const handle = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button,a,input,select,textarea')) return;
      event.preventDefault(); enter();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  });

  function pick(index: number) {
    if (locked || phase === 'leaving') return;
    const next = modulo(index, entryWorkbenches.length);
    if (next === selected) { if (phase === 'intro') setPhase('idle'); return; }
    onSelect(next);
  }
  function enter() {
    if (locked || phase === 'leaving') return;
    setPhase('leaving');
  }
  function replay() {
    if (locked || phase === 'leaving' || reduced) return;
    setIntroIndex(selected); setPhase('intro'); setTake(value => value + 1);
  }

  const portrait = size.width < size.height * .8;
  const scale = portrait ? Math.min(size.width / 1180, size.height / 1080) : Math.min(size.width / 1920, size.height / 1080);
  const shiftY = portrait ? -size.height * .1 : 0;
  const scene: SceneProps = { selected, phase, reduced, pick, enter, logoDelay: index => index === introIndex ? config.logo : 0 };

  return <section ref={root} className={`ceremony ceremony-${design}`} data-phase={phase} data-reduced={reduced} data-handoff={handoff} inert={locked} aria-label={`${config.label} 工作台选择`}
    onPointerMove={event => {
      if (reduced || !world.current) return;
      const box = event.currentTarget.getBoundingClientRect();
      world.current.style.setProperty('--px', (((event.clientX - box.left) / box.width - .5) * 2).toFixed(3));
      world.current.style.setProperty('--py', (((event.clientY - box.top) / box.height - .5) * 2).toFixed(3));
    }}
    onPointerLeave={() => { world.current?.style.setProperty('--px', '0'); world.current?.style.setProperty('--py', '0'); }}>
    <div className="ceremony-stage">
      <div className="ceremony-canvas" style={{ transform: `translate(-50%, calc(-50% + ${shiftY}px)) scale(${scale})` }}>
        <div key={take} ref={world} className="c3-world">
          <div className="c3-view"><div className="c3-camera">
            {design === 'catalog' && <RackScene {...scene} />}
            {design === 'drafting' && <PlanScene {...scene} />}
            {design === 'aperture' && <BarrelScene {...scene} />}
          </div></div>
        </div>
      </div>
      <div className="ceremony-atmosphere" />
    </div>
    <div className="ceremony-ui">
      <header className="ceremony-brand"><strong>RHINE LAB</strong><span>SYNTHESIZE INFORMATION</span><div>WORKBENCH <b>OS</b></div></header>
      <div className="ceremony-series">{config.label}<span>PERSONAL AI STUDIO / 06</span></div>
      <div className="ceremony-caption" key={active.id}>
        <span>{active.english} / {active.code}</span><h1>{active.title}</h1><p>{active.description}</p>
        <button onClick={enter}>ACCESS STUDIO<ArrowRight size={19} /><small>进入工作台</small></button>
      </div>
      <nav className="ceremony-register" aria-label="快速选择工作台">{entryWorkbenches.map((workbench, index) =>
        <button key={workbench.id} aria-pressed={index === selected} onClick={() => pick(index)}><span>{workbench.code}</span><b>{shortNames[index]}</b><i /></button>)}</nav>
      <div className="ceremony-position"><span>DEPARTMENT SELECT</span><b>{active.code}</b><i>/</i><small>06</small>
        <button aria-label="上一个工作台" onClick={() => pick(selected - 1)}><ChevronLeft size={17} /></button>
        <button aria-label="下一个工作台" onClick={() => pick(selected + 1)}><ChevronRight size={17} /></button></div>
      <div className="ceremony-tools"><span>{config.hint}</span><button onClick={replay} disabled={reduced}><RotateCcw size={11} />重播开场</button></div>
    </div>
  </section>;
}

/* ── 01 档案匣架 ───────────────────────────────────────────────────────────
 * Six glass cassettes stand in a tray, the same objects as the archive in
 * Files. Opening: the camera swings in, the tray rises, cassettes drop into
 * their slots back to front, then the current one is pulled up and turns to
 * face the viewer while its logo draws. Departure: the rack sinks away and the
 * chosen cassette comes forward toward the camera. */
const CASSETTE = { w: 400, h: 296, d: 26 };
function RackScene({ selected, reduced, logoDelay, pick, enter }: SceneProps) {
  return <>
    <div className="rk-tray">
      <div className="rk-floor" />
      <div className="rk-wall" style={{ transform: 'translate3d(0px,-24px,238px)' }}><Slab w={572} h={48} d={14} className="rk-lip" front={<span className="rk-label">WORKBENCH INDEX<small>RHINE LAB · DRAWER A · 01 — 06</small></span>} /></div>
      <div className="rk-wall" style={{ transform: 'translate3d(0px,-24px,-238px)' }}><Slab w={572} h={48} d={14} className="rk-lip" /></div>
      <div className="rk-wall" style={{ transform: 'translate3d(-279px,-24px,0px)' }}><Slab w={14} h={48} d={462} className="rk-lip" /></div>
      <div className="rk-wall" style={{ transform: 'translate3d(279px,-24px,0px)' }}><Slab w={14} h={48} d={462} className="rk-lip" /></div>
    </div>
    {entryWorkbenches.map((workbench, index) => {
      const raised = index === selected;
      return <div key={workbench.id} className="rk-slot" data-raised={raised} style={vars({ '--z': `${158 - index * 62}px`, '--i': index })}>
        <div className="rk-drop"><div className="rk-turn">
          <Slab w={CASSETTE.w} h={CASSETTE.h} d={CASSETTE.d} className="c3-glass"
            front={<GlassFace workbench={workbench} index={index} emblem={<Emblem workbench={workbench} live={raised} reduced={reduced} wait={logoDelay(index)} source={raised} />} />}
            top={<span className="rk-top">RHINE LAB / {fileCode(index)}</span>}>
            <button className="rk-tab" style={vars({ '--tab': index })} aria-pressed={raised} aria-label={`${workbench.code} / ${workbench.title}`} onClick={() => pick(index)}><span>{workbench.code}</span><b>{shortNames[index]}</b></button>
            <button className="rk-hit" tabIndex={raised ? 0 : -1} aria-label={raised ? `进入${workbench.title}` : workbench.title} onClick={() => raised ? enter() : pick(index)} />
          </Slab>
        </div></div>
      </div>;
    })}
  </>;
}

/* ── 02 制图详图 ───────────────────────────────────────────────────────────
 * A drafting plan lies on the table; the logos are printed on it as stations.
 * The current station is projected up into an elevation: a glass plate that
 * pops up from the paper, with projection lines tying it to its plan circle.
 * Opening: the camera tilts down onto the plate, the construction draws itself
 * and the elevation folds up. Departure: the camera levels with the elevation
 * and the plan falls away into a line. */
const PLAN = { w: 1200, h: 700, y: 500 };
const stationX = (index: number) => 200 + index * 160;
function PlanScene({ selected, phase, reduced, logoDelay, pick, enter }: SceneProps) {
  const intro = phase === 'intro';
  const workbench = entryWorkbenches[selected];
  const x = stationX(selected);
  const draw = (seconds: number, duration = .7) => vars({ '--delay': `${seconds}s`, '--dur': `${duration}s` });
  return <>
    <div className="dr3-plan">
      <svg viewBox={`0 0 ${PLAN.w} ${PLAN.h}`} aria-hidden="true">
        <defs>
          <pattern id="ceremony-dr3-minor" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#b5b8a2" strokeOpacity=".35" strokeWidth=".6" /></pattern>
          <pattern id="ceremony-dr3-major" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#ceremony-dr3-minor)" /><path d="M100 0H0V100" fill="none" stroke="#a3a890" strokeOpacity=".45" strokeWidth="1" /></pattern>
        </defs>
        <rect className="dr3-paper" width={PLAN.w} height={PLAN.h} />
        <rect width={PLAN.w} height={PLAN.h} fill="url(#ceremony-dr3-major)" className="dr3-grid" />
        <rect className="d-draw dr-fine" pathLength={1} x={24} y={24} width={PLAN.w - 48} height={PLAN.h - 48} style={draw(.2, 1.2)} />
        <path className="d-draw" pathLength={1} d={`M100 ${PLAN.y}H1100`} style={draw(.45, 1)} />
        {entryWorkbenches.map((item, index) => {
          const nx = stationX(index);
          return <g key={item.id}>
            <path className="d-draw dr-fine" pathLength={1} d={`M${nx} ${PLAN.y - 106}V${PLAN.y + 106}`} style={draw(.6 + index * .07)} />
            <circle className="d-draw" pathLength={1} cx={nx} cy={PLAN.y} r={70} style={draw(.9 + index * .1)} />
            <text className="dr-text dr-fade" x={nx - 64} y={PLAN.y + 100} style={draw(1.3 + index * .06)}>{item.code} · X{nx}</text>
          </g>;
        })}
        <path className="d-draw dr-fine" pathLength={1} d={`M${stationX(0)} 640H${stationX(5)}`} style={draw(1.5)} />
        <text className="dr-text dr-fade" x={(stationX(0) + stationX(5)) / 2} y={630} textAnchor="middle" style={draw(1.8)}>800 · 06 STATIONS · PLAN</text>
        <rect className="d-draw" pathLength={1} x={790} y={50} width={360} height={110} style={draw(1.3)} />
        <path className="d-draw dr-fine" pathLength={1} d="M790 86H1150M790 124H1150M990 124V160" style={draw(1.5)} />
        <text className="dr-text dr-strong dr-fade" x={806} y={74} style={draw(1.7)}>RHINE LAB · PERSONAL AI STUDIO</text>
        <text className="dr-text dr-fade" x={806} y={111} style={draw(1.8)}>PLATE 01 · PLAN AND ELEVATION</text>
        <text className="dr-text dr-fade" x={806} y={148} style={draw(1.9)}>DRAWN / LOCAL</text>
        <text className="dr-text dr-fade" x={1006} y={148} style={draw(1.95)}>SHEET 1 / 1</text>
        <circle className="dr3-marker" r={84} style={{ transform: `translate(${x}px, ${PLAN.y}px)` }} />
      </svg>
      {entryWorkbenches.map((item, index) => <button key={item.id} className="dr3-station" data-current={index === selected} style={vars({ left: stationX(index) - 58, top: PLAN.y - 58, '--i': index })}
        aria-pressed={index === selected} aria-label={`${item.code} / ${item.title}`} onClick={() => index === selected ? enter() : pick(index)}>
        <Emblem workbench={item} live={false} reduced={reduced} />
      </button>)}
    </div>
    <div className="dr3-mount" style={vars({ '--sx': `${x - PLAN.w / 2}px`, '--sz': `${PLAN.y - PLAN.h / 2}px` })}>
      <svg className="dr3-projection" viewBox="0 0 380 70" aria-hidden="true" key={`projection-${selected}`}>
        <path d="M120 70L0 0M260 70L380 0" /><path className="dr3-axis" d="M190 70V0" />
      </svg>
      <div className="dr3-hinge">
        <button key={`plate-${selected}`} className="dr3-plate" style={vars({ '--pop': intro ? '2.05s' : '.25s' })} aria-label={`进入${workbench.title}`} onClick={enter}>
          <span className="c3-frost" /><span className="c3-border" />
          <span className="dr3-plate-label">ELEVATION {workbench.code} · {workbench.english}</span>
          <span className="dr3-plate-emblem"><Emblem workbench={workbench} live reduced={reduced} wait={logoDelay(selected)} source /></span>
          <span className="dr3-plate-scale">SCALE 2.5 : 1 · {fileCode(selected)}</span>
          <i className="dr3-tick dr3-tick-a" /><i className="dr3-tick dr3-tick-b" /><i className="dr3-tick dr3-tick-c" /><i className="dr3-tick dr3-tick-d" />
        </button>
      </div>
    </div>
  </>;
}

/* ── 03 光圈对焦 ───────────────────────────────────────────────────────────
 * A lens barrel with real depth: housing rings, a numbered focus ring and an
 * iris of six blades. The workbenches orbit the barrel on a tilted ring.
 * Opening: the barrel assembles out of depth, the focus ring spins and settles,
 * the blades open on the current logo. Selecting turns the ring while the iris
 * narrows and re-opens. Departure: the camera swings onto the axis and the
 * barrel rushes past it, leaving only the logo in the frame. */
const SHELLS = [64, 50, 36, 22, 8, -6, -20, -34, -48, -62, -76, -90, -104, -118];
function useDial(target: number) {
  const dial = useRef(target);
  return useMemo(() => {
    const value = target + 360 * Math.round((dial.current - target) / 360);
    dial.current = value; return value;
  }, [target]);
}
function BarrelScene({ selected, phase, reduced, logoDelay, pick, enter }: SceneProps) {
  const [shown, setShown] = useState(selected);
  const [refocus, setRefocus] = useState(false);
  const rotation = useDial(150 - selected * 60);
  useEffect(() => {
    if (shown === selected) return;
    if (reduced) { setShown(selected); return; }
    setRefocus(true);
    const timer = setTimeout(() => { setShown(selected); setRefocus(false); }, 430);
    return () => clearTimeout(timer);
  }, [selected, shown, reduced]);
  const open = phase === 'leaving' ? 330 : refocus ? 66 : 214;
  const twist = phase === 'leaving' ? -12 : refocus ? 24 : 0;
  const workbench = entryWorkbenches[shown];
  return <>
    <div className="ap3-barrel" style={vars({ '--ap-open': open, '--ap-twist': twist })}>
      <i className="ap3-back" style={vars({ '--z': '-132px', '--i': 15 })} />
      {SHELLS.map((z, index) => <i key={z} className="ap3-shell" style={vars({ '--z': `${z}px`, '--i': index })} />)}
      <i className="ap3-step" style={vars({ '--z': '30px', '--r': '282px', '--i': 2 })} />
      <i className="ap3-step" style={vars({ '--z': '-12px', '--r': '268px', '--i': 5 })} />
      <i className="ap3-step" style={vars({ '--z': '-40px', '--r': '256px', '--i': 7 })} />
      <svg className="ap3-blades" viewBox="-260 -260 520 520" style={vars({ '--z': '-52px', '--i': 8 })} aria-hidden="true">
        <defs><clipPath id="ceremony-ap3-clip"><circle r={251} /></clipPath></defs>
        <g clipPath="url(#ceremony-ap3-clip)">{[0, 1, 2, 3, 4, 5].map(index => <g key={index} style={{ transform: `rotate(${index * 60}deg)` }}>
          <g className="ap-blade"><path d="M-300 0H300V-320H-300Z" /><path className="ap-blade-line" d="M-300 -16H300" /></g>
        </g>)}</g>
      </svg>
      <svg className="ap3-dial" viewBox="-400 -400 800 800" style={vars({ '--z': '70px', '--i': 0 })} aria-hidden="true">
        <circle className="ap3-bezel" r={318} />
        <g className="ap-dial" style={{ transform: `rotate(${rotation}deg)` }}><g className="ap-dial-spin">
          {Array.from({ length: 72 }, (_, index) => {
            const major = index % 12 === 0;
            return <line key={index} className={major ? 'ap-tick ap-major' : 'ap-tick'} x1={0} x2={0} y1={-292} y2={major ? -330 : -308} transform={`rotate(${index * 5})`} />;
          })}
          {entryWorkbenches.map((item, index) => <text key={item.id} className="ap-number" data-current={index === selected} x={0} y={-342} textAnchor="middle" transform={`rotate(${index * 60})`}>{item.code}</text>)}
        </g></g>
        <circle className="ap3-rim" r={372} />
        <path className="ap-index" d="M-9 -386L9 -386L0 -368Z" transform="rotate(150)" />
      </svg>
      <div className="ap3-logo" style={vars({ '--z': phase === 'leaving' ? '240px' : '-74px' })}>
        <button className="ap3-center" aria-label={`进入${workbench.title}`} onClick={enter}><Emblem workbench={workbench} live reduced={reduced} wait={logoDelay(shown)} source /></button>
      </div>
    </div>
    <div className="ap3-ring-plane">
      <i className="ap3-orbit-line" /><i className="ap3-index" style={{ transform: 'rotateZ(150deg) translateY(-520px)' }} />
      <div className="ap3-orbit" style={{ transform: `rotateZ(${rotation}deg)` }}>
        {entryWorkbenches.map((item, index) => {
          const current = index === selected;
          return <div key={item.id} className="ap3-arm" style={{ transform: `rotateZ(${index * 60}deg) translateY(-520px)` }}>
            <div className="ap3-token" style={{ transform: `rotateZ(${-index * 60 - rotation}deg)` }}><div className="ap3-bill">
              <button className="ap3-sat" data-current={current} style={vars({ '--i': index })} aria-pressed={current} aria-label={`${item.code} / ${item.title}`} onClick={() => current ? enter() : pick(index)}>
                <Emblem workbench={item} live={false} reduced={reduced} /><span className="ap3-label">{item.code} · {shortNames[index]}</span>
              </button>
            </div></div>
          </div>;
        })}
      </div>
    </div>
  </>;
}
