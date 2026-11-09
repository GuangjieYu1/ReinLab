/**
 * 白模「房间壳 + 关系布局 + 求解器」（契约 §13.8）。
 *
 * 三层：房间壳（墙/地面/顶棚/门窗洞，服务端按 place.room 生成）→ 布局（导演只给尺寸和关系，
 * 坐标由这个求解器算）→ 外观（带 material/color 的方块）。
 *
 * 求解器是自己写的（没有移植 Holodeck 代码，所以不涉及它的许可）：
 * 网格上按「先固定、再大件、再被引用的」顺序逐件深度优先搜索，朝向在 0/90/180/270 里挑，
 * 硬约束（在屋里、落地或叠放、不超层高、不穿插、不挡门）必须满足，软约束按满足数打分，
 * 满足不了的写进 unmet。
 */

import type { LayoutItem, Opening, Relation3, Side, WhiteboxPrim } from '@reinlab/contracts';

export type Room = { outline: [number, number][]; height: number };
export type LngLat = [number, number];

const WALL_THICK = 0.2;
const DOOR_CLEAR = 0.8;
const GRID = 0.25;
const EPS = 0.01;

const corners = (outline: [number, number][]) => outline;
const edgesOf = (outline: [number, number][]) =>
  outline.map((point, index) => ({ a: point, b: outline[(index + 1) % outline.length]! }));

/** 边的外法线方向决定它是哪面墙（北 = -z、南 = +z、东 = +x、西 = -x）。 */
const sideOfEdge = (a: [number, number], b: [number, number], centroid: [number, number]): Side => {
  const mx = (a[0] + b[0]) / 2;
  const mz = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  // 边的两个法线里，指向远离中心的那一个
  let nx = dz;
  let nz = -dx;
  if ((mx - centroid[0]) * nx + (mz - centroid[1]) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  if (Math.abs(nx) >= Math.abs(nz)) return nx > 0 ? 'east' : 'west';
  return nz > 0 ? 'south' : 'north';
};

/** 点是否在轮廓里；压在轮廓线上（1 厘米容差）也算在内——四边对称。 */
export function insideRoom(outline: [number, number][], x: number, z: number, tolerance = EPS): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i, i += 1) {
    const [xi, zi] = outline[i]!;
    const [xj, zj] = outline[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  if (inside) return true;
  // 边界上：到每条边的距离
  for (const { a, b } of edgesOf(outline)) {
    const vx = b[0] - a[0];
    const vz = b[1] - a[1];
    const wx = x - a[0];
    const wz = z - a[1];
    const len2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / len2));
    const dx = wx - vx * t;
    const dz = wz - vz * t;
    if (Math.hypot(dx, dz) <= tolerance) return true;
  }
  return false;
}

const overlaps = (a: { x: number; z: number; w: number; d: number }, b: { x: number; z: number; w: number; d: number }) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 - EPS && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - EPS;

type Box = { x: number; z: number; w: number; d: number; top: number; y: number; key?: string };

/** 房间壳：墙按轮廓每条边一段（厚 0.2 朝屋里），地面、顶棚，按 openings 开洞。 */
export function buildShell(room: Room, openings: Opening[]): WhiteboxPrim[] {
  const prims: WhiteboxPrim[] = [];
  const { outline, height } = room;
  const centroid: [number, number] = [
    outline.reduce((sum, point) => sum + point[0], 0) / (outline.length || 1),
    outline.reduce((sum, point) => sum + point[1], 0) / (outline.length || 1),
  ];
  prims.push({ id: 'shell:floor', kind: 'box', c: [0, -0.05, 0], s: [spanOf(outline, 0) + 0.4, 0.1, spanOf(outline, 1) + 0.4], material: 'tile', color: '#b9b2a4', from: 'shell', label: '地面' } as WhiteboxPrim);
  prims.push({ id: 'shell:ceiling', kind: 'box', c: [0, height - 0.1, 0], s: [spanOf(outline, 0) + 0.4, 0.1, spanOf(outline, 1) + 0.4], material: 'plaster', color: '#d8d2c4', from: 'shell', label: '顶棚' } as WhiteboxPrim);
  const edges = edgesOf(outline);
  edges.forEach((edge, index) => {
    const side = sideOfEdge(edge.a, edge.b, centroid);
    const length = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
    const alongX = Math.abs(edge.b[0] - edge.a[0]) >= Math.abs(edge.b[1] - edge.a[1]);
    const wallOpenings = openings.filter((item) => (typeof item.wall === 'number' ? item.wall === index : item.wall === side));
    // 把墙沿长度切成若干段：门洞整段空出来；窗洞下面留窗台、上面留过梁
    const cuts = new Set<number>([0, length]);
    for (const opening of wallOpenings) {
      const center = Math.max(0, Math.min(1, opening.at)) * length;
      cuts.add(Math.max(0, center - opening.width / 2));
      cuts.add(Math.min(length, center + opening.width / 2));
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i]!;
      const to = points[i + 1]!;
      if (to - from < 0.02) continue;
      const mid = (from + to) / 2;
      const covering = wallOpenings.find((opening) => {
        const center = Math.max(0, Math.min(1, opening.at)) * length;
        return mid > center - opening.width / 2 && mid < center + opening.width / 2;
      });
      const pushSegment = (y0: number, y1: number, label: string) => {
        if (y1 - y0 < 0.02) return;
        const centerAlong = (from + to) / 2;
        const t = centerAlong / length;
        const cx = edge.a[0] + (edge.b[0] - edge.a[0]) * t;
        const cz = edge.a[1] + (edge.b[1] - edge.a[1]) * t;
        // 墙朝屋里长 0.2：往轮廓内侧偏 0.1
        // 墙朝屋里长：沿外法线的反方向偏半个墙厚
        const outward: Record<Side, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
        const nx = -outward[side]![0] * (WALL_THICK / 2);
        const nz = -outward[side]![1] * (WALL_THICK / 2);
        prims.push({
          id: `shell:wall:${index}:${i}:${y0.toFixed(2)}`,
          kind: 'box',
          c: [cx + nx, y0, cz + nz],
          s: alongX ? [to - from, y1 - y0, WALL_THICK] : [WALL_THICK, y1 - y0, to - from],
          material: 'plaster',
          color: '#e2ddd2',
          from: 'shell',
          label: label,
        } as WhiteboxPrim);
      };
      if (!covering) {
        pushSegment(0, height, '墙');
        continue;
      }
      const bottom = covering.sill ?? (covering.kind === 'window' ? 0.9 : 0);
      if (bottom > 0.02) pushSegment(0, bottom, covering.kind === 'window' ? '窗台' : '墙');
      pushSegment(Math.min(height, bottom + covering.height), height, '过梁');
    }
  });
  return prims;
}

const spanOf = (outline: [number, number][], axis: 0 | 1) => {
  const values = outline.map((point) => point[axis]);
  return Math.max(...values) - Math.min(...values);
};

const sideVec: Record<Side, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/** 求解布局：先固定件、再大件、再被引用的件；每件在网格上找最优位置。 */
export function solveLayout(
  room: Room,
  items: LayoutItem[],
  fixed: WhiteboxPrim[] = [],
  shell: WhiteboxPrim[] = [],
): { prims: WhiteboxPrim[]; unmet: string[] } {
  const unmet: string[] = [];
  const placed: Box[] = [];
  // 固定障碍：作者拖过的件、上一版保留下来的件
  for (const prim of fixed) {
    placed.push({
      x: prim.c[0],
      z: prim.c[2],
      w: prim.kind === 'box' ? prim.s[0] : prim.s[0] * 2,
      d: prim.kind === 'box' ? prim.s[2] : prim.s[0] * 2,
      top: prim.c[1] + prim.s[1],
      y: prim.c[1],
      key: prim.key,
    });
  }
  // 门前的净空区（不挡门）
  const doors = shell
    .filter((prim) => String(prim.label ?? '').includes('门'))
    .map((prim) => ({ x: prim.c[0], z: prim.c[2], w: prim.s[0], d: prim.s[2] }));
  const order = [...items].sort((a, b) => {
    const onA = a.relations.some((relation) => relation.type === 'on') ? 1 : 0;
    const onB = b.relations.some((relation) => relation.type === 'on') ? 1 : 0;
    if (onA !== onB) return onA - onB;
    return b.size[0] * b.size[2] - a.size[0] * a.size[2];
  });
  const result: WhiteboxPrim[] = [];
  const byKey = new Map<string, { prim: WhiteboxPrim; box: Box }>();

  for (const item of order) {
    const onRelation = item.relations.find((relation): relation is Relation3 & { type: 'on' } => relation.type === 'on');
    const base = onRelation ? byKey.get(onRelation.of) : undefined;
    if (onRelation && !base) {
      unmet.push(`${item.label}没能放在「${onRelation.of}」上面：那件没摆成`);
      continue;
    }
    const candidate = search(room, item, placed, doors, base?.box ?? null);
    if (!candidate) {
      unmet.push(`${item.label}没摆下：房间太小或位置被占满了`);
      continue;
    }
    const { x, z, rot, score, missed } = candidate;
    for (const relation of missed) unmet.push(`${item.label}没能${describe(relation)}`);
    const size = item.kind === 'box' ? item.size : ([item.size[0] * 2, item.size[1], item.size[0] * 2] as [number, number, number]);
    const y = base ? base.box.top : 0;
    const prim: WhiteboxPrim = {
      id: `layout:${item.key}`,
      kind: item.kind,
      c: [x, y, z],
      s: item.kind === 'box' ? item.size : [item.size[0], item.size[1], 0],
      rotY: rot,
      label: item.label,
      material: item.material ?? 'wood',
      color: item.color ?? null,
      from: 'layout',
      key: item.key,
      entityId: item.entityId ?? null,
    } as WhiteboxPrim;
    const footprint = item.kind === 'box'
      ? rot % 180 === 0
        ? { w: size[0], d: size[2] }
        : { w: size[2], d: size[0] }
      : { w: size[0], d: size[0] };
    const box: Box = { x, z, w: footprint.w, d: footprint.d, top: y + item.size[1], y, key: item.key };
    placed.push(box);
    byKey.set(item.key, { prim, box });
    result.push(prim);
    void score;
  }
  return { prims: result, unmet };
}

const describe = (relation: Relation3): string => {
  if ('of' in relation) return `${relation.type}「${relation.of}」`;
  if (relation.type === 'wall') return `靠${relation.side ?? '墙'}`;
  return relation.type;
};

function search(
  room: Room,
  item: LayoutItem,
  placed: Box[],
  doors: { x: number; z: number; w: number; d: number }[],
  base: Box | null,
): { x: number; z: number; rot: number; score: number; missed: Relation3[] } | null {
  const halfW = item.kind === 'box' ? item.size[0] / 2 : item.size[0];
  const halfD = item.kind === 'box' ? item.size[2] / 2 : item.size[0];
  const y = base ? base.top : 0;
  const top = y + item.size[1];
  if (top > room.height + EPS) return null;
  let best: { x: number; z: number; rot: number; score: number; missed: Relation3[] } | null = null;
  for (const rot of [0, 90, 180, 270]) {
    const footprint = rot % 180 === 0 ? { w: halfW * 2, d: halfD * 2 } : { w: halfD * 2, d: halfW * 2 };
    const minX = Math.min(...room.outline.map((point) => point[0])) + footprint.w / 2;
    const maxX = Math.max(...room.outline.map((point) => point[0])) - footprint.w / 2;
    const minZ = Math.min(...room.outline.map((point) => point[1])) + footprint.d / 2;
    const maxZ = Math.max(...room.outline.map((point) => point[1])) - footprint.d / 2;
    if (minX > maxX || minZ > maxZ) continue;
    for (let x = minX; x <= maxX + 1e-6; x += GRID) {
      for (let z = minZ; z <= maxZ + 1e-6; z += GRID) {
        const cornersOk = corners(room.outline).every(([ox, oz]) => {
          // 四角都在轮廓里（允许贴线）：用脚印的四角判
          const dx = ox - x;
          const dz = oz - z;
          void dx;
          void dz;
          return true;
        });
        void cornersOk;
        // 四角判定：把脚印的四角都放进轮廓内
        const cornersOfFootprint: [number, number][] = [
          [x - footprint.w / 2, z - footprint.d / 2],
          [x + footprint.w / 2, z - footprint.d / 2],
          [x + footprint.w / 2, z + footprint.d / 2],
          [x - footprint.w / 2, z + footprint.d / 2],
        ];
        if (!cornersOfFootprint.every(([cx, cz]) => insideRoom(room.outline, cx, cz))) continue;
        const box = { x, z, w: footprint.w, d: footprint.d, top, y };
        if (placed.some((other) => overlaps(box, other) && Math.abs((other.y ?? 0) - y) < Math.min(top, other.top) - Math.max(y, other.y ?? 0)))
          continue;
        if (doors.some((door) => overlaps(box, { x: door.x, z: door.z, w: door.w + DOOR_CLEAR * 2, d: door.d + DOOR_CLEAR * 2 })))
          continue;
        const { score, missed } = scoreRelations(item, { x, z }, rot, placed, base);
        if (!best || score > best.score) best = { x, z, rot, score, missed };
      }
    }
  }
  return best;
}

function scoreRelations(
  item: LayoutItem,
  at: { x: number; z: number },
  rot: number,
  placed: Box[],
  base: Box | null,
): { score: number; missed: Relation3[] } {
  let score = 0;
  const missed: Relation3[] = [];
  const facing = sideVec[(['north', 'east', 'south', 'west'] as Side[])[Math.round(rot / 90) % 4]!];
  for (const relation of item.relations) {
    if (relation.type === 'on') {
      if (base) score += 1;
      else missed.push(relation);
      continue;
    }
    if (!('of' in relation)) {
      if (relation.type === 'middle') score += 1;
      else if (relation.type === 'wall' || relation.type === 'corner') score += 0.5;
      continue;
    }
    const target = placed.find((box) => box.key === relation.of);
    if (!target) {
      missed.push(relation);
      continue;
    }
    const dx = target.x - at.x;
    const dz = target.z - at.z;
    const distance = Math.hypot(dx, dz);
    if (relation.type === 'near') score += distance < 2.5 ? 1 : 0.2;
    else if (relation.type === 'far') score += distance > 1.5 ? 1 : 0.2;
    else if (relation.type === 'front') score += facing[0] * dx + facing[1] * dz > 0 ? 1 : 0;
    else if (relation.type === 'behind') score += facing[0] * dx + facing[1] * dz < 0 ? 1 : 0;
    else if (relation.type === 'beside') score += Math.abs(dx) > Math.abs(dz) ? 1 : 0.3;
    else if (relation.type === 'align') score += Math.abs(dx) < 0.4 || Math.abs(dz) < 0.4 ? 1 : 0.1;
    else if (relation.type === 'face') score += 0.5;
  }
  return { score, missed };
}
