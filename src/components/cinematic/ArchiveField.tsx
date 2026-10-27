import { forwardRef, memo, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { platforms } from '../../model';
import { archiveHeight, BOOT_END, cellX, cellZ, cinematicCamera, clamp, cssCamera, DEFAULT_CELL, decryptionState, interactiveCamera, LANES, lerp, mix3, ROWS, sameCell, UNIT, type CameraPose, type Cell } from './timeline';
import { baselineSelectionWave, cinematicField, damp, extraction, idleWave, smooth } from './reference/archive-motion';

export const archiveNames = [
  ['文献与实验', '方法与证据', '研究笔记'],
  ['OpenMAIC 课程档案'],
  ['交互设计', '组件与规范', '验证与交付'],
  ['路线与灵感', '城市观察', '旅途记录'],
];
const wrap = (n: number, m: number) => ((n % m) + m) % m;
export const nameFor = (cell: Cell) => { const names = archiveNames[wrap(cell.lane, archiveNames.length)]; return names[wrap(cell.row, names.length)]; };
/** 无限档案场里列号、行号可以是任意整数：平台按列循环，编号取 001…999 循环。 */
const platformOf = (lane: number) => platforms[wrap(lane, platforms.length)];
const numberOf = (row: number) => String(wrap(row, 999) + 1).padStart(3, '0');
export type FieldFrame = { time: number; elapsed: number; delta: number; film: boolean; detail: boolean; reduced: boolean; portrait: boolean; visible: boolean };
export type FieldStatus = { detail: number; clarity: number; aligned: boolean };
export type ArchiveFieldHandle = { update: (frame: FieldFrame) => FieldStatus; inspect: (angle: number) => void; reset: () => void; pulse?: (cell?: Cell) => void };
// 格位池：有限档案场是固定的 LANES × ROWS；无限档案场用一个稍大的池，在列、行两个方向上循环复用。
type Pool = { lanes: number; rows: number; cells: Cell[] };
const makePool = (lanes: number, rows: number): Pool => ({ lanes, rows, cells: Array.from({ length: lanes * rows }, (_, i) => ({ lane: Math.floor(i / rows), row: i % rows })) });
const FINITE = makePool(LANES, ROWS), ENDLESS = makePool(7, 36);
/** 某一格由哪个格位来画：列、行分别对池的大小取模。有限档案场里就是原来的 lane × ROWS + row。 */
const slotOf = (pool: Pool, cell: Cell) => wrap(cell.lane, pool.lanes) * pool.rows + wrap(cell.row, pool.rows);
const spring = (value = 0) => ({ value, velocity: 0 });
const cullingCorners = [[-270, -390], [270, -390], [-270, 20], [270, 20]];
/** 无限档案场：以 base 为起点、长 size 的窗口；格位的基准值 v0 映射到窗口里与它同余的那一个。 */
const inWindow = (v0: number, base: number, size: number) => base + wrap(v0 - base, size);
const windowBase = (center: number, size: number) => Math.round(center) - Math.floor(size / 2);
type Win = { lane: number; row: number };

const ArchiveField = memo(forwardRef<ArchiveFieldHandle, {
  selected: Cell;
  onSelect: (cell: Cell) => void;
  sharedElementSurface?: 'archive' | 'classroom' | 'both';
  sharedTransitionPhase?: 'opening' | 'returning' | null;
  onSharedTransitionComplete?: () => void;
  content?: { title: string; english: string; nameFor: (cell: Cell) => string };
  selectedFace?: ReactNode;
  /** 行向无限延伸：同一组格位循环复用，离镜头远的行沉入档案海，在另一端重新浮起并换上新的行号。行号从 0 起。 */
  infinite?: boolean;
}>(function ArchiveField({ selected, onSelect, sharedElementSurface = 'archive', sharedTransitionPhase = null, onSharedTransitionComplete, content, selectedFace, infinite = false }, ref) {
  const pool = infinite ? ENDLESS : FINITE; // 同一次挂载内不变
  const projection = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const cache = useRef({
    transforms: new Array<string>(pool.cells.length).fill(''),
    visibility: new Array<string>(pool.cells.length).fill(''),
    clarity: new Array<string>(pool.cells.length).fill(''),
    scan: new Array<string>(pool.cells.length).fill(''),
    camera: '', perspective: '',
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // 窗口起点：帧循环里随镜头移动更新（ref 立即生效，state 让标签在下一次渲染换上新行号——换号的格位此刻正沉在海面下）。
  const [win, setWin] = useState<Win>(() => ({ lane: windowBase(selected.lane, pool.lanes), row: windowBase(selected.row, pool.rows) }));
  const winRef = useRef(win);
  /** 格位 i 此刻代表的格（无限档案场里随窗口变化）。 */
  const cellOf = (i: number, w: Win): Cell => infinite
    ? { lane: inWindow(pool.cells[i].lane, w.lane, pool.lanes), row: inWindow(pool.cells[i].row, w.row, pool.rows) }
    : pool.cells[i];
  const state = useRef({
    lifts: pool.cells.map(() => spring()),
    angles: pool.cells.map(() => spring()),
    row: spring(DEFAULT_CELL.row), lane: spring(DEFAULT_CELL.lane),
    detail: spring(), targetAngle: 0,
    pose: cinematicCamera(26.56), previous: DEFAULT_CELL,
    pulses: [] as { cell: Cell; at: number }[],
    decryptionAge: 0, lastInteraction: 0, wasFilm: true, elapsed: 0,
  });

  useImperativeHandle(ref, () => ({
    inspect(angle) { state.current.targetAngle = clamp(angle, -38, 38); },
    // Optional: send a selection wave through the field without changing the selection.
    pulse(cell) { const s = state.current; s.pulses.push({ cell: cell ?? selectedRef.current, at: s.elapsed }); s.lastInteraction = s.elapsed; },
    reset() {
      const s = state.current;
      s.lifts.forEach(l => { l.value = 0; l.velocity = 0; });
      s.detail.value = 0; s.detail.velocity = 0;
      s.angles.forEach(a => { a.value = 0; a.velocity = 0; }); s.targetAngle = 0;
      s.decryptionAge = 0; s.pulses = [];
      s.row = spring(DEFAULT_CELL.row); s.lane = spring(DEFAULT_CELL.lane);
      s.previous = DEFAULT_CELL; s.wasFilm = true;
    },
    update(frame) {
      const s = state.current, cell = selectedRef.current, dt = Math.min(.045, frame.delta);
      s.elapsed = frame.elapsed;
      if (!projection.current || !camera.current || !root.current || !frame.visible) return { detail: 0, clarity: 0, aligned: true };
      if (!sameCell(s.previous, cell)) {
        s.pulses.push({ cell, at: frame.elapsed });
        s.previous = { ...cell }; s.lastInteraction = frame.elapsed;
        s.decryptionAge = 0; s.targetAngle = 0;
      }
      s.pulses = s.pulses.filter(p => frame.elapsed - p.at < 3.2);
      const focusIndex = slotOf(pool, cell);
      let pose: CameraPose;
      let scan = decryptionState(frame.time + 5);
      if (frame.film) {
        s.row.value = cell.row; s.lane.value = cell.lane;
        s.detail.value = smooth((frame.time - 27.3) / 6.7);
        s.lifts.forEach((l, i) => { l.value = i === focusIndex ? extraction(frame.time) : 0; l.velocity = 0; });
        s.angles.forEach(a => { a.value = 0; a.velocity = 0; }); s.targetAngle = 0;
        pose = cinematicCamera(frame.time, cell);
        s.pose = pose;
        s.decryptionAge = Math.max(0, (frame.time + 5 - 34.24) / 1.466);
      } else {
        damp(s.row, cell.row, frame.reduced ? 1000 : 4.2, dt);
        damp(s.lane, cell.lane, frame.reduced ? 1000 : 4.2, dt);
        s.angles.forEach((a, i) => {
          damp(a, frame.detail && i === focusIndex ? s.targetAngle : 0, frame.reduced ? 1000 : 7, dt);
          if (Math.abs(a.value) < .02) a.value = 0;
        });
        const aligned = frame.detail || Math.abs(s.angles[focusIndex].value) < .05;
        s.lifts.forEach((l, i) => {
          const target = i === focusIndex ? frame.detail ? 4.05 : .4 : 0;
          if (i === focusIndex ? aligned : Math.abs(s.angles[i].value) < .05) {
            if (frame.reduced) { l.value = target; l.velocity = 0; }
            else damp(l, target, 4.2, dt);
          }
        });
        const detailTarget = frame.detail ? smooth((s.lifts[focusIndex].value - .8) / 2.4) : aligned ? smooth((s.lifts[focusIndex].value - .4) / 3.65) : s.detail.value;
        if (frame.reduced) s.detail.value = frame.detail ? 1 : 0;
        else damp(s.detail, detailTarget, 6, dt);
        if (frame.detail && s.detail.value > .78 && s.lifts[focusIndex].value > 3.3) s.decryptionAge += dt;
        else if (!frame.detail && s.detail.value < .03) s.decryptionAge = 0;
        scan = decryptionState(frame.reduced && frame.detail ? 40 : 34.24 + s.decryptionAge * 1.466);
        const height = archiveHeight(cell.row, cell.lane, s.row.value, s.lane.value) + s.lifts[focusIndex].value;
        const target = interactiveCamera(cell, s.detail.value, height, frame.portrait);
        const blend = frame.reduced ? 1 : 1 - Math.exp(-dt * (s.wasFilm ? 3 : 5));
        pose = {
          aim: mix3(s.pose.aim, target.aim, blend),
          yaw: lerp(s.pose.yaw, target.yaw, blend),
          elevation: lerp(s.pose.elevation, target.elevation, blend),
          distance: lerp(s.pose.distance, target.distance, blend),
          span: lerp(s.pose.span, target.span, blend),
        };
        s.pose = pose;
      }
      s.wasFilm = frame.film;
      const cameraCss = cssCamera(pose);
      const perspective = `${cameraCss.perspective.toFixed(3)}px`;
      if (cache.current.perspective !== perspective) { projection.current.style.perspective = perspective; cache.current.perspective = perspective; }
      if (cache.current.camera !== cameraCss.transform) { camera.current.style.transform = cameraCss.transform; cache.current.camera = cameraCss.transform; }
      const entryZ = frame.film ? -12 * (1 - smooth((frame.time - BOOT_END) / .75)) : 0;
      const idle = !frame.film && !frame.detail && !frame.reduced && s.detail.value < .01 && Math.abs(s.angles[focusIndex].value) < .05 && frame.elapsed - s.lastInteraction > 2.5;
      const scanLine = clamp(scan.line);
      const endless = infinite && !frame.film;
      if (endless) {
        const want = { lane: windowBase(s.lane.value, pool.lanes), row: windowBase(s.row.value, pool.rows) };
        if (want.lane !== winRef.current.lane || want.row !== winRef.current.row) { winRef.current = want; setWin(want); }
      }
      for (let i = 0; i < pool.cells.length; i++) {
        const el = cards.current[i];
        if (!el) continue;
        const active = i === focusIndex;
        // 选中的格位始终取选中的行号（镜头还没赶到时，窗口可能尚未覆盖它）。
        const c = endless ? (active ? cell : cellOf(i, winRef.current)) : pool.cells[i];
        let height = frame.film ? cinematicField(c.row, c.lane, frame.time, cell.row, cell.lane) : archiveHeight(c.row, c.lane, s.row.value, s.lane.value);
        if (!frame.film && !frame.detail && !frame.reduced && s.detail.value < .05) {
          const ripple = s.pulses.reduce((sum, p) => sum + baselineSelectionWave(Math.hypot(c.row - p.cell.row, (c.lane - p.cell.lane) * 2.2), frame.elapsed - p.at), 0);
          height += clamp(ripple, -.6, .6);
        }
        if (idle) height += idleWave(c.row, c.lane, frame.elapsed);
        // 窗口边缘的行与列沉入档案海：离镜头越远沉得越深，越过窗口边缘时已完全没入，格位换位不会被看见。
        let sunk = 0;
        if (endless && !active) sunk = Math.max(
          smooth((Math.abs(c.row - s.row.value) - (pool.rows / 2 - 6)) / 5.2),
          smooth((Math.abs(c.lane - s.lane.value) - (pool.lanes / 2 - 1.1)) / .9));
        height -= sunk * 7;
        height += s.lifts[i].value;
        const angle = s.angles[i].value;
        const x = cellX(c.lane) * UNIT, y = (4.6 - height) * UNIT, z = (cellZ(c.row) + entryZ) * UNIT;
        const m = cameraCss.matrix, p = cameraCss.perspective;
        // Conservative screen culling, without any layout reads in the frame loop.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [dx, dy] of cullingCorners) {
          const px = x + dx, py = y + dy;
          const denominator = 1 - (px * m[2] + py * m[6] + z * m[10] + m[14]) / p;
          if (denominator <= .01) continue;
          const sx = 960 + (px * m[0] + py * m[4] + z * m[8] + m[12]) / denominator;
          const sy = 540 + (px * m[1] + py * m[5] + z * m[9] + m[13]) / denominator;
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        }
        const visibility = active || sunk < .97 && maxX > -250 && minX < 2170 && maxY > -180 && minY < 1260 ? 'visible' : 'hidden';
        if (cache.current.visibility[i] !== visibility) { el.style.visibility = visibility; cache.current.visibility[i] = visibility; }
        if (visibility === 'hidden') continue;
        const transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,${z.toFixed(2)}px) rotateY(${angle.toFixed(3)}deg)`;
        if (cache.current.transforms[i] !== transform) { el.style.transform = transform; cache.current.transforms[i] = transform; }
        if (active) {
          const clarity = (scan.clarity * clamp(s.lifts[i].value / .4)).toFixed(3), line = scanLine.toFixed(3);
          if (cache.current.clarity[i] !== clarity) { el.style.setProperty('--cassette-clarity', clarity); cache.current.clarity[i] = clarity; }
          if (cache.current.scan[i] !== line) { el.style.setProperty('--cassette-scan', line); cache.current.scan[i] = line; }
        }
      }
      return { detail: clamp(s.detail.value), clarity: scan.clarity, aligned: Math.abs(s.angles[focusIndex].value) < .05 };
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [infinite]);

  // 每个格位此刻代表的格（无限档案场里行号随窗口变化）；选中的格位总是代表选中的格。
  const focusSlot = slotOf(pool, selected);
  const cells = infinite ? pool.cells.map((_, i) => i === focusSlot ? selected : cellOf(i, win)) : pool.cells;

  return <div className="cine-field" ref={root}>
    <div className="cine-ground-shadow" />
    <div className="cine-projection" ref={projection}>
      <div className="cine-camera" ref={camera}>
        {cells.map((cell, i) => <button
          type="button" key={i} ref={el => { cards.current[i] = el; }}
          className={`cine-cassette ${sameCell(cell, selected) ? 'selected' : ''}`}
          aria-label={`${content?.title ?? platformOf(cell.lane).title} / ${content?.nameFor(cell) ?? nameFor(cell)} / 档案 ${numberOf(cell.row)}`}
          aria-pressed={sameCell(cell, selected)} tabIndex={sameCell(cell, selected) ? 0 : -1}
          onClick={() => onSelect(cell)}
          style={{ transform: `translate3d(${cellX(cell.lane) * UNIT}px,460px,${cellZ(cell.row) * UNIT}px)` }}>
          {sameCell(cell, selected) && <span className="cassette-face cassette-back" />}
          <span className="cassette-face cassette-left" />
          {sameCell(cell, selected) && <span className="cassette-face cassette-right" />}
          <span className="cassette-face cassette-top"><span>RHINE LAB / {numberOf(cell.row)}</span></span>
          {sameCell(cell, selected) && <>
            <span className="cassette-face cassette-bottom" />
            <span className="cassette-mechanism"><img src="/cassette-internals.svg" alt="" draggable={false} />
              <span className="optic-ring optic-large"><i /><i /><i /></span>
              <span className="optic-ring optic-small"><i /><i /><i /></span>
            </span>
          </>}
          {sameCell(cell, selected) ? <>
            <AnimatePresence initial={false} mode="sync">
              {sharedElementSurface === 'archive' && <motion.span
                key="archive-study-surface"
                className="cassette-shared-face"
                layoutId="reinlab-study-surface"
                transition={{ layout: { duration: sharedTransitionPhase === 'returning' ? .68 : .42, ease: sharedTransitionPhase === 'returning' ? [.32,.08,.3,1] : [.2,.72,.16,1] } }}
                onLayoutAnimationComplete={sharedTransitionPhase === 'returning' ? onSharedTransitionComplete : undefined}
              >
                <span className="cassette-face cassette-front">
                  <span className="cassette-frost" /><span className="cassette-specular" />
                  <span className="cassette-border" />
                  <span className="cassette-slot" />
                  <span className="cassette-screw screw-upper" /><span className="cassette-screw screw-lower" />
                  <span className="cassette-etching">RHINE LAB<span>INTERNAL DATABASE</span></span>
                  <span className="cassette-serial">X—{numberOf(cell.row)}<span>{content?.english ?? platformOf(cell.lane).english}</span></span>
                  <span className="cassette-security-line"><i /><i /></span>
                  <span className="cassette-security-tag">CONFIDENTIALITY:<b>GENERAL BUSINESS USE</b></span>
                </span>
              </motion.span>}
            </AnimatePresence>
            {sharedElementSurface !== 'archive' && <span className="cassette-face cassette-front">
              {selectedFace ?? <>
              <span className="cassette-frost" /><span className="cassette-specular" />
              <span className="cassette-border" />
              <span className="cassette-slot" />
              <span className="cassette-screw screw-upper" /><span className="cassette-screw screw-lower" />
              <span className="cassette-etching">RHINE LAB<span>INTERNAL DATABASE</span></span>
              <span className="cassette-serial">X—{numberOf(cell.row)}<span>{content?.english ?? platformOf(cell.lane).english}</span></span>
              <span className="cassette-security-line"><i /><i /></span>
              <span className="cassette-security-tag">CONFIDENTIALITY:<b>GENERAL BUSINESS USE</b></span>
              </>}
            </span>}
          </> : <span className="cassette-face cassette-front"><img className="cassette-array-texture" src="/cassette-array.svg" alt="" draggable={false} /></span>}
        </button>)}
      </div>
    </div>
    <div className="cine-atmosphere" />
  </div>;
}));

export default ArchiveField;
