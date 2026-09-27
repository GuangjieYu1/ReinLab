import { cinematicField, extraction, smooth, settlingWave, columnStrength } from './reference/archive-motion';

export const BOOT_END = 21.92;
// Automatic playback stops at the settled library; extraction is an explicit user action.
export const LIBRARY_END = 26.56;
export const FILM_END = LIBRARY_END;
export const DETAIL_REFERENCE_END = 34.6;
export const STAGE = { width: 1920, height: 1080 };
export const UNIT = 100;
export const ROWS = 32;
export const LANES = 4;
export type Cell = { lane: number; row: number };
export type Vec3 = [number, number, number];
export type CameraPose = { aim: Vec3; yaw: number; elevation: number; distance: number; span: number };
export const DEFAULT_CELL: Cell = { lane: 1, row: 12 };
export const chapters = [
  { time: 1.76, label: '终端接入', code: '01' },
  { time: 4.16, label: '标志绘制', code: '02' },
  { time: 6.12, label: '身份序列', code: '03' },
  { time: 14.48, label: '授权圆环', code: '04' },
  { time: 17.76, label: '欢迎与白场', code: '05' },
  { time: BOOT_END, label: '阵列传播', code: '06' },
  { time: 25.4, label: '文档库就绪', code: '07' },
] as const;
export const clamp = (x: number, min = 0, max = 1) => Math.min(max, Math.max(min, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => a.map((x, i) => lerp(x, b[i], t)) as Vec3;
const radians = (a: number) => a * Math.PI / 180;
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
export const cellX = (lane: number) => (lane - 1.5) * 5.2;
export const cellZ = (row: number) => (row - 15.5) * .62;
export const cellIndex = (cell: Cell) => cell.lane * ROWS + cell.row;
export const sameCell = (a: Cell, b: Cell) => a.lane === b.lane && a.row === b.row;

export function cameraBasis(yaw: number, elevation: number) {
  const y = radians(yaw), e = radians(elevation);
  const direction: Vec3 = [-Math.sin(y) * Math.cos(e), Math.sin(e), Math.cos(y) * Math.cos(e)];
  const right: Vec3 = [Math.cos(y), 0, Math.sin(y)];
  const up: Vec3 = [Math.sin(y) * Math.sin(e), Math.cos(e), -Math.cos(y) * Math.sin(e)];
  return { direction, right, up };
}

function aimAtScreen(point: Vec3, x: number, y: number, span: number, yaw: number, elevation: number): Vec3 {
  const { right, up } = cameraBasis(yaw, elevation);
  const pixelScale = STAGE.height / span;
  return add(add(point, mul(right, -(x - 960) / pixelScale)), mul(up, -(540 - y) / pixelScale));
}

/** The reference's measured camera track, expressed as CSS camera coordinates. */
export function cinematicCamera(time: number, cell: Cell = DEFAULT_CELL): CameraPose {
  const orbit = smooth((time - 22.6) / 1.6), settle = smooth((time - 24.25) / 2.25);
  const close = smooth((time - 27.3) / 6.7);
  const yaw = 89 - 22 * orbit - 8 * settle - 9 * smooth((time - 27.3) / 1.3) - 32 * smooth((time - 28.6) / 5.4);
  const elevation = 3 + 40 * smooth((time - 21.96) / .22) - 8 * orbit - 16 * settle - 1.5 * smooth((time - 27.3) / 1.3) - 3.7 * smooth((time - 28.6) / 5.4);
  const baseSpan = lerp(lerp(10.8, 10.3, orbit), 7.33, settle);
  const span = lerp(baseSpan, 5.9, close);
  const distance = lerp(lerp(28 + 7 * orbit, 140, settle), 72, close);
  let aim: Vec3 = [-1.091, lerp(-2.55 + .4 * orbit, -.045, settle), lerp(2.48, .481, settle)];
  const { right } = cameraBasis(yaw, elevation);
  const pan = smooth((time - 25.4) / .95);
  aim = add(aim, mul(right, -2.05 * (1 - pan) * smooth((time - 24.2) / .8)));
  const entryZ = -12 * (1 - smooth((time - BOOT_END) / .75));
  const selectedY = -4.6 + cinematicField(cell.row, cell.lane, time, cell.row, cell.lane) + extraction(time);
  const topLeft: Vec3 = [cellX(cell.lane) - 2.5, selectedY + 3.7, cellZ(cell.row) + entryZ];
  if (time >= 25.05 && time <= 27.3) {
    const p = smooth((time - 25.4) / 1.05);
    const anchor = aimAtScreen(topLeft, lerp(840, 518, p), lerp(340, 288, p), span, yaw, elevation);
    aim = mix3(aim, anchor, smooth((time - 25.05) / .35));
  } else if (time > 27.3) {
    const p = smooth((time - 27.3) / 1.25);
    const anchor = aimAtScreen(topLeft, lerp(518 - 98 * p, 618, close), lerp(296 + 34 * p, 287, close), span, yaw, elevation);
    aim = mix3(aim, anchor, smooth((time - 27.3) / .5));
  }
  return { aim, yaw, elevation, span, distance };
}

export function interactiveCamera(cell: Cell, detail: number, height: number, portrait = false): CameraPose {
  const yaw = lerp(59, 17, detail), elevation = lerp(19, 14, detail);
  const span = lerp(portrait ? 13 : 7.33, portrait ? 11.5 : 5.9, detail);
  const selectedY = -4.6 + height;
  const topLeft: Vec3 = [cellX(cell.lane) - 2.5, selectedY + 3.7, cellZ(cell.row)];
  const center: Vec3 = [cellX(cell.lane), selectedY + 1.85, cellZ(cell.row)];
  const archiveAim = aimAtScreen(topLeft, portrait ? 850 : 518, portrait ? 240 : 288, span, yaw, elevation);
  const detailAim = aimAtScreen(center, portrait ? 960 : 580, portrait ? 260 : 525, span, yaw, elevation);
  return { aim: mix3(archiveAim, detailAim, detail), yaw, elevation, span, distance: lerp(140, 72, detail) };
}

/** A look-at transform plus CSS perspective; no renderer or canvas is involved. */
export function cssCamera(pose: CameraPose) {
  const { direction: d, right: r, up: u } = cameraBasis(pose.yaw, pose.elevation);
  const camera = add(pose.aim, mul(d, pose.distance));
  const perspective = pose.distance * STAGE.height / pose.span;
  const matrix = [
    r[0], -u[0], d[0], 0,
    -r[1], u[1], -d[1], 0,
    r[2], -u[2], d[2], 0,
    -UNIT * dot(r, camera), UNIT * dot(u, camera), perspective - UNIT * dot(d, camera), 1,
  ];
  return { perspective, matrix, transform: `matrix3d(${matrix.map(v => Math.round(v * 1e6) / 1e6).join(',')})` };
}

export function projectPoint(point: Vec3, pose: CameraPose): [number, number] {
  const { direction, right, up } = cameraBasis(pose.yaw, pose.elevation);
  const camera = add(pose.aim, mul(direction, pose.distance));
  const relative = add(point, mul(camera, -1));
  const focal = pose.distance * STAGE.height / pose.span;
  return [960 + focal * dot(right, relative) / -dot(direction, relative), 540 - focal * dot(up, relative) / -dot(direction, relative)];
}

export function archiveHeight(row: number, lane: number, focusRow: number, focusLane: number) {
  return settlingWave(row - focusRow, 26.56) * columnStrength(lane, focusLane);
}

export function decryptionState(sourceTime: number) {
  const extend = smooth((sourceTime - 34.24) / 1.8);
  const retract = smooth((sourceTime - 37.72) / 1.12);
  return {
    line: extend * (1 - retract),
    clarity: smooth((sourceTime - 38.84) / .72),
    label: clamp((sourceTime - 34.4) / .5) * (1 - smooth((sourceTime - 39.04) / .52)),
  };
}
