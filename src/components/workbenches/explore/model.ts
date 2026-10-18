// 探索台 EXPL 的示例：一份「拍照计划」——京都东山，秋日人像外拍一天（兼顾风光）。
// 每个机位：时间窗、镜头朝向、参数、光线（由太阳位置算）、山影遮挡、人流、规定、构图、给模特的引导词、出图提示词、服饰、雨天备选。
// 天气为模拟预报；太阳位置是真实计算；地图是莱茵风格的简化矢量图（不是真实比例）。全部为前端示例。

import { sunAt } from './sun';

export const DATE = { y: 2026, m: 10, d: 28 };
export const DATE_LABEL = '2026-10-28 · 周三';
export type Kind = 'portrait' | 'landscape' | 'street';
export const KIND_LABEL: Record<Kind, string> = { portrait: '人像', landscape: '风光', street: '街拍' };

/** 2.5D 场景里的体块（米；x 向东、z 向南、y 向上）。 */
export type Prim = { x: number; z: number; w: number; d: number; h: number; y?: number; kind: 'building' | 'tree' | 'wall' | 'water' | 'rail' | 'lantern' | 'torii' | 'sand' | 'hill' | 'path'; rot?: number };
export type Spot = {
  id: string; no: number; name: string; area: string; x: number; y: number; kind: Kind;
  start: number; dur: number; dir: number; fov: number; dist: number;
  lens: string; ap: string; ss: string; iso: string;
  horizon?: { from: number; to: number; alt: number; note: string };
  crowd: 1 | 2 | 3 | 4 | 5; crowdNote: string; rules: string[]; comp: string;
  direct: { line: string; pose: Pose }[]; prompt: string; look?: string;
  backup?: { name: string; why: string }; scene: Prim[];
};
export type Pose = 'walk' | 'look-back' | 'lean' | 'touch' | 'pockets' | 'scarf' | 'step' | 'stand';

export type Look = { id: string; name: string; items: string[]; palette: [string, string, string]; why: string; avoid: string; spots: string[]; change?: { at: number; where: string } };
export const LOOKS: Look[] = [
  { id: 'A', name: '晨雾米白', items: ['米白粗针织开衫', '浅灰长裙', '棕色乐福鞋', '细金耳饰'], palette: ['#e9e2d6', '#b9b1a5', '#6b5a48'],
    why: '逆光红叶是暖色背景，浅色针织会透光、和背景分开；棕色鞋子把画面压稳。', avoid: '大红、正绿（会和红叶撞色）', spots: ['P1'] },
  { id: 'B', name: '墨蓝长风衣', items: ['藏青长风衣', '白衬衫', '黑色及踝靴', '深色细腰带'], palette: ['#1f2a3a', '#f2f0eb', '#141213'],
    why: '水路阁的红砖、铁道的锈色都是暖调，冷色藏青跟它们互补；长风衣在拱廊的纵深里有走动感。', avoid: '砖红、棕色（会和砖墙糊成一片）', spots: ['P3', 'P4'], change: { at: 9 * 60 + 40, where: '南禅寺参道旁咖啡店' } },
  { id: 'C', name: '黑 + 一处橙', items: ['黑色高领毛衣', '黑色阔腿裤', '橙色羊毛围巾', '黑色短靴'], palette: ['#141213', '#ff7a1a', '#3a3837'],
    why: '傍晚只剩灯笼的暖光，全黑把人收进夜色里，只留围巾一处橙色和灯笼呼应。', avoid: '亮白（夜景会过曝）', spots: ['P6'], change: { at: 16 * 60 + 5, where: '祇园住处' } },
];
export const MODEL = { name: '林屿', height: 168, note: '素人模特，第一次外拍：引导词要具体到动作，少用「自然一点」。' };

const M = (h: number, m = 0) => h * 60 + m;
const trees = (x0: number, z0: number, dx: number, dz: number, n: number, h = 6): Prim[] => Array.from({ length: n }, (_, i) => ({ x: x0 + dx * i, z: z0 + dz * i, w: 3.2, d: 3.2, h, kind: 'tree' as const }));
export const SPOTS: Spot[] = [
  { id: 'P1', no: 1, name: '哲学之道 · 晨光逆光', area: '左京区 · 若王子以北', x: 806, y: 300, kind: 'portrait', start: M(7, 10), dur: 40, dir: 105, fov: 24, dist: 7,
    lens: '85mm', ap: 'f/2', ss: '1/640', iso: 'ISO 200',
    horizon: { from: 50, to: 170, alt: 10, note: '东山挡住了低角度的太阳：日出 06:14，但这里见光约 07:05。' },
    crowd: 1, crowdNote: '7 点前后多是晨跑和遛狗的居民。', rules: ['小路窄，三脚架不要占道', '沿线是住宅区，清晨保持安静'],
    comp: '人放在左三分线，右边留出逆光的枫树；压低机位，让水渠成为引导线。',
    direct: [
      { line: '沿水渠慢慢往前走，不用看我，走到第三棵枫树停下。', pose: 'walk' },
      { line: '停下后右手轻轻碰一下枝叶，视线落在水面。', pose: 'touch' },
      { line: '我数到三，回头，嘴角放松，不用露齿笑。', pose: 'look-back' },
      { line: '把开衫往左肩拢一下，让光从肩膀透过来。', pose: 'stand' },
    ],
    prompt: 'portrait of a young woman in a cream knit cardigan walking along a stone canal path in Kyoto, maple leaves backlit by low morning sun, rim light, 85mm, f/2, shallow depth of field, soft haze, autumn, film tone',
    look: 'A', scene: [{ x: -2.2, z: 0, w: 1.6, d: 70, h: .05, kind: 'water' }, { x: 0, z: 0, w: 2.4, d: 70, h: .02, kind: 'path' }, ...trees(3.5, -24, 0, 7, 8, 7), ...trees(-4.6, -20, 0, 9, 5, 6), { x: -11, z: -6, w: 7, d: 9, h: 6, kind: 'building' }, { x: -11, z: 10, w: 7, d: 8, h: 5, kind: 'building' }, { x: 118, z: 0, w: 30, d: 140, h: 21, kind: 'hill' }] },
  { id: 'P2', no: 2, name: '银阁寺 · 向月台与银沙滩', area: '左京区 · 银阁寺', x: 846, y: 118, kind: 'landscape', start: M(8, 30), dur: 40, dir: 70, fov: 74, dist: 14,
    lens: '24mm', ap: 'f/8', ss: '1/200', iso: 'ISO 100',
    crowd: 2, crowdNote: '8:30 开门后半小时内人最少，9 点后团客进来。', rules: ['寺内禁止三脚架', '寺内不安排人像，只拍风光', '开放时间以寺方公告为准'],
    comp: '向月台放在前景下三分之一，观音殿和后山的红叶做背景，水平线压低。',
    direct: [], prompt: 'Ginkaku-ji silver sand garden and Kogetsudai sand cone in the foreground, Kannon-den pavilion, autumn maples on the hill behind, soft morning side light, 24mm, f/8, wide, calm',
    scene: [{ x: 0, z: 0, w: 22, d: 12, h: .4, kind: 'sand' }, { x: -4, z: -2, w: 3.5, d: 3.5, h: 1.8, kind: 'sand' }, { x: 12, z: -8, w: 8, d: 6, h: 7, kind: 'building' }, ...trees(4, -16, 4, 0, 6, 8), { x: 30, z: -20, w: 40, d: 30, h: 26, kind: 'hill' }] },
  { id: 'P3', no: 3, name: '南禅寺 · 水路阁', area: '左京区 · 南禅寺', x: 862, y: 470, kind: 'portrait', start: M(10, 20), dur: 40, dir: 200, fov: 54, dist: 4.5,
    lens: '35mm', ap: 'f/2.8', ss: '1/400', iso: 'ISO 100',
    crowd: 4, crowdNote: '10 点后旅行团多：利用拱的纵深把人群虚化，或等两批人之间的空档。', rules: ['砖墙是文物，不要倚靠拍摄', '不挡游客通行'],
    comp: '沿拱廊的纵深拍，人站在第二个拱下；重复的拱是引导线，最远处留一点亮。',
    direct: [
      { line: '站在第二个拱下，离砖柱一拳远，一只脚尖点地。', pose: 'stand' },
      { line: '看向拱外的光，下巴微微抬一点。', pose: 'look-back' },
      { line: '慢慢从拱的阴影里走到光里，我会连拍。', pose: 'walk' },
      { line: '双手插风衣口袋，肩膀往下沉，呼一口气。', pose: 'pockets' },
    ],
    prompt: 'young woman in a navy long trench coat under the red brick aqueduct arches of Nanzen-ji Suirokaku, repeating arches as leading lines, soft side light, 35mm, f/2.8, autumn foliage, cinematic',
    look: 'B', backup: { name: '南禅寺三门回廊下', why: '下雨时有屋檐，木构的纵深也能替代拱廊。' },
    scene: [...Array.from({ length: 7 }, (_, i): Prim => ({ x: -1.8, z: -6 + i * 5, w: 1.4, d: 1.4, h: 7, kind: 'wall' })), ...Array.from({ length: 7 }, (_, i): Prim => ({ x: 3.2, z: -6 + i * 5, w: 1.4, d: 1.4, h: 7, kind: 'wall' })), { x: .7, z: 9, w: 6.4, d: 34, h: 2, y: 7, kind: 'wall' }, ...trees(-8, -4, 0, 8, 4, 8), ...trees(9, -2, 0, 9, 3, 7)] },
  { id: 'P4', no: 4, name: '蹴上 · 倾斜铁道', area: '左京区 · 蹴上', x: 812, y: 556, kind: 'portrait', start: M(13, 20), dur: 40, dir: 320, fov: 15, dist: 14,
    lens: '135mm', ap: 'f/2.8', ss: '1/800', iso: 'ISO 100',
    crowd: 3, crowdNote: '樱花季以外人不算多，但铁轨上常有人拍照，长焦压缩时注意背景里的人。', rules: ['不要占用铁轨正中太久', '注意脚下枕木间隙'],
    comp: '站在下坡往上拍，135mm 把铁轨和两侧树压缩在一起；人走在左边那条轨上。',
    direct: [
      { line: '踩着左边的铁轨走，双手张开保持平衡，慢一点。', pose: 'walk' },
      { line: '停下，转身面对我，风衣下摆让它被风吹起来。', pose: 'stand' },
      { line: '坐在枕木上，手肘撑膝盖，看铁轨尽头。', pose: 'step' },
    ],
    prompt: 'woman in a navy trench coat balancing on old railway tracks of the Keage Incline in Kyoto, telephoto compression, autumn trees on both sides, overcast soft light, 135mm, f/2.8, muted colors',
    look: 'B', backup: { name: '琵琶湖疏水纪念馆', why: '14 点前后有阵雨可能：室内有砖拱和水闸，可以换成静态人像。' },
    scene: [{ x: -.7, z: 0, w: .15, d: 80, h: .2, kind: 'rail', rot: 0 }, { x: .7, z: 0, w: .15, d: 80, h: .2, kind: 'rail', rot: 0 }, { x: 3.2, z: 0, w: .15, d: 80, h: .2, kind: 'rail' }, { x: 4.6, z: 0, w: .15, d: 80, h: .2, kind: 'rail' }, { x: 2, z: 0, w: 7, d: 80, h: .03, kind: 'path' }, ...trees(-4.5, -30, 0, 7, 9, 7), ...trees(8.5, -28, 0, 8, 8, 7)] },
  { id: 'P5', no: 5, name: '冈崎疏水 · 大鸟居倒影', area: '左京区 · 冈崎', x: 640, y: 432, kind: 'landscape', start: M(15, 10), dur: 30, dir: 0, fov: 62, dist: 30,
    lens: '24–70mm', ap: 'f/8', ss: '1/250', iso: 'ISO 100',
    crowd: 2, crowdNote: '桥上行人多，岸边台阶相对空。', rules: ['不要越过护栏下到水边'],
    comp: '鸟居放在画面中线，疏水的水面占下半部分拍倒影；等十石舟经过时再按一次。',
    direct: [], prompt: 'giant vermilion torii of Heian Shrine reflected in the Okazaki canal, calm water, autumn trees, late afternoon side light, 35mm, f/8, symmetrical composition',
    scene: [{ x: 0, z: 10, w: 80, d: 12, h: .05, kind: 'water' }, { x: -8, z: -14, w: 1.6, d: 1.6, h: 22, kind: 'torii' }, { x: 8, z: -14, w: 1.6, d: 1.6, h: 22, kind: 'torii' }, { x: 0, z: -14, w: 24, d: 1.6, h: 1.4, y: 19, kind: 'torii' }, { x: 0, z: -14, w: 20, d: 1.2, h: 1, y: 16, kind: 'torii' }, ...trees(-30, 2, 8, 0, 8, 6), { x: -26, z: -30, w: 18, d: 14, h: 14, kind: 'building' }, { x: 26, z: -30, w: 18, d: 14, h: 12, kind: 'building' }] },
  { id: 'P6', no: 6, name: '祇园白川 · 巽桥', area: '东山区 · 祇园', x: 486, y: 610, kind: 'portrait', start: M(16, 35), dur: 55, dir: 260, fov: 40, dist: 5,
    lens: '50mm', ap: 'f/1.4', ss: '1/250', iso: 'ISO 400 → 1600',
    crowd: 5, crowdNote: '热门地点，傍晚婚纱和游客很多：动作要快，不要挡路。', rules: ['祇园部分私道禁止拍摄，只在公共道路拍（出发前核实最新告示）', '不要追拍或拦住舞伎、艺伎', '不在店门口停留'],
    comp: '人在桥栏边，背后是亮灯的町家；金色时刻用西边的余光做轮廓，蓝调时刻改用灯笼做主光。',
    direct: [
      { line: '倚在巽桥栏杆，身体侧向河，让围巾的橙色朝镜头。', pose: 'lean' },
      { line: '看对岸的灯笼，等它亮的那一下。', pose: 'stand' },
      { line: '双手把围巾往上拉到下巴，眼睛看我。', pose: 'scarf' },
      { line: '沿石板路朝我走过来，步子比平时慢一半。', pose: 'walk' },
    ],
    prompt: 'woman in a black turtleneck with an orange wool scarf on Tatsumi bridge, Gion Shirakawa at blue hour, paper lanterns glowing, wet stone pavement, willow, 50mm, f/1.4, moody, minimal palette black and orange',
    look: 'C', backup: { name: '白川南通 · 有屋檐的町家前', why: '下雨时灯笼倒影反而更好，人站在檐下。' },
    scene: [{ x: 0, z: 2.5, w: 60, d: 3, h: .05, kind: 'water' }, { x: 0, z: -1, w: 60, d: 3.2, h: .02, kind: 'path' }, { x: -3, z: 2.5, w: 3, d: 4.5, h: .5, kind: 'wall' }, ...Array.from({ length: 6 }, (_, i): Prim => ({ x: -22 + i * 8, z: -7, w: 7, d: 6, h: 6.5, kind: 'building' })), ...Array.from({ length: 6 }, (_, i): Prim => ({ x: -21 + i * 8, z: -3.6, w: .5, d: .5, h: .7, y: 2.2, kind: 'lantern' })), { x: 5, z: 5.5, w: 3.6, d: 3.6, h: 7, kind: 'tree' }] },
];

/** 逐时天气（模拟预报）。 */
export type Hour = { h: number; t: number; cloud: number; rain: number; wind: number; cond: '晴' | '少云' | '多云' | '阵雨' };
export const WEATHER: Hour[] = [
  [6, 9, 10, 0, 1], [7, 10, 10, 0, 1], [8, 12, 15, 0, 2], [9, 14, 20, 0, 2], [10, 16, 25, 0, 2], [11, 18, 35, 5, 3], [12, 19, 45, 10, 3],
  [13, 19, 60, 20, 3], [14, 18, 75, 35, 4], [15, 17, 60, 20, 3], [16, 16, 35, 5, 2], [17, 14, 20, 0, 2], [18, 13, 15, 0, 1], [19, 12, 10, 0, 1],
].map(([h, t, cloud, rain, wind]) => ({ h, t, cloud, rain, wind, cond: rain >= 30 ? '阵雨' : cloud >= 55 ? '多云' : cloud >= 25 ? '少云' : '晴' }));

export const PLANS = [
  { id: 'X-061', name: '东山 · 秋日人像', state: '计划中', date: DATE_LABEL },
  { id: 'X-062', name: '岚山 · 晨雾风光', state: '草稿', date: '11-03' },
  { id: 'X-063', name: '伏见稻荷 · 夜拍', state: '草稿', date: '11-05' },
  { id: 'X-064', name: '城市漫步 · 街拍', state: '草稿', date: '未定' },
];
export const GEAR = ['机身 ×1 + 备用电池 ×3', '24mm f/1.4 · 35mm f/1.4 · 50mm f/1.2 · 85mm f/1.8 · 135mm f/1.8', '小反光板（金 / 白）', '偏振镜 · 雨衣罩', '模特：暖宝宝、折叠伞、换装用的小镜子'];

/** 太阳在某机位、某时刻：考虑山影遮挡。 */
export function sunFor(s: Spot, t: number) {
  const p = sunAt(DATE, t);
  const blocked = !!s.horizon && p.az >= s.horizon.from && p.az <= s.horizon.to && p.alt < s.horizon.alt && p.alt > 0;
  return { ...p, blocked };
}
/** 机位之间的步行时间（示意：按地图距离估算）。 */
export const walk = (a: Spot, b: Spot) => Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 4 / 75);

/* ———— 现场：模拟拍摄当天发生的事（回顾面用） ———— */
export type Note = { at: number; spot?: string; text: string; tag: '光线' | '人流' | '服饰' | '天气' | '规定' | '机位' };
export const NOTES: Note[] = [
  { at: M(7, 6), spot: 'P1', text: '太阳还没翻过东山，等到 07:18 才有逆光。', tag: '光线' },
  { at: M(7, 32), spot: 'P1', text: '米白开衫逆光透得很好，第三棵枫树那里最干净。', tag: '服饰' },
  { at: M(8, 52), spot: 'P2', text: '9 点前团客进来，向月台前三分钟没人。', tag: '人流' },
  { at: M(10, 34), spot: 'P3', text: '水路阁旅行团一批接一批，拱下要等两分钟空档。', tag: '人流' },
  { at: M(10, 50), spot: 'P3', text: '藏青风衣在红砖前很稳，B 套对。', tag: '服饰' },
  { at: M(13, 58), spot: 'P4', text: '14:00 起开始下阵雨，铁道只拍了三组，转去疏水纪念馆。', tag: '天气' },
  { at: M(14, 40), text: '疏水纪念馆的砖拱可以当水路阁的「室内版」。', tag: '机位' },
  { at: M(16, 48), spot: 'P6', text: '白川南通有「私道禁止摄影」告示，挪到公共段拍。', tag: '规定' },
  { at: M(17, 16), spot: 'P6', text: '灯笼 17:15 亮，ISO 1600 还干净；橙色围巾在夜里很跳。', tag: '光线' },
];
/** 回顾：实际拍到的照片（按机位，坐标会在地图上落点）。 */
export type Shot = { id: string; spot: string; at: number; x: number; y: number; seed: number; rating: 0 | 1 | 2 | 3; pick?: boolean };
export const SHOTS: Shot[] = SPOTS.flatMap(s => {
  const n = s.id === 'P4' ? 3 : s.kind === 'portrait' ? 6 : 3;
  return Array.from({ length: n }, (_, i): Shot => ({ id: `${s.id}-${i + 1}`, spot: s.id, at: s.start + 8 + i * Math.round(s.dur / n), x: s.x + Math.round(Math.sin(i * 2.4 + s.no) * 10), y: s.y + Math.round(Math.cos(i * 1.7 + s.no) * 8), seed: s.no * 97 + i * 13, rating: ((i * 7 + s.no) % 4) as 0 | 1 | 2 | 3, pick: (i + s.no) % 3 === 0 }));
}).concat([{ id: 'B-1', spot: 'backup', at: M(14, 30), x: 768, y: 520, seed: 911, rating: 3, pick: true }, { id: 'B-2', spot: 'backup', at: M(14, 42), x: 772, y: 524, seed: 917, rating: 2 }]);
export const ACTUAL: Record<string, [number, number] | null> = { P1: [M(7, 18), M(7, 55)], P2: [M(8, 32), M(9, 5)], P3: [M(10, 28), M(11, 6)], P4: [M(13, 30), M(13, 58)], P5: null, P6: [M(16, 45), M(17, 34)] };
