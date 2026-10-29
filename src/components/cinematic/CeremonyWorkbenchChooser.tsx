import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import Logo from './WorkbenchLogo';
import { countLabel, entryWorkbenches, modulo, WORKBENCH_COUNT as N, type EntryWorkbench } from './entryWorkbenches';
import './ceremony-workbenches.css';
import './ceremony-math.css';

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
export type CeremonyDesign = 'quantum' | 'mobius' | 'fractal' | 'lorenz' | 'crystal' | 'drafting' | 'aperture' | 'helix' | 'catalog';
export const ceremonyDesigns: CeremonyDesign[] = ['quantum', 'mobius', 'fractal', 'lorenz', 'crystal', 'drafting', 'aperture', 'helix', 'catalog'];
/** Designs that continue straight out of the opening's authorization ring. */
const SEEDED: CeremonyDesign[] = ['quantum', 'mobius', 'fractal', 'lorenz', 'crystal', 'helix'];
/** Designs that carry the editorial reading layer (section block, index, readout, callout). */
const EDITORIAL: CeremonyDesign[] = ['quantum', 'mobius', 'fractal', 'lorenz', 'crystal', 'drafting', 'aperture'];
/** Four-letter section codes, used as display type in the editorial layer. */
export const SECTION_CODES = ['CURR', 'RSCH', 'ENGR', 'CRTV', 'AUTO', 'EXPL', 'DATA'];
/** Angle between neighbouring sections on the round scenes. */
const STEP = 360 / N;
const TAGLINES: Partial<Record<CeremonyDesign, [string, string]>> = {
  quantum: ['在被观测之前，每一个部门都同时存在。', 'BEFORE OBSERVATION, EVERY SECTION IS A SUPERPOSITION'],
  mobius: ['只有一个面，只有一条边。档案没有背面。', 'ONE SIDE · ONE EDGE · NO REVERSE'],
  fractal: ['每一个部分，都是整体的缩影。', 'EVERY PART CONTAINS THE WHOLE'],
  lorenz: ['确定的方程，无法预言的轨迹。', 'DETERMINISTIC, YET NEVER REPEATING'],
  crystal: ['换一个角度，混乱就成为秩序。', 'THE RIGHT AXIS TURNS NOISE INTO ORDER'],
  drafting: ['先画出来，再造出来。', 'DRAWN BEFORE IT IS BUILT'],
  aperture: ['对准焦点，其余都会安静下来。', 'FOCUS, AND EVERYTHING ELSE GOES QUIET'],
};

type Props = { design: CeremonyDesign; selected: number; reduced: boolean; locked: boolean; handoff?: boolean; returning?: boolean;
  onSelect: (index: number) => void; onEnter: (workbench: EntryWorkbench, source?: HTMLElement) => void };
type Phase = 'intro' | 'idle' | 'leaving';
type SceneProps = { selected: number; phase: Phase; reduced: boolean; logoDelay: (index: number) => number; pick: (index: number) => void; enter: () => void };

const settings: Record<CeremonyDesign, { label: string; intro: number; leave: number; logo: number; hint: string }> = {
  helix: { label: 'GENOME INDEX / DOUBLE HELIX', intro: 3400, leave: 1250, logo: 2350, hint: '滚动、拖动或点击转动螺旋 · 点击中央切片进入' },
  quantum: { label: `VACUUM STATE / ${countLabel} EIGENSTATES`, intro: 3500, leave: 1250, logo: 2500, hint: '滚动、拖动或点击波包进行观测 · 点击坍缩的态进入' },
  mobius: { label: 'MÖBIUS ARCHIVE / ONE SIDE · ONE EDGE', intro: 4000, leave: 1250, logo: 3400, hint: '滚动、拖动或点击环上的部门，镜头沿缎带飞过去 · 点击档案卡进入' },
  fractal: { label: 'HEXAFLAKE / SYMMETRY GROUP D6', intro: 3500, leave: 1300, logo: 2500, hint: '点击分形单元施加群作用：相邻用旋转，相对用镜面翻折，中心单元在群作用下不动 · 点击前方单元进入' },
  lorenz: { label: 'LORENZ ATTRACTOR / σ 10 · ρ 28 · β 8⁄3', intro: 3600, leave: 1250, logo: 2600, hint: '滚动、拖动或点击状态点，在相空间中穿行 · 点击前方状态进入' },
  crystal: { label: 'BCC LATTICE / ZONE AXES', intro: 3600, leave: 1250, logo: 3200, hint: '点击晶带轴转动晶体，对准后显出衍射像 · 点击中央透镜进入' },
  catalog: { label: 'CASSETTE RACK / DRAWER A', intro: 2900, leave: 1150, logo: 2150, hint: '点击标签抽出档案匣 · 点击档案匣进入' },
  drafting: { label: 'PLAN & ELEVATION / PLATE 01', intro: 3300, leave: 1250, logo: 2500, hint: '点击平面图上的工位 · 点击立面进入' },
  aperture: { label: 'APERTURE / FOCUS BARREL', intro: 3100, leave: 1250, logo: 2350, hint: '点击环上的工作台对焦 · 点击镜心进入' },
};
const shortNames = ['课程', '研究', '工程', '创作', '自动化', '规划探索', '数据'];
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

export default function CeremonyWorkbenchChooser({ design, selected, reduced, locked, handoff = false, returning = false, onSelect, onEnter }: Props) {
  const root = useRef<HTMLElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const enterRef = useRef(onEnter); enterRef.current = onEnter;
  const config = settings[design];
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [take, setTake] = useState(0);
  // returning：从 Files 返回时不重播开场，直接以就位状态出现，由入口的回飞标识接上。
  const [phase, setPhase] = useState<Phase>(reduced || returning ? 'idle' : 'intro');
  const returnedAtMount = useRef(returning);
  const [introIndex, setIntroIndex] = useState(selected);
  const previous = useRef(selected);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const wheel = useRef(0);
  const dragged = useRef(0);
  const active = entryWorkbenches[selected];

  useEffect(() => {
    const element = root.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // 只有挂载时的第一次开场才跳过（take === 0）；之后点「重播开场」仍会正常播放。不在 effect 里改 ref，StrictMode 下重复执行也一致。
    if (reduced || (returnedAtMount.current && take === 0)) { setPhase('idle'); return; }
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
    if (locked || phase === 'leaving' || performance.now() - dragged.current < 120) return;
    const next = modulo(index, entryWorkbenches.length);
    if (next === selected) { if (phase === 'intro') setPhase('idle'); return; }
    onSelect(next);
  }
  function enter() {
    if (locked || phase === 'leaving' || performance.now() - dragged.current < 120) return;
    setPhase('leaving');
  }
  function replay() {
    if (locked || phase === 'leaving' || reduced) return;
    setIntroIndex(selected); setPhase('intro'); setTake(value => value + 1);
  }

  const portrait = size.width < size.height * .8;
  const scale = portrait ? Math.min(size.width / 1180, size.height / 1080) : Math.min(size.width / 1920, size.height / 1080);
  // Tall scenes (the goniometer) sit a little lower on phones to clear the brand.
  const shiftY = portrait ? -size.height * (design === 'mobius' || design === 'crystal' ? .02 : .1) : 0;
  const scene: SceneProps = { selected, phase, reduced, pick, enter, logoDelay: index => index === introIndex ? config.logo : 0 };
  const group = useGroupAction(selected);
  const editorial = EDITORIAL.includes(design);
  const code = useScramble(SECTION_CODES[selected], reduced || !editorial);
  const readout = editorial ? readoutFor(design, selected, group) : null;
  const tagline = TAGLINES[design];

  return <section ref={root} className={`ceremony ceremony-${design}${SEEDED.includes(design) ? ' ceremony-seeded' : ''}${editorial ? ' ceremony-editorial' : ''}`} data-phase={phase} data-reduced={reduced} data-handoff={handoff} data-returning={returning || undefined} inert={locked} aria-label={`${config.label} 工作台选择`}
    onPointerMove={event => {
      if (reduced || !world.current) return;
      const box = event.currentTarget.getBoundingClientRect();
      world.current.style.setProperty('--px', (((event.clientX - box.left) / box.width - .5) * 2).toFixed(3));
      world.current.style.setProperty('--py', (((event.clientY - box.top) / box.height - .5) * 2).toFixed(3));
    }}
    onPointerLeave={() => { drag.current = null; world.current?.style.setProperty('--px', '0'); world.current?.style.setProperty('--py', '0'); }}
    onPointerDown={event => { if (SEEDED.includes(design) && !(event.target as HTMLElement).closest('.ceremony-ui')) drag.current = { x: event.clientX, y: event.clientY }; }}
    onPointerUp={event => {
      const start = drag.current; drag.current = null;
      if (!start || !SEEDED.includes(design)) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      // The helix turns like a screw: vertical or horizontal drags both work.
      const delta = Math.abs(dy) > Math.abs(dx) ? dy : dx;
      if (Math.abs(delta) < 48) return;
      pick(selected + (delta < 0 ? 1 : -1)); dragged.current = performance.now();
    }}
    onWheel={event => {
      if (!SEEDED.includes(design) || Math.abs(event.deltaY) < 12 || performance.now() - wheel.current < 520) return;
      wheel.current = performance.now(); pick(selected + (event.deltaY > 0 ? 1 : -1));
    }}>
    <div className="ceremony-stage">
      {SEEDED.includes(design) && <div className="hx-paper" />}
      {editorial && <div className="ed-ghost" aria-hidden="true"><span key={selected}>{SECTION_CODES[selected]}</span></div>}
      <div className="ceremony-canvas" style={{ transform: `translate(-50%, calc(-50% + ${shiftY}px)) scale(${scale})` }}>
        <div key={take} ref={world} className="c3-world">
          <div className="c3-view"><div className="c3-camera">
            {design === 'helix' && <HelixScene {...scene} />}
            {design === 'quantum' && <QuantumScene {...scene} />}
            {design === 'mobius' && <MobiusScene {...scene} />}
            {design === 'fractal' && <FractalScene {...scene} group={group} />}
            {design === 'lorenz' && <LorenzScene {...scene} />}
            {design === 'crystal' && <CrystalScene {...scene} />}
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
      <div className="ceremony-series">{config.label}<span>PERSONAL AI STUDIO / {countLabel}</span></div>
      {editorial ? <div className="ed-caption">
        <div className="ed-tag"><b>SECTION</b><span>{active.code} / {countLabel}</span></div>
        <div className="ed-block"><strong>{code}</strong><i>×</i><small>{active.english}</small><span key={selected} className="ed-wipe" /></div>
        <div className="ed-title" key={active.id}><h1>{active.title}</h1><p>{active.description}</p></div>
        <button className="ed-access" onClick={enter}><span>ACCESS STUDIO</span><small>进入工作台</small><ArrowRight size={17} /></button>
      </div> : <div className="ceremony-caption" key={active.id}>
        <span>{active.english} / {active.code}</span><h1>{active.title}</h1><p>{active.description}</p>
        <button onClick={enter}>ACCESS STUDIO<ArrowRight size={19} /><small>进入工作台</small></button>
      </div>}
      {editorial && readout && <div className="ed-readout"><span>{readout.label}</span><b key={readout.value}>{readout.value}</b><small>{readout.note}</small></div>}
      {editorial && <nav className="ed-index" aria-label="快速选择工作台">{entryWorkbenches.map((workbench, index) =>
        <button key={workbench.id} aria-pressed={index === selected} onClick={() => pick(index)}><b>{SECTION_CODES[index]}</b><span>{workbench.code}</span><small>{shortNames[index]}</small><i /></button>)}</nav>}
      {editorial && tagline && <div className="ed-line"><b>{tagline[0]}</b><span>{tagline[1]}</span></div>}
      {editorial && design !== 'mobius' && design !== 'lorenz' && <Callout root={root} active={phase !== 'leaving' && !handoff && !reduced} code={SECTION_CODES[selected]} serial={fileCode(selected)} title={shortNames[selected]} />}
      <nav className="ceremony-register" aria-label="快速选择工作台">{entryWorkbenches.map((workbench, index) =>
        <button key={workbench.id} aria-pressed={index === selected} onClick={() => pick(index)}><span>{workbench.code}</span><b>{shortNames[index]}</b><i /></button>)}</nav>
      <div className="ceremony-position"><span>DEPARTMENT SELECT</span><b>{active.code}</b><i>/</i><small>{countLabel}</small>
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
      <div className="rk-wall" style={{ transform: 'translate3d(0px,-24px,238px)' }}><Slab w={572} h={48} d={14} className="rk-lip" front={<span className="rk-label">WORKBENCH INDEX<small>RHINE LAB · DRAWER A · 01 — {countLabel}</small></span>} /></div>
      <div className="rk-wall" style={{ transform: 'translate3d(0px,-24px,-238px)' }}><Slab w={572} h={48} d={14} className="rk-lip" /></div>
      <div className="rk-wall" style={{ transform: 'translate3d(-279px,-24px,0px)' }}><Slab w={14} h={48} d={462} className="rk-lip" /></div>
      <div className="rk-wall" style={{ transform: 'translate3d(279px,-24px,0px)' }}><Slab w={14} h={48} d={462} className="rk-lip" /></div>
    </div>
    {entryWorkbenches.map((workbench, index) => {
      const raised = index === selected;
      return <div key={workbench.id} className="rk-slot" data-raised={raised} style={vars({ '--z': `${((N - 1) / 2 - index) * Math.min(62, 400 / (N - 1))}px`, '--i': index })}>
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
const stationX = (index: number) => Math.round(130 + index * (870 / (N - 1)));
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
        <path className="d-draw dr-fine" pathLength={1} d={`M${stationX(0)} 640H${stationX(N - 1)}`} style={draw(1.5)} />
        <text className="dr-text dr-fade" x={(stationX(0) + stationX(N - 1)) / 2} y={630} textAnchor="middle" style={draw(1.8)}>{stationX(N - 1) - stationX(0)} · {countLabel} STATIONS · PLAN</text>
        <rect className="d-draw" pathLength={1} x={790} y={50} width={360} height={110} style={draw(1.3)} />
        <path className="d-draw dr-fine" pathLength={1} d="M790 86H1150M790 124H1150M990 124V160" style={draw(1.5)} />
        <text className="dr-text dr-strong dr-fade" x={806} y={74} style={draw(1.7)}>RHINE LAB · PERSONAL AI STUDIO</text>
        <text className="dr-text dr-fade" x={806} y={111} style={draw(1.8)}>PLATE 01 · PLAN AND ELEVATION</text>
        <text className="dr-text dr-fade" x={806} y={148} style={draw(1.9)}>DRAWN / LOCAL</text>
        <text className="dr-text dr-fade" x={1006} y={148} style={draw(1.95)}>SHEET 1 / 1</text>
        <circle className="dr3-marker" r={84} style={{ transform: `translate(${x}px, ${PLAN.y}px)` }} />
        <rect className="dr3-title-block" x={790} y={50} width={360} height={36} />
        <text className="dr3-title-text" x={806} y={75}>PLATE 01 · {SECTION_CODES[selected]}</text>
      </svg>
      <i className="dr3-rail" style={{ top: PLAN.y + 160 }} />
      <i className="dr3-carriage" style={vars({ top: PLAN.y + 160, '--x': `${x}px` })}><b /><span>{SECTION_CODES[selected]} · X {x}</span></i>
      {entryWorkbenches.map((item, index) => <button key={item.id} className="dr3-station" data-current={index === selected} style={vars({ left: stationX(index) - 58, top: PLAN.y - 58, '--i': index })}
        aria-pressed={index === selected} aria-label={`${item.code} / ${item.title}`} onClick={() => index === selected ? enter() : pick(index)}>
        <Emblem workbench={item} live={false} reduced={reduced} />
        <span className="dr3-chip"><b>{SECTION_CODES[index]}</b>{item.code}</span>
      </button>)}
    </div>
    <div className="dr3-mount" style={vars({ '--sx': `${x - PLAN.w / 2}px`, '--sz': `${PLAN.y - PLAN.h / 2}px` })}>
      <svg className="dr3-projection" viewBox="0 0 380 70" aria-hidden="true" key={`projection-${selected}`}>
        <path d="M120 70L0 0M260 70L380 0" /><path className="dr3-axis" d="M190 70V0" />
      </svg>
      <div className="dr3-hinge">
        <button key={`plate-${selected}`} className="dr3-plate" style={vars({ '--pop': intro ? '2.05s' : '.25s' })} aria-label={`进入${workbench.title}`} onClick={enter}>
          <span className="c3-frost" /><span className="c3-border" />
          <span className="dr3-plate-head"><b>{SECTION_CODES[selected]}</b><small>ELEVATION {workbench.code}</small><i>×</i></span>
          <span className="dr3-plate-label">{workbench.english}</span>
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
  const rotation = useDial(150 - selected * STEP);
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
          {entryWorkbenches.map((item, index) => <text key={item.id} className="ap-number" data-current={index === selected} x={0} y={-342} textAnchor="middle" transform={`rotate(${index * STEP})`}>{item.code}</text>)}
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
          return <div key={item.id} className="ap3-arm" style={{ transform: `rotateZ(${index * STEP}deg) translateY(-520px)` }}>
            <div className="ap3-token" style={{ transform: `rotateZ(${-index * STEP - rotation}deg)` }}><div className="ap3-bill">
              <button className="ap3-sat" data-current={current} style={vars({ '--i': index })} aria-pressed={current} aria-label={`${item.code} / ${item.title}`} onClick={() => current ? enter() : pick(index)}>
                <Emblem workbench={item} live={false} reduced={reduced} /><span className="ap3-label"><b>{SECTION_CODES[index]}</b>{shortNames[index]}</span>
              </button>
            </div></div>
          </div>;
        })}
      </div>
    </div>
  </>;
}

/* ── 授权双螺旋 ───────────────────────────────────────────────────────────
 * Continues straight out of the opening's authorization ring. The scene's
 * first frame is a replica of that ring at the exact moment the opening hands
 * over (17.7 s), so the cut is invisible. Then the ring tilts back into a
 * horizontal scanner, its core stretches into an axis, and the six satellites
 * become six glass plates: the base pairs of a double helix whose beaded
 * strands wind around the axis. Choosing a department turns the helix like a
 * screw (rotate and travel together) so that plate arrives inside the scanner.
 * Departure: the helix unravels, beads scatter, rungs retract, the other
 * plates fly off, and the chosen plate comes forward for the handoff. */
const HELIX = { pitch: 330, radius: 470, turn: 60 };
const bootArc = (r: number, start: number, sweep: number, x = 0, y = 0) => {
  const point = (a: number) => `${(x + Math.cos(a) * r).toFixed(2)},${(y + Math.sin(a) * r).toFixed(2)}`;
  if (sweep >= Math.PI * 1.999) return `M${point(start)}A${r},${r} 0 1 1 ${point(start + Math.PI)}A${r},${r} 0 1 1 ${point(start + Math.PI * 2)}`;
  return `M${point(start)}A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(start + sweep)}`;
};
// The opening's ring at 17.7 s (reference/boot-motion), relative to its centre.
const SEED = {
  outer: 246.25, white: 224.22, inner: 88.59, innerStart: 3.516, innerSweep: 2.37, core: 11.29, orbit: 169.16,
  sides: [[-128, 0, 37, 10.41, 5.79], [127, -1, 37, -6.99, 5.89]] as const,
  satellites: [[24.3, 23.9, 4.25], [-9.2, 33.2, 4.25], [-34.1, 8.8, 4.23], [-25.3, -24.9, 4.12], [8.2, -34.2, 3.86], [33.1, -9.8, 3.31]] as const,
};
/** The opening's ring at the hand-over frame; each scene then transforms it. */
function SeedRing({ satellite }: { satellite?: (index: number) => CSSProperties }) {
  return <svg className="hx-seed" viewBox="-600 -600 1200 1200" aria-hidden="true">
    <g className="hx-seed-ring">
      <path className="hx-seed-outer" d={bootArc(SEED.outer, -1.5697, Math.PI * 2)} />
      <path className="hx-seed-white" d={bootArc(SEED.white, 4.7119, Math.PI * 2)} />
      <g className="hx-seed-scale">{Array.from({ length: 72 }, (_, index) => { const a = index * Math.PI / 36, r1 = SEED.outer + 10, r2 = SEED.outer + (index % 6 ? 18 : 30); return <line key={index} x1={Math.cos(a) * r1} y1={Math.sin(a) * r1} x2={Math.cos(a) * r2} y2={Math.sin(a) * r2} />; })}</g>
      {[1, -1].map(side => <circle key={side} className="hx-seed-orbit" cx={0} cy={side * SEED.orbit} r={8} />)}
    </g>
    <g className="hx-seed-detail">
      <path d={bootArc(SEED.inner, SEED.innerStart, SEED.innerSweep)} /><path d={bootArc(SEED.inner, SEED.innerStart + Math.PI, SEED.innerSweep)} />
      {SEED.sides.map(([x, y, r, start, sweep]) => <path key={x} d={bootArc(r, start, sweep, x, y)} />)}
    </g>
    <circle className="hx-seed-core" cx={-.5} cy={-.5} r={SEED.core} />
    {SEED.satellites.map(([x, y, r], index) => <circle key={index} className="hx-seed-satellite" style={vars({ '--i': index, ...(satellite?.(index) as Record<string, string | number> | undefined) })} cx={x} cy={y} r={r} />)}
  </svg>;
}
const BEADS = Array.from({ length: 50 }, (_, index) => -144 + index * 12);
function HelixFace({ workbench, index, emblem }: { workbench: EntryWorkbench; index: number; emblem: ReactNode }) {
  return <>
    <span className="c3-frost" /><span className="c3-border" /><span className="c3-slot" />
    <span className="c3-screw c3-screw-a" /><span className="c3-screw c3-screw-b" />
    <span className="c3-etch">RHINE LAB<small>GENOME INDEX</small></span>
    <span className="hx-seal">{emblem}</span>
    <span className="hx-title"><b>{workbench.code}</b>{workbench.title}<small>{workbench.english}</small></span>
    <span className="co-scan"><i /><i /></span>
    <span className="co-tag">CLEARANCE:<b>AUTHORIZED</b></span>
    <span className="hx-serial">{fileCode(index)}</span>
    <span className="co-sweep" /><span className="co-dim" />
  </>;
}
function HelixScene({ selected, reduced, logoDelay, pick, enter }: SceneProps) {
  const lift = selected * HELIX.pitch;
  const fade = (y: number) => Math.max(0, Math.min(1, 1.25 - Math.abs(y - lift) / (HELIX.pitch * 2.3))).toFixed(3);
  return <div className="hx-root" style={vars({ '--hx-spin': `${-selected * HELIX.turn}deg`, '--hx-lift': `${-lift}px` })}>
    <SeedRing />
    <i className="hx-axis" />
    <i key={`pulse-${selected}`} className="hx-pulse" />
    <div className="hx-helix">
      {BEADS.flatMap(a => [0, 180].map(offset => {
        const y = a / HELIX.turn * HELIX.pitch, phi = a + 90 + offset;
        const node = a % HELIX.turn === 0 && a >= 0 && a <= (N - 1) * HELIX.turn;
        return <i key={`${a}:${offset}`} className={`hx-bead ${offset ? 'hx-bead-b' : ''} ${node ? 'hx-node' : ''}`}
          style={vars({ transform: `translateY(${y}px) rotateY(${phi}deg) translateZ(calc(${HELIX.radius}px + var(--hx-burst))) rotateY(${-phi}deg) rotateY(calc((var(--hx-spin) + var(--hx-wind)) * -1)) var(--bill)`, opacity: fade(y), '--r': Math.abs(y - lift) / HELIX.pitch })} />;
      }))}
      {entryWorkbenches.map((workbench, index) => {
        const current = index === selected, y = index * HELIX.pitch;
        return <div key={workbench.id} className="hx-rung" style={vars({ transform: `translateY(${y}px) rotateY(${index * HELIX.turn}deg)`, '--d': Math.abs(index - selected), '--side': index < selected ? -1 : 1 })}>
          <i className="hx-bar" style={{ opacity: fade(y) }} />
          <div className="hx-fly"><div className="co-item hx-tile" data-current={current}>
            <div className="co-lift"><div className="hx-grow">
              <Slab w={300} h={300} d={24} className="c3-glass"
                front={<HelixFace workbench={workbench} index={index} emblem={<Emblem workbench={workbench} live={current} reduced={reduced} wait={logoDelay(index)} source={current} />} />}>
                <button className="rk-hit" tabIndex={current ? 0 : -1} aria-label={current ? `进入${workbench.title}` : `选择${workbench.title}`} onClick={() => current ? enter() : pick(index)} />
              </Slab>
            </div></div>
          </div></div>
        </div>;
      })}
    </div>
  </div>;
}

/* ═══ 第五轮：量子涨落 · 莫比乌斯环 · 分形与群 · 混沌吸引子 · 晶带轴 ═══════
 * All five continue out of the opening's authorization ring (SeedRing) like the
 * double helix, and all end with the chosen logo facing the viewer for the
 * seal handoff. Styles live in ceremony-math.css. */

/** Deterministic random numbers, so every take lays out the same way. */
function seeded(seed: number) {
  let value = seed;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Keeps an angle continuous: each change takes the shortest way round. */
function useNearest(target: number, period = 360) {
  const previous = useRef(target);
  return useMemo(() => {
    const delta = ((target - previous.current) % period + period * 1.5) % period - period / 2;
    previous.current += delta;
    return previous.current;
  }, [target, period]);
}

/* ── 量子涨落 ─────────────────────────────────────────────────────────────
 * The vacuum is never empty. The ring lies down into a floor of points that
 * flicker with zero-point fluctuation while virtual pairs appear and
 * annihilate. The six departments hover above it as unobserved wave packets:
 * a probability cloud with a blurred, jittering logo. A measurement beam
 * falls on the chosen one and it collapses into a sharp glass lens, sending a
 * ripple through the field. Departure: the field decoheres, the other packets
 * dissolve and the observed state comes forward. */
const QF = { radius: 540, floor: 250, half: 1200, step: 50 };
const SPARKS = (() => { const r = seeded(7); return Array.from({ length: 18 }, () => { const a = r() * Math.PI * 2, d = 160 + r() * 900; return { x: Math.cos(a) * d, z: Math.sin(a) * d, delay: r() * 4, dur: 2.2 + r() * 2.4 }; }); })();
function VacuumField({ phase, selected, reduced }: { phase: Phase; selected: number; reduced: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ phase, now: -1, ripples: [] as number[], leaving: -1 });
  live.current.phase = phase;
  useEffect(() => {
    const state = live.current;
    if (state.now >= 0) state.ripples.push(state.now + .3);
  }, [selected]);
  useEffect(() => {
    const element = canvas.current, context = element?.getContext('2d');
    if (!element || !context) return;
    const state = live.current, count = QF.half * 2 / QF.step + 1, random = seeded(11);
    const jitter = Float32Array.from({ length: count * count }, () => random());
    const pairs: { x: number; z: number; at: number; angle: number }[] = [];
    let start = -1, lastPair = 0, frame = 0;
    const draw = (time: number) => {
      if (start < 0) { start = time; state.ripples.push(reduced ? -10 : 2.45); }
      const t = reduced ? 9 : (time - start) / 1000;
      state.now = t;
      if (state.phase === 'leaving' && state.leaving < 0) { state.leaving = t; state.ripples.push(t); }
      const fade = state.leaving >= 0 ? Math.max(0, 1 - (t - state.leaving) / .95) : 1;
      const reveal = reduced ? 1e9 : (t - .5) * 1150;
      state.ripples = state.ripples.filter(at => t - at < 3.2);
      context.clearRect(0, 0, element.width, element.height);
      for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
        const x = i * QF.step - QF.half, z = j * QF.step - QF.half, d = Math.hypot(x, z);
        if (d > reveal || d > QF.half) continue;
        const n = jitter[i * count + j];
        const flicker = .5 + .5 * Math.sin(t * (1.2 + n * 2.6) + n * 60);
        const swell = .55 + .45 * Math.sin(x * .008 + t * .8 + Math.sin(z * .011 - t * .6) * 1.6);
        let ripple = 0;
        for (const at of state.ripples) {
          const age = t - at; if (age < 0) continue;
          const dr = Math.hypot(x, z - QF.radius);
          ripple += Math.exp(-(((dr - age * 820) / 75) ** 2)) * Math.exp(-age * 1.05);
        }
        const born = Math.min(1, (reveal - d) / 260), edge = Math.min(1, (QF.half - d) / 420);
        const v = flicker * swell;
        context.globalAlpha = Math.min(1, (.14 + .5 * v + ripple * .85) * edge * born * fade);
        context.fillStyle = ripple > .3 ? '#a68b58' : '#2f3826';
        context.beginPath(); context.arc(600 + x / 2, 600 + z / 2, .9 + 1.7 * v + ripple * 3.2, 0, Math.PI * 2); context.fill();
      }
      // Virtual pairs: born together, drift apart, meet again and annihilate.
      if (!reduced && t > 1.3 && fade > 0 && t - lastPair > .14) {
        lastPair = t;
        const a = Math.random() * Math.PI * 2, r = 120 + Math.random() * 900;
        pairs.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, at: t, angle: Math.random() * Math.PI });
      }
      for (let k = pairs.length - 1; k >= 0; k--) {
        const pair = pairs[k], p = (t - pair.at) / 1.1;
        if (p >= 1) { pairs.splice(k, 1); continue; }
        const cx = 600 + pair.x / 2, cy = 600 + pair.z / 2, sep = Math.sin(Math.PI * Math.min(p / .82, 1)) * 13;
        const dx = Math.cos(pair.angle) * sep, dy = Math.sin(pair.angle) * sep;
        if (p < .82) {
          context.globalAlpha = .85 * fade;
          context.fillStyle = '#a68b58'; context.beginPath(); context.arc(cx + dx, cy + dy, 2.6, 0, Math.PI * 2); context.fill();
          context.fillStyle = '#2f3826'; context.beginPath(); context.arc(cx - dx, cy - dy, 2.6, 0, Math.PI * 2); context.fill();
        } else {
          const q = (p - .82) / .18;
          context.globalAlpha = (1 - q) * fade; context.strokeStyle = '#a68b58'; context.lineWidth = 1.4;
          context.beginPath(); context.arc(cx, cy, 2 + q * 16, 0, Math.PI * 2); context.stroke();
        }
      }
      context.globalAlpha = 1;
      if (!reduced) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [reduced]);
  return <canvas ref={canvas} className="qf-field" width={1200} height={1200} aria-hidden="true" />;
}
function QuantumScene({ selected, phase, reduced, logoDelay, pick, enter }: SceneProps) {
  const rotation = useNearest(-selected * STEP);
  return <div className="qf-root" style={vars({ '--qf-rot': `${rotation}deg` })}>
    <div className="qf-floor"><VacuumField phase={phase} selected={selected} reduced={reduced} /></div>
    <SeedRing />
    {SPARKS.map((spark, index) => <i key={index} className="qf-spark" style={vars({ '--x': `${spark.x.toFixed(0)}px`, '--z': `${spark.z.toFixed(0)}px`, '--delay': `${spark.delay.toFixed(2)}s`, '--dur': `${spark.dur.toFixed(2)}s` })} />)}
    <i key={`beam-${selected}`} className="qf-beam" />
    {entryWorkbenches.map((workbench, index) => {
      const current = index === selected;
      return <div key={workbench.id} className="qf-orbit" data-current={current} style={vars({ '--a': `${index * STEP}deg`, '--i': index })}>
        <div className="qf-packet"><div className="qf-lift">
          <button className="qf-hit" aria-pressed={current} aria-label={current ? `进入${workbench.title}` : `观测${workbench.title}`} onClick={() => current ? enter() : pick(index)}>
            <span className="qf-cloud"><i /><i /><i /><span className="qf-ghost"><Emblem workbench={workbench} live={false} reduced={reduced} /></span></span>
            <span className="qf-lens"><i className="qf-ticks" /><Emblem workbench={workbench} live={current} reduced={reduced} wait={logoDelay(index)} source={current} /></span>
            <span className="qf-label"><b>{SECTION_CODES[index]}</b>{current ? `|${shortNames[index]}⟩ · OBSERVED` : `|ψ${index + 1}⟩ · ${shortNames[index]}`}</span>
          </button>
        </div></div>
      </div>;
    })}
  </div>;
}

/* ── 莫比乌斯环 ───────────────────────────────────────────────────────────
 * The Rhine Lab ∞ as an object: a figure-eight ribbon with a half twist (a
 * Möbius band), woven from fine strands. It is drawn on a 2D canvas with its
 * own perspective projection — no WebGL — sorted back to front so the two
 * lobes pass over and under each other, with the far side softened like a
 * shallow depth of field. The cards and labels are DOM, placed every frame
 * from the same projection, so they stay pinned to the ribbon.
 * Opening: the canvas takes over the opening's white ring exactly, pinches it
 * into a figure eight, widens it into a ribbon and twists it. Choosing a
 * section flies the camera along the ribbon to that section and frames it
 * close, a gold pulse running the strands. Departure: the strands unravel and
 * scatter, the chosen card comes forward for the handoff. */
type Vec3 = [number, number, number];
const MB = { a: 600, lift: 200, width: 200, logo: 62, bulge: 0, strands: 60, steps: 300, focal: 1400 };
// The sections sit along the loop, spread evenly over the two lobes and kept
// away from the crossing at t = π/2 and 3π/2.
const MB_T = (() => {
  const gap = .5, span = Math.PI - 2 * gap, first = Math.ceil(N / 2), second = N - first;
  const lobe = (from: number, n: number) => Array.from({ length: n }, (_, k) => from + (k + .5) / n * span);
  return [...lobe(-Math.PI / 2 + gap, first), ...lobe(Math.PI / 2 + gap, second)].map(t => (t + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
})();
const MB_LIGHT: Vec3 = (() => { const v: Vec3 = [-.45, -.62, .64]; const n = Math.hypot(...v); return v.map(x => x / n) as Vec3; })();
function mbCentre(t: number, morph: number): Vec3 {
  const s = Math.sin(t), c = Math.cos(t), d = 1 + s * s;
  const lx = MB.a * c / d, ly = MB.a * s * c / d * .92, lz = MB.lift * s;
  const cx = 224.2 * c, cy = 224.2 * s;
  return [cx + (lx - cx) * morph, cy + (ly - cy) * morph, lz * morph];
}
/** Ribbon frame at t: centre, across-direction and surface normal. */
function mbFrame(t: number, morph: number, twist: number) {
  const p = mbCentre(t, morph), q = mbCentre(t + .002, morph);
  let tx = q[0] - p[0], ty = q[1] - p[1], tz = q[2] - p[2];
  const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  // r = T × Z, u = r × T
  let rx = ty, ry = -tx, rz = 0; const rl = Math.hypot(rx, ry) || 1; rx /= rl; ry /= rl;
  const ux = ry * tz - rz * ty, uy = rz * tx - rx * tz, uz = rx * ty - ry * tx;
  const phi = (t / 2 + Math.PI / 2) * twist, cp = Math.cos(phi), sp = Math.sin(phi);
  const across: Vec3 = [rx * cp + ux * sp, ry * cp + uy * sp, rz * cp + uz * sp];
  const normal: Vec3 = [-rx * sp + ux * cp, -ry * sp + uy * cp, -rz * sp + uz * cp];
  return { p, across, normal };
}
type Camera = { yaw: number; pitch: number; dist: number; tx: number; ty: number; tz: number; ox: number; oy: number };
const MB_REST: Camera = { yaw: 0, pitch: 0, dist: MB.focal, tx: 0, ty: 0, tz: 0, ox: 0, oy: 0 };
function mbShot(index: number): Camera {
  const { p, across } = mbFrame(MB_T[index], 1, 1);
  const edge: Vec3 = [p[0] + across[0] * MB.width * .5, p[1] + across[1] * MB.width * .5, p[2] + across[2] * MB.width * .5];
  // Keep the whole ∞ in frame, leaning toward the chosen section.
  const w = .38;
  return { yaw: -p[0] / MB.a * .3, pitch: -.42, dist: 1500, tx: edge[0] * w, ty: edge[1] * w, tz: edge[2] * w, ox: -150, oy: 40 };
}
function project(point: Vec3, cam: Camera) {
  let x = point[0] - cam.tx, y = point[1] - cam.ty, z = point[2] - cam.tz;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  [y, z] = [y * cp - z * sp, y * sp + z * cp];
  const depth = Math.max(80, cam.dist - z), scale = MB.focal / depth;
  return { x: 960 + cam.ox + x * scale, y: 540 + cam.oy + y * scale, depth, scale };
}
const ease3 = (x: number) => x <= 0 ? 0 : x >= 1 ? 1 : x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
/** The section card shared by the canvas scenes (莫比乌斯环, 混沌吸引子). */
function SectionFace({ workbench, index, emblem, note }: { workbench: EntryWorkbench; index: number; emblem: ReactNode; note: string }) {
  return <>
    <span className="mb-card-head"><b>{SECTION_CODES[index]}</b><small>SECTION {workbench.code}</small><i>×</i></span>
    <span className="mb-seal">{emblem}</span>
    <span className="mb-title"><b>{workbench.code}</b>{workbench.title}</span>
    <span className="mb-serial">{fileCode(index)} · {note}</span>
    <span className="co-sweep" />
  </>;
}
function MobiusScene({ selected, phase, reduced, logoDelay, pick, enter }: SceneProps) {
  const host = useRef<HTMLDivElement>(null), back = useRef<HTMLCanvasElement>(null), front = useRef<HTMLCanvasElement>(null);
  const links = useRef<SVGSVGElement>(null), nodes = useRef<(HTMLButtonElement | null)[]>([]), card = useRef<HTMLDivElement>(null);
  const live = useRef({ selected, phase, reduced });
  live.current = { selected, phase, reduced };
  useEffect(() => {
    const element = host.current, a = back.current?.getContext('2d'), b = front.current?.getContext('2d');
    if (!element || !a || !b || !back.current || !front.current) return;
    const random = seeded(31);
    const scatter = Array.from({ length: MB.strands }, () => [random() - .5, random() - .5, random() - .5].map(v => v * 1800));
    const world = element.closest('.c3-world') as HTMLElement | null;
    let cam: Camera = { ...MB_REST }, start = -1, last = -1, leaving = -1, frame = 0, ratio = 0, cached = '';
    let points = new Float32Array(0), shade = new Float32Array(0);
    const build = (morph: number, width: number, twist: number) => {
      const key = `${morph.toFixed(3)}:${width.toFixed(1)}:${twist.toFixed(3)}`;
      if (key === cached) return; cached = key;
      points = new Float32Array(MB.strands * (MB.steps + 1) * 3); shade = new Float32Array(MB.strands * (MB.steps + 1));
      for (let j = 0; j <= MB.steps; j++) {
        const { p, across, normal } = mbFrame(j / MB.steps * Math.PI * 2, morph, twist);
        const light = Math.abs(normal[0] * MB_LIGHT[0] + normal[1] * MB_LIGHT[1] + normal[2] * MB_LIGHT[2]);
        for (let i = 0; i < MB.strands; i++) {
          const s = i / (MB.strands - 1) * 2 - 1, w = width / 2, bulge = MB.bulge * (width / MB.width) * (1 - s * s);
          const o = (i * (MB.steps + 1) + j) * 3;
          points[o] = p[0] + across[0] * s * w + normal[0] * bulge;
          points[o + 1] = p[1] + across[1] * s * w + normal[1] * bulge;
          points[o + 2] = p[2] + across[2] * s * w + normal[2] * bulge;
          // Rounded profile: strands toward the edges turn away from the light.
          shade[i * (MB.steps + 1) + j] = Math.min(1, light * (1 - .45 * s * s) + .18);
        }
      }
    };
    const chunk = 8;
    const draw = (now: number) => {
      const { selected: current, phase: stage, reduced: still } = live.current;
      if (start < 0) start = now;
      const t = still ? 99 : (now - start) / 1000, dt = last < 0 ? 0 : Math.min(.05, (now - last) / 1000); last = now;
      const box = element.getBoundingClientRect(), want = Math.max(1, Math.min(1.5, box.width * (window.devicePixelRatio || 1) / 1920)); // 1.5× 已足够清晰，像素量比 2× 少 44%
      if (Math.abs(want - ratio) > .05) { ratio = want; for (const c of [back.current!, front.current!]) { c.width = Math.round(1920 * ratio); c.height = Math.round(1080 * ratio); } }
      // Opening: the ring gives way to a small black square, which leads a
      // heavy stroke round the ∞ (the flat mark); the mark then greys out as
      // the strand ribbon sweeps along it, widens and twists into 3D.
      const morph = 1, width = MB.logo + (MB.width - MB.logo) * ease3((t - 2.25) / .85), twist = ease3((t - 2.35) / 1.05);
      const sweep = still ? 1 : ease3((t - 1.85) / 1.05);
      build(morph, width, twist);
      // Camera: rest on the ring, then fly to the chosen section; parallax from the pointer.
      const goal = t < 2.35 ? MB_REST : mbShot(current);
      const k = 1 - Math.exp(-dt * (t < 3.2 ? 2.2 : 3.4));
      const yawGoal = cam.yaw + (((goal.yaw - cam.yaw) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      cam = { yaw: cam.yaw + (yawGoal - cam.yaw) * k, pitch: cam.pitch + (goal.pitch - cam.pitch) * k, dist: cam.dist + (goal.dist - cam.dist) * k, tx: cam.tx + (goal.tx - cam.tx) * k, ty: cam.ty + (goal.ty - cam.ty) * k, tz: cam.tz + (goal.tz - cam.tz) * k, ox: cam.ox + (goal.ox - cam.ox) * k, oy: cam.oy + (goal.oy - cam.oy) * k };
      if (still) cam = mbShot(current);
      const px = parseFloat(world?.style.getPropertyValue('--px') || '0') || 0, py = parseFloat(world?.style.getPropertyValue('--py') || '0') || 0;
      const view: Camera = { ...cam, yaw: cam.yaw + px * .05 + Math.sin(t * .23) * .025, pitch: cam.pitch + py * .035 };
      if (stage === 'leaving' && leaving < 0) leaving = t;
      const q = leaving < 0 ? 0 : ease3((t - leaving) / 1.05);
      // Project, cut each strand into chunks, sort far to near.
      const count = MB.steps + 1, projected = new Float32Array(MB.strands * count * 3);
      for (let i = 0; i < MB.strands; i++) {
        const sx = scatter[i][0] * q, sy = scatter[i][1] * q, sz = scatter[i][2] * q;
        for (let j = 0; j < count; j++) {
          const o = (i * count + j) * 3, r = project([points[o] + sx, points[o + 1] + sy, points[o + 2] + sz], view);
          projected[o] = r.x; projected[o + 1] = r.y; projected[o + 2] = r.depth;
        }
      }
      // Draw the ribbon in short sections along its length, far to near: each
      // section is an opaque paper fill with its strands on top, so the lobes
      // occlude each other where the figure eight crosses.
      const pieces: { j: number; depth: number }[] = [];
      for (let j = 0; j < MB.steps; j += chunk) {
        const mid = Math.min(MB.steps, j + chunk / 2), centre = (MB.strands >> 1) * count + mid;
        pieces.push({ j, depth: projected[centre * 3 + 2] });
      }
      pieces.sort((x, y) => y.depth - x.depth);
      for (const c of [a, b]) { c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, 1920, 1080); c.lineCap = 'round'; c.lineJoin = 'round'; }
      const focus = view.dist, appear = 1 - q;
      if (!still && t < 2.6) {
        // The flat mark: square head, heavy stroke, cross bar; greys out under the ribbon.
        const draw = ease3((t - .78) / .82), fade = t < 1.9 ? 1 : Math.max(0, 1 - (t - 1.9) / .7);
        const tone = Math.round(29 + (196 - 29) * Math.min(1, Math.max(0, (t - 1.75) / .5)));
        const ink = (alpha: number) => `rgba(${tone},${tone + 4},${tone - 3},${(alpha * fade).toFixed(3)})`;
        const span = Math.PI * 2 - .62, start = Math.PI / 2;
        const at = (u: number) => project(mbCentre(u, 1), view);
        if (t >= .32 && t < .8) {
          const k2 = ease3((t - .32) / .46), c = at(start), size = MB.logo * k2;
          b.save(); b.translate(c.x, c.y); b.rotate(Math.PI / 4 + (1 - k2) * Math.PI); b.fillStyle = ink(1); b.fillRect(-size / 2, -size / 2, size, size); b.restore();
        }
        if (draw > 0) {
          const head = start + span * draw;
          b.lineCap = 'butt'; b.lineJoin = 'round'; b.strokeStyle = ink(1); b.lineWidth = MB.logo * at(start).scale;
          b.beginPath();
          for (let u = start; u <= head; u += .015) { const r = at(u); if (u === start) b.moveTo(r.x, r.y); else b.lineTo(r.x, r.y); }
          const h = at(head); b.lineTo(h.x, h.y); b.stroke();
          if (draw > .48) {
            const c = at(start), len = 74 * Math.min(1, (draw - .48) / .2);
            b.lineWidth = MB.logo * .62; b.beginPath(); b.moveTo(c.x - len * .55, c.y + len * .55); b.lineTo(c.x + len * .55, c.y - len * .55); b.stroke();
          }
          if (draw < 1) {
            // The square head, smeared a little along its path.
            const p2 = at(head + .02), angle = Math.atan2(p2.y - h.y, p2.x - h.x), size = MB.logo * h.scale;
            for (let g = 3; g >= 0; g--) {
              const back = at(head - g * .035);
              b.save(); b.translate(back.x, back.y); b.rotate(angle); b.fillStyle = ink(g ? .16 : 1); b.fillRect(-size / 2, -size / 2, size, size); b.restore();
            }
          }
          b.lineCap = 'round';
        }
      }
      const pulse = (t * .5) % 1, end = (j: number) => Math.min(MB.steps, j + chunk);
      for (const { j, depth } of pieces) {
        const mid = Math.min(MB.steps, j + chunk / 2);
        // During the opening the ribbon sweeps in along the mark, from the crossing.
        if (sweep < 1 && ((mid / MB.steps * Math.PI * 2 - Math.PI / 2 + Math.PI * 4) % (Math.PI * 2)) / (Math.PI * 2) > sweep) continue;
        const ctx = depth > focus + 330 ? a : b, fog = Math.max(.35, Math.min(1, 1.4 - (depth - focus) / 1300));
        if (width > 8 && q < .2) {
          // Paper fill between the two edge strands.
          const light = shade[(MB.strands >> 1) * count + mid], tone = Math.round(198 + 54 * light);
          ctx.fillStyle = ctx.strokeStyle = `rgba(${tone},${tone - 1},${tone - 8},${appear.toFixed(3)})`; ctx.lineWidth = 1;
          ctx.beginPath();
          for (let s2 = j; s2 <= end(j); s2++) { const o = s2 * 3; if (s2 === j) ctx.moveTo(projected[o], projected[o + 1]); else ctx.lineTo(projected[o], projected[o + 1]); }
          for (let s2 = end(j); s2 >= j; s2--) { const o = ((MB.strands - 1) * count + s2) * 3; ctx.lineTo(projected[o], projected[o + 1]); }
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        const along = mid / MB.steps, glow = Math.max(0, 1 - Math.abs(((along - pulse + 1.5) % 1) - .5) * 12);
        for (let i = 0; i < MB.strands; i++) {
          const edge = i === 0 || i === MB.strands - 1, light = shade[i * count + mid];
          if (edge) { ctx.strokeStyle = `rgba(29,33,26,${(.9 * fog * appear).toFixed(3)})`; ctx.lineWidth = 1.6; }
          else if (glow > .04 && i % 6 === 3) { ctx.strokeStyle = `rgba(166,139,88,${(glow * .9 * appear).toFixed(3)})`; ctx.lineWidth = 1.1; }
          else { const tone = Math.round(48 + 150 * light); ctx.strokeStyle = `rgba(${tone},${tone + 3},${tone - 8},${((i % 3 ? .5 : .85) * fog * appear).toFixed(3)})`; ctx.lineWidth = i % 3 ? .6 : .85; }
          ctx.beginPath();
          for (let s2 = j; s2 <= end(j); s2++) { const o = (i * count + s2) * 3; if (s2 === j) ctx.moveTo(projected[o], projected[o + 1]); else ctx.lineTo(projected[o], projected[o + 1]); }
          ctx.stroke();
        }
      }
      // Section markers and the chosen card's leader line.
      const svg = links.current;
      let anchor = { x: 0, y: 0 };
      MB_T.forEach((tt, index) => {
        const { p, across } = mbFrame(tt, morph, twist), w = width / 2;
        const r = project([p[0] + across[0] * w + scatter[0][0] * q, p[1] + across[1] * w + scatter[0][1] * q, p[2] + across[2] * w], view);
        if (index === current) anchor = r;
        const node = nodes.current[index];
        if (node) { node.style.transform = `translate(${r.x.toFixed(1)}px,${r.y.toFixed(1)}px)`; node.style.opacity = String(Math.min(1, Math.max(0, (t - 3.1) / .5)) * (1 - q) * Math.max(.35, Math.min(1, 1.5 - (r.depth - focus) / 900))); }
      });
      if (svg) {
        const line = svg.firstElementChild as SVGPolylineElement | null, cardBox = card.current;
        if (line && cardBox) {
          const cx = cardBox.offsetLeft, cy = cardBox.offsetTop;
          line.setAttribute('points', `${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} ${(cx - 40).toFixed(1)},${(cy + 40).toFixed(1)} ${cx},${cy + 40}`);
          line.style.opacity = String(Math.min(1, Math.max(0, (t - 3.3) / .5)) * (1 - q));
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  const workbench = entryWorkbenches[selected];
  return <div className="mb-root">
    <SeedRing />
    <div ref={host} className="mb-stage">
      <canvas ref={back} className="mb-back" aria-hidden="true" />
      <canvas ref={front} className="mb-front" aria-hidden="true" />
      <svg ref={links} className="mb-links" viewBox="0 0 1920 1080" aria-hidden="true"><polyline points="0,0 0,0" /></svg>
      {entryWorkbenches.map((item, index) => <button key={item.id} ref={element => { nodes.current[index] = element; }} className="mb-node" aria-pressed={index === selected} aria-label={index === selected ? `进入${item.title}` : `选择${item.title}`} onClick={() => index === selected ? enter() : pick(index)}>
        <i /><b>{SECTION_CODES[index]}</b><span>{shortNames[index]}</span>
      </button>)}
      <div ref={card} className="mb-card co-item" data-current="true">
        <div className="mb-card-in" key={selected}>
          <SectionFace workbench={workbench} index={selected} note="ONE SIDE · ONE EDGE" emblem={<Emblem workbench={workbench} live reduced={reduced} wait={logoDelay(selected) || 350} source />} />
          <button className="mb-hit" aria-label={`进入${workbench.title}`} onClick={enter} />
        </div>
      </div>
    </div>
  </div>;
}

/* ── 分形与群 ─────────────────────────────────────────────────────────────
 * A hexaflake: the ring lies down as its circumcircle, the parent hexagon and
 * its seven children draw themselves, then forty-nine plates pop up, each
 * carrying two further levels of the same figure. The six outer children are
 * the departments. Switching is a group action of D6, the symmetry group of
 * the hexagon: a neighbour is reached by rotation r^k, the opposite one by the
 * reflection s — the flake folds flat along the mirror line and opens again
 * mirrored. Departure: a zoom into the chosen child, which grows to the size
 * of the whole (self-similarity), while its standard comes forward. */
const FG = { parent: 600, child: 400, plate: 400 / 3 };
const SUPERSCRIPT = ['⁰', '¹', '²', '³', '⁴', '⁵'];
const hexPoints = (r: number) => Array.from({ length: 6 }, (_, k) => {
  const a = (90 + k * 60) * Math.PI / 180;
  return `${(Math.cos(a) * r).toFixed(3)},${(Math.sin(a) * r).toFixed(3)}`;
}).join(' ');
const HEX_DIRS = Array.from({ length: 6 }, (_, k) => (90 + k * 60) * Math.PI / 180);
const FG_CHILDREN: [number, number][] = [[0, 0], ...HEX_DIRS.map(a => [Math.cos(a) * FG.child, Math.sin(a) * FG.child] as [number, number])];
const FG_PLATES = FG_CHILDREN.flatMap(([cx, cz], child) => ([[0, 0], ...HEX_DIRS.map(a => [Math.cos(a) * FG.plate, Math.sin(a) * FG.plate])] as [number, number][])
  .map(([gx, gz], grand) => ({ x: cx + gx, z: cz + gz, cluster: child - 1, centre: grand === 0, r: Math.hypot(cx + gx, cz + gz) / FG.parent })));
// With a seventh section, it takes the centre child: the one place D6 leaves fixed.
const FG_CENTRE = N > 6 ? 6 : -1;
const fgCluster = (index: number) => index === FG_CENTRE ? -1 : index;
function useGroupAction(selected: number) {
  const state = useRef({ selected, theta: (selected === FG_CENTRE ? 0 : selected) * 60, f: 1 });
  return useMemo(() => {
    const current = state.current;
    if (selected === FG_CENTRE) current.selected = selected;
    else if (current.selected !== selected) {
      if (current.selected !== FG_CENTRE && modulo(selected - current.selected, 6) === 3) current.f *= -1;
      else {
        const target = selected * 60 + (current.f < 0 ? 180 : 0);
        current.theta += ((target - current.theta) % 360 + 540) % 360 - 180;
      }
      current.selected = selected;
    }
    const k = modulo(Math.round(current.theta / 60), 6);
    const element = current.f > 0 ? (k ? `r${SUPERSCRIPT[k]}` : 'e') : (k ? `s·r${SUPERSCRIPT[k]}` : 's');
    return { theta: current.theta, f: current.f, element };
  }, [selected]);
}
type GroupState = ReturnType<typeof useGroupAction>;
function FractalScene({ selected, reduced, logoDelay, pick, enter, group }: SceneProps & { group: GroupState }) {
  return <div className="fg-root" data-centre={selected === FG_CENTRE || undefined} style={vars({ '--fg-rot': `${group.theta}deg`, '--fg-f': group.f })}>
    <svg className="fg-defs" width={0} height={0} aria-hidden="true"><defs>
      <g id="ceremony-fg-flake">
        {([[0, 0], ...HEX_DIRS.map(a => [Math.cos(a) * 2 / 3, Math.sin(a) * 2 / 3])] as [number, number][]).map(([x, y], index) =>
          <g key={index} transform={`translate(${x.toFixed(4)} ${y.toFixed(4)})`}>
            <polygon points={hexPoints(.3)} fill="none" stroke="#8f947d" strokeWidth={.8} vectorEffect="non-scaling-stroke" />
            {([[0, 0], ...HEX_DIRS.map(a => [Math.cos(a) * 2 / 9, Math.sin(a) * 2 / 9])] as [number, number][]).map(([px, py], dot) =>
              <circle key={dot} cx={px.toFixed(4)} cy={py.toFixed(4)} r={.022} fill="#8f947d" />)}
          </g>)}
      </g>
    </defs></svg>
    <SeedRing />
    <div className="fg-zoom"><div className="fg-flake">
      <svg className="fg-chart" viewBox="-720 -720 1440 1440" aria-hidden="true">
        <circle r={652} className="fg-draw fg-circle" pathLength={1} style={vars({ '--delay': '.9s' })} />
        <polygon points={hexPoints(FG.parent)} className="fg-draw fg-parent" pathLength={1} style={vars({ '--delay': '1s' })} />
        {FG_CHILDREN.map(([x, z], index) => <g key={index} transform={`translate(${x.toFixed(1)} ${z.toFixed(1)})`}>
          <polygon points={hexPoints(FG.parent / 3)} className={`fg-draw fg-child ${index - 1 === fgCluster(selected) ? 'fg-child-mine' : ''}`} pathLength={1} style={vars({ '--delay': `${1.2 + index * .06}s` })} />
        </g>)}
        {FG_CHILDREN.slice(1).map(([x, z], index) => <line key={index} x1={0} y1={0} x2={x.toFixed(1)} y2={z.toFixed(1)} className="fg-draw fg-generator" pathLength={1} style={vars({ '--delay': `${1.35 + index * .05}s` })} />)}
      </svg>
      {FG_PLATES.map((plate, index) => {
        const mine = plate.cluster === fgCluster(selected), y = mine ? -46 : plate.centre ? -16 : -6;
        return <div key={index} className="fg-plate" data-mine={mine} data-centre={plate.centre} style={vars({ transform: `translate3d(${plate.x.toFixed(1)}px,${y}px,${plate.z.toFixed(1)}px) rotateX(90deg)`, '--r': plate.r.toFixed(2) })}>
          <svg viewBox="-1.05 -1.05 2.1 2.1"><polygon className="fg-hex" points={hexPoints(.95)} /><use href="#ceremony-fg-flake" transform="scale(.95)" /></svg>
        </div>;
      })}
    </div></div>
    <i className="fg-index" />
    <div className="fg-algebra-anchor"><div className="fg-algebra">D<sub>6</sub> = ⟨ r, s | r⁶ = s² = e, srs = r⁻¹ ⟩<small>|D6| = 12</small></div></div>
    {entryWorkbenches.map((workbench, index) => {
      const current = index === selected;
      return <div key={workbench.id} className="fg-anchor co-item" data-current={current} data-centre={index === FG_CENTRE || undefined} style={vars({ '--phi': `${90 + index * 60}deg`, '--i': index })}>
        <div className="fg-bill"><div className="fg-stand">
          <i className="fg-stem" />
          <button className="fg-token" aria-pressed={current} aria-label={current ? `进入${workbench.title}` : `选择${workbench.title}`} onClick={() => current ? enter() : pick(index)}>
            <svg className="fg-token-frame" viewBox="-1.05 -1.05 2.1 2.1" aria-hidden="true"><polygon points={hexPoints(1)} transform="rotate(-90)" /><polygon points={hexPoints(.9)} transform="rotate(-90)" /></svg>
            <Emblem workbench={workbench} live={current} reduced={reduced} wait={logoDelay(index)} source={current} />
          </button>
          <span className="fg-code"><b>{workbench.code}</b>{shortNames[index]}</span>
        </div></div>
      </div>;
    })}
  </div>;
}

/* ── 混沌吸引子 ───────────────────────────────────────────────────────────
 * The Lorenz system (σ 10, ρ 28, β 8/3), integrated once at load. The ring
 * shrinks into the origin while the trajectory draws itself outward into the
 * two butterfly wings, and a gold tracer keeps running the real orbit. The six
 * departments are states in phase space, labelled with their coordinates.
 * Choosing one flies the camera through phase space to that state while the
 * butterfly stays broadside and turns a little. Departure:
 * sensitive dependence — every point of the trajectory scatters — and the
 * chosen state comes forward. */
const LZ = (() => {
  let x = .1, y = 0, z = 0;
  const dense: [number, number, number][] = [], raw: [number, number, number][] = [];
  for (let i = 0; i < 12000; i++) {
    const dt = .005, dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - 8 / 3 * z;
    x += dx * dt; y += dy * dt; z += dz * dt;
    if (i > 800 && i % 3 === 0) { dense.push([x * 22, -(z - 24) * 17, y * 14]); raw.push([x, y, z]); }
  }
  const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const picks: number[] = [];
  let first = 0;
  dense.forEach((point, i) => { if (point[0] > dense[first][0]) first = i; });
  picks.push(first);
  while (picks.length < N) {
    let best = 0, bestDistance = -1;
    for (let i = 0; i < dense.length; i += 7) {
      const d = Math.min(...picks.map(j => distance(dense[i], dense[j])));
      if (d > bestDistance) { bestDistance = d; best = i; }
    }
    picks.push(best);
  }
  // Order the states around the vertical axis so neighbours are neighbours.
  picks.sort((a, b) => Math.atan2(dense[a][2], dense[a][0]) - Math.atan2(dense[b][2], dense[b][0]));
  const fixed = Math.sqrt(8 / 3 * 27);
  return { dense, raw, states: picks, fixed: [[fixed * 22, -3 * 17, fixed * 14], [-fixed * 22, -3 * 17, -fixed * 14]] as const };
})();
// The trajectory drawn as one long line on canvas, cut into short pieces that
// are sorted far to near; the camera and the DOM labels share one projection.
function lzShot(index: number): Camera {
  const p = LZ.dense[LZ.states[index]], w = .4;
  return { yaw: (index - (N - 1) / 2) * .07, pitch: -.12, dist: 1800, tx: p[0] * w, ty: p[1] * w, tz: p[2] * w, ox: -250, oy: 40 };
}
function LorenzScene({ selected, phase, reduced, logoDelay, pick, enter }: SceneProps) {
  const host = useRef<HTMLDivElement>(null), back = useRef<HTMLCanvasElement>(null), front = useRef<HTMLCanvasElement>(null);
  const links = useRef<SVGSVGElement>(null), nodes = useRef<(HTMLButtonElement | null)[]>([]), card = useRef<HTMLDivElement>(null);
  const live = useRef({ selected, phase, reduced });
  live.current = { selected, phase, reduced };
  useEffect(() => {
    const element = host.current, a = back.current?.getContext('2d'), b = front.current?.getContext('2d');
    if (!element || !a || !b || !back.current || !front.current) return;
    const random = seeded(41), total = LZ.dense.length, piece = 10;
    const scatter = Array.from({ length: Math.ceil(total / piece) }, () => [random() - .5, random() - .5, random() - .5].map(v => v * 2200));
    const world = element.closest('.c3-world') as HTMLElement | null;
    let cam: Camera = { ...MB_REST }, start = -1, last = -1, leaving = -1, frame = 0, ratio = 0;
    const draw = (now: number) => {
      const { selected: current, phase: stage, reduced: still } = live.current;
      if (start < 0) start = now;
      const t = still ? 99 : (now - start) / 1000, dt = last < 0 ? 0 : Math.min(.05, (now - last) / 1000); last = now;
      const box = element.getBoundingClientRect(), want = Math.max(1, Math.min(1.5, box.width * (window.devicePixelRatio || 1) / 1920)); // 1.5× 已足够清晰，像素量比 2× 少 44%
      if (Math.abs(want - ratio) > .05) { ratio = want; for (const c of [back.current!, front.current!]) { c.width = Math.round(1920 * ratio); c.height = Math.round(1080 * ratio); } }
      const goal = t < .7 ? MB_REST : lzShot(current), k = 1 - Math.exp(-dt * (t < 3.2 ? 1.9 : 3));
      cam = { yaw: cam.yaw + (goal.yaw - cam.yaw) * k, pitch: cam.pitch + (goal.pitch - cam.pitch) * k, dist: cam.dist + (goal.dist - cam.dist) * k, tx: cam.tx + (goal.tx - cam.tx) * k, ty: cam.ty + (goal.ty - cam.ty) * k, tz: cam.tz + (goal.tz - cam.tz) * k, ox: cam.ox + (goal.ox - cam.ox) * k, oy: cam.oy + (goal.oy - cam.oy) * k };
      if (still) cam = lzShot(current);
      const px = parseFloat(world?.style.getPropertyValue('--px') || '0') || 0, py = parseFloat(world?.style.getPropertyValue('--py') || '0') || 0;
      const view: Camera = { ...cam, yaw: cam.yaw + px * .06 + Math.sin(t * .2) * .05, pitch: cam.pitch + py * .04 };
      if (stage === 'leaving' && leaving < 0) leaving = t;
      const q = leaving < 0 ? 0 : ease3((t - leaving) / 1.05);
      // The orbit draws itself outward from the origin during the opening.
      const reveal = still ? total : Math.floor(total * ease3((t - .35) / 2.1));
      const xs = new Float32Array(reveal), ys = new Float32Array(reveal), ds = new Float32Array(reveal);
      for (let i = 0; i < reveal; i++) {
        const sc = scatter[Math.floor(i / piece)], p = LZ.dense[i];
        const r = project([p[0] + sc[0] * q, p[1] + sc[1] * q, p[2] + sc[2] * q], view);
        xs[i] = r.x; ys[i] = r.y; ds[i] = r.depth;
      }
      const order: number[] = [];
      for (let i = 0; i + 1 < reveal; i += piece) order.push(i);
      order.sort((x, y) => ds[y] - ds[x]);
      for (const c of [a, b]) { c.setTransform(ratio, 0, 0, ratio, 0, 0); c.clearRect(0, 0, 1920, 1080); c.lineCap = 'round'; c.lineJoin = 'round'; }
      const focus = view.dist, fade = 1 - q;
      for (const i of order) {
        const far = ds[i] > focus + 280, ctx = far ? a : b, near = Math.max(.18, Math.min(1, 1.45 - (ds[i] - focus) / 1100));
        const age = (reveal - i) / total;
        ctx.strokeStyle = `rgba(29,33,26,${(near * (.32 + .5 * Math.min(1, age * 6)) * fade).toFixed(3)})`;
        ctx.lineWidth = Math.max(.5, 1.1 * MB.focal / ds[i] * .8);
        ctx.beginPath(); ctx.moveTo(xs[i], ys[i]);
        for (let s2 = i + 1; s2 <= Math.min(reveal - 1, i + piece); s2++) ctx.lineTo(xs[s2], ys[s2]);
        ctx.stroke();
      }
      // A gold tracer keeps running the real orbit.
      if (reveal > 80) {
        const head = still ? total - 1 : Math.floor((t * 120) % (total - 1));
        for (let s2 = 0; s2 < 70; s2++) {
          const i = head - s2; if (i < 1 || i >= reveal) continue;
          b.strokeStyle = `rgba(166,139,88,${((1 - s2 / 70) * fade).toFixed(3)})`; b.lineWidth = 2.6 * (1 - s2 / 90);
          b.beginPath(); b.moveTo(xs[i - 1], ys[i - 1]); b.lineTo(xs[i], ys[i]); b.stroke();
        }
        if (head < reveal) { b.fillStyle = `rgba(166,139,88,${fade})`; b.beginPath(); b.arc(xs[head], ys[head], 4.5, 0, Math.PI * 2); b.fill(); }
      }
      // Fixed points C+ and C−.
      const show = Math.min(1, Math.max(0, (t - 2) / .6)) * fade;
      LZ.fixed.forEach((point, index) => {
        const r = project(point as unknown as Vec3, view);
        b.strokeStyle = `rgba(166,139,88,${show})`; b.lineWidth = 1.4; b.beginPath(); b.arc(r.x, r.y, 9, 0, Math.PI * 2); b.stroke();
        b.fillStyle = `rgba(166,139,88,${show})`; b.font = 'italic 20px "Times New Roman", serif'; b.fillText(index ? 'C⁻' : 'C⁺', r.x + 14, r.y - 8);
      });
      let anchor = { x: 0, y: 0 };
      LZ.states.forEach((stateIndex, index) => {
        const p = LZ.dense[stateIndex], r = project(p as unknown as Vec3, view);
        if (index === current) anchor = r;
        const node = nodes.current[index];
        if (node) { node.style.transform = `translate(${r.x.toFixed(1)}px,${r.y.toFixed(1)}px)`; node.style.opacity = String(Math.min(1, Math.max(0, (t - 2.2) / .5)) * fade); }
      });
      const line = links.current?.firstElementChild as SVGPolylineElement | null;
      if (line) {
        const cx = card.current?.offsetLeft ?? 1190, cy = (card.current?.offsetTop ?? 330) + 40;
        line.setAttribute('points', `${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} ${cx - 40},${cy} ${cx},${cy}`);
        line.style.opacity = String(Math.min(1, Math.max(0, (t - 2.6) / .5)) * fade);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  const workbench = entryWorkbenches[selected], [rx, ry, rz] = LZ.raw[LZ.states[selected]];
  return <div className="mb-root">
    <SeedRing />
    <div ref={host} className="mb-stage">
      <canvas ref={back} className="mb-back" aria-hidden="true" />
      <canvas ref={front} className="mb-front" aria-hidden="true" />
      <svg ref={links} className="mb-links" viewBox="0 0 1920 1080" aria-hidden="true"><polyline points="0,0 0,0" /></svg>
      {entryWorkbenches.map((item, index) => <button key={item.id} ref={element => { nodes.current[index] = element; }} className="mb-node" aria-pressed={index === selected} aria-label={index === selected ? `进入${item.title}` : `前往${item.title}`} onClick={() => index === selected ? enter() : pick(index)}>
        <i /><b>{SECTION_CODES[index]}</b><span>{shortNames[index]}</span>
      </button>)}
      <div ref={card} className="mb-card co-item" data-current="true">
        <div className="mb-card-in" key={selected}>
          <SectionFace workbench={workbench} index={selected} note={`x ${rx.toFixed(1)} · y ${ry.toFixed(1)} · z ${rz.toFixed(1)}`} emblem={<Emblem workbench={workbench} live reduced={reduced} wait={logoDelay(selected) || 350} source />} />
          <button className="mb-hit" aria-label={`进入${workbench.title}`} onClick={enter} />
        </div>
      </div>
    </div>
  </div>;
}

/* ── 晶带轴 ───────────────────────────────────────────────────────────────
 * A body-centred cubic crystal condenses out of the ring's core and tumbles,
 * looking like a random cloud of atoms — until it settles onto a zone axis and
 * every atom lines up into columns. The ring stays where the opening left it,
 * as the goniometer; its six satellites move out to become the six zone axes,
 * one per department. Behind the crystal appears the true electron
 * diffraction pattern of that axis (spots satisfying the zone law and the bcc
 * extinction rule). The department's lens forms in front once aligned.
 * Departure: the lattice bursts outward and the lens comes forward. */
const CR = { cell: 84, cells: 4, ring: 385, scale: 1.36 };
const ZONES: [number, number, number][] = [[0, 0, 1], [1, 1, 1], [0, 1, 1], [0, 1, 2], [1, 1, 3], [1, 0, 2], [1, 2, 3]];
const CR_ATOMS = (() => {
  const atoms: { p: [number, number, number]; body: boolean }[] = [], { cell, cells } = CR, half = cell * cells / 2;
  for (let i = 0; i <= cells; i++) for (let j = 0; j <= cells; j++) for (let k = 0; k <= cells; k++) atoms.push({ p: [i * cell - half, j * cell - half, k * cell - half], body: false });
  for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) for (let k = 0; k < cells; k++) atoms.push({ p: [(i + .5) * cell - half, (j + .5) * cell - half, (k + .5) * cell - half], body: true });
  return atoms;
})();
const zoneAngles = ([u, v, w]: [number, number, number]) => ({
  b: Math.atan2(-u, w) * 180 / Math.PI,
  a: Math.atan2(v, Math.hypot(u, w)) * 180 / Math.PI,
});
function zoneSpots(index: number) {
  const zone = ZONES[index], { a, b } = zoneAngles(zone), ra = a * Math.PI / 180, rb = b * Math.PI / 180, spots: { x: number; y: number; g: number }[] = [];
  for (let h = -5; h <= 5; h++) for (let k = -5; k <= 5; k++) for (let l = -5; l <= 5; l++) {
    if ((h + k + l) % 2 !== 0 || h * zone[0] + k * zone[1] + l * zone[2] !== 0) continue;
    const x1 = h * Math.cos(rb) + l * Math.sin(rb), z1 = -h * Math.sin(rb) + l * Math.cos(rb), y2 = k * Math.cos(ra) - z1 * Math.sin(ra);
    const x = x1 * 74, y = y2 * 74;
    if (Math.hypot(x, y) < 330) spots.push({ x, y, g: Math.hypot(h, k, l) });
  }
  return spots;
}
const zoneLabel = (index: number) => `[${ZONES[index].join('')}]`;
const tokenAngle = (index: number) => index * STEP - 60;
function CrystalScene({ selected, reduced, logoDelay, pick, enter }: SceneProps) {
  const angles = zoneAngles(ZONES[selected]);
  const yaw = useNearest(angles.b);
  const pointer = useNearest(tokenAngle(selected));
  const spots = useMemo(() => zoneSpots(selected), [selected]);
  const current = entryWorkbenches[selected];
  const satellite = (index: number): CSSProperties => {
    const a = tokenAngle(index) * Math.PI / 180, [sx, sy] = SEED.satellites[index];
    return vars({ '--tx': `${(CR.ring * Math.cos(a) / CR.scale - sx).toFixed(1)}px`, '--ty': `${(CR.ring * Math.sin(a) / CR.scale - sy).toFixed(1)}px` });
  };
  return <div className="cr-root" style={vars({ '--cr-a': `${angles.a.toFixed(3)}deg`, '--cr-b': `${yaw.toFixed(3)}deg`, '--cr-index': `${pointer}deg` })}>
    <svg className="cr-diffraction" viewBox="-400 -400 800 800" aria-hidden="true"><g key={selected} className="cr-spots">
      <circle r={340} className="cr-plate" />
      {spots.map((spot, index) => spot.g === 0
        ? <circle key={index} r={10} className="cr-spot cr-spot-zero" />
        : <circle key={index} cx={spot.x.toFixed(1)} cy={spot.y.toFixed(1)} r={(9 / (1 + .32 * spot.g)).toFixed(2)} className="cr-spot" />)}
    </g></svg>
    <SeedRing satellite={satellite} />
    <i className="cr-band" />
    <i className="cr-index" />
    <div className="cr-lattice">
      {CR_ATOMS.map((atom, index) => <i key={index} className="cr-atom" data-body={atom.body} style={vars({ '--p': `translate3d(${atom.p[0]}px,${atom.p[1]}px,${atom.p[2]}px)`, '--r': (Math.hypot(...atom.p) / 300).toFixed(2) })}><b /></i>)}
    </div>
    <div className="cr-lens-anchor co-item" data-current="true">
      <div className="cr-lens"><div key={selected} className="cr-lens-in">
        <button className="cr-lens-hit" aria-label={`进入${current.title}`} onClick={enter}>
          <i className="cr-lens-cross" />
          <Emblem workbench={current} live reduced={reduced} wait={logoDelay(selected) || 1150} source />
        </button>
        <span className="cr-lens-label">ZONE AXIS {zoneLabel(selected)}</span>
      </div></div>
    </div>
    {entryWorkbenches.map((workbench, index) => {
      const a = tokenAngle(index) * Math.PI / 180;
      return <div key={workbench.id} className="cr-token-anchor" style={vars({ '--tx': `${(Math.cos(a) * CR.ring).toFixed(1)}px`, '--ty': `${(Math.sin(a) * CR.ring).toFixed(1)}px`, '--i': index })}>
        <button className="cr-token" aria-pressed={index === selected} aria-label={`${workbench.title} · 晶带轴 ${zoneLabel(index)}`} onClick={() => index === selected ? enter() : pick(index)}>
          <Emblem workbench={workbench} live={false} reduced={reduced} />
        </button>
        <span className="cr-token-label"><b>{SECTION_CODES[index]}</b>{zoneLabel(index)} · {shortNames[index]}</span>
      </div>;
    })}
  </div>;
}

/* ── Editorial reading layer (第五轮) ────────────────────────────────────
 * Black section block with a scrambling four-letter code, a live readout of
 * the scene's own quantity, an index of the six sections, a tagline, and a
 * leader line that follows the chosen logo through the 3D scene. */
type Readout = { label: string; value: string; note: string };
function readoutFor(design: CeremonyDesign, selected: number, group: GroupState): Readout | null {
  if (design === 'quantum') return { label: 'OBSERVED STATE', value: `|ψ${selected + 1}⟩`, note: 'COLLAPSED · P = 1.00' };
  if (design === 'mobius') return { label: 'EULER CHARACTERISTIC', value: 'χ = 0', note: 'ONE SIDE · ONE EDGE' };
  if (design === 'fractal') return { label: 'GROUP ELEMENT · D6', value: group.element, note: selected === FG_CENTRE ? 'FIXED POINT · CENTRE' : group.f > 0 ? 'ROTATION' : 'REFLECTION' };
  if (design === 'lorenz') { const [x, y, z] = LZ.raw[LZ.states[selected]]; return { label: 'PHASE STATE (x, y, z)', value: `${x.toFixed(1)}  ${y.toFixed(1)}  ${z.toFixed(1)}`, note: 'σ 10 · ρ 28 · β 8/3' }; }
  if (design === 'crystal') return { label: 'ZONE AXIS', value: zoneLabel(selected), note: 'BCC · h + k + l EVEN' };
  if (design === 'drafting') return { label: 'STATION · PLAN', value: `X ${stationX(selected)}`, note: 'PLATE 01 · SCALE 2.5 : 1' };
  if (design === 'aperture') return { label: 'FOCUS RING', value: `${Math.round(modulo(150 - selected * STEP, 360))}°`, note: 'IRIS OPEN · SECTION ' + SECTION_CODES[selected] };
  return null;
}
function useScramble(text: string, still: boolean) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (still) { setShown(text); return; }
    const glyphs = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789/#';
    const start = performance.now();
    let frame = 0;
    const tick = () => {
      const p = (performance.now() - start) / 460;
      if (p >= 1) { setShown(text); return; }
      setShown(text.split('').map((letter, index) => p * (text.length + 1) > index + 1 ? letter : glyphs[Math.floor(Math.random() * glyphs.length)]).join(''));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, still]);
  return shown;
}
/** A leader line from the chosen logo, wherever the 3D scene has put it, to a small section tag. */
function Callout({ root, active, code, serial, title }: { root: { current: HTMLElement | null }; active: boolean; code: string; serial: string; title: string }) {
  const line = useRef<SVGPolylineElement>(null), dot = useRef<SVGCircleElement>(null), tag = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const tick = () => {
      const host = root.current, source = host?.querySelector('[data-ceremony-source="true"]');
      if (host && source && line.current && dot.current && tag.current) {
        const h = host.getBoundingClientRect(), r = source.getBoundingClientRect();
        if (r.width > 4) {
          const ax = r.left - h.left + r.width * .86, ay = r.top - h.top + r.height * .16;
          const tx = Math.min(h.width - 250, ax + 120), ty = Math.max(96, ay - 120);
          line.current.setAttribute('points', `${ax.toFixed(1)},${ay.toFixed(1)} ${(tx - 26).toFixed(1)},${(ty + 15).toFixed(1)} ${tx.toFixed(1)},${(ty + 15).toFixed(1)}`);
          dot.current.setAttribute('cx', ax.toFixed(1)); dot.current.setAttribute('cy', ay.toFixed(1));
          tag.current.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, root]);
  return <div className="ed-callout" data-active={active} aria-hidden="true">
    <svg><polyline ref={line} points="0,0 0,0" /><circle ref={dot} r={4} /></svg>
    <div ref={tag} className="ed-callout-tag" key={code}><b>{code}</b><span>{title}</span><small>{serial} · SECTION ARCHIVE</small></div>
  </div>;
}
