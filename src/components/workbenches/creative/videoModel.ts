// 创作台 · 视频面的白模场景与机位（纯前端示例）。单位约为米，y 向上。
// 参照 Intangible 的 Build → Compose → Visualize：一句话搭白模 → 助手摆机位写分镜 → 预览成片（占位）。

export type V3 = [number, number, number];
/** 白模基本体：c 是底面中心；box 的 s 为长宽高；prism（多棱柱）s[0] 为半径、s[1] 为高（axis z 时为厚度）。 */
export type Prim = { id: string; kind: 'box' | 'prism'; c: V3; s: V3; n?: number; axis?: 'y' | 'z'; rot?: number; g: number; accent?: boolean; label?: string };
export type Char = { id: string; name: string; p: V3; h: number; r: number; ref?: string };
export type Cam = { eye: V3; target: V3; fov: number; end?: V3 };
export type Light = '黄昏' | '正午';

export const SCENE_PROMPT = '黄昏的袋底洞：山坡上的圆门和两扇圆窗，门前一条小路、两块花圃和一道栅栏，一张长椅，一张放着红皮书的小桌；远处宴会场上有一棵瑁珑树。';
const post = (i: number): Prim => ({ id: `post${i}`, kind: 'box', c: [-5 + i * 2, 0, 2.2], s: [.14, .8, .14], g: .55 });
export const PRIMS: Prim[] = [
  { id: 'hill', kind: 'box', c: [0, 0, -4.2], s: [15, 3.2, 4.4], g: .32, label: '山坡' },
  { id: 'door', kind: 'prism', axis: 'z', c: [0, .15, -1.92], s: [.95, .25, 0], n: 16, g: .78, label: '圆门' },
  { id: 'win1', kind: 'prism', axis: 'z', c: [-3.4, 1.15, -1.95], s: [.48, .18, 0], n: 12, g: .7 },
  { id: 'win2', kind: 'prism', axis: 'z', c: [3.4, 1.15, -1.95], s: [.48, .18, 0], n: 12, g: .7 },
  { id: 'path', kind: 'box', c: [0, 0, .3], s: [1.3, .03, 4.4], g: .6 },
  { id: 'bed1', kind: 'box', c: [-3, 0, .4], s: [2.4, .32, 1.1], g: .44, label: '花圃' },
  { id: 'bed2', kind: 'box', c: [3, 0, .4], s: [2.4, .32, 1.1], g: .44 },
  ...Array.from({ length: 6 }, (_, i) => post(i)),
  { id: 'rail', kind: 'box', c: [0, .58, 2.2], s: [10.2, .08, .08], g: .55, label: '栅栏' },
  { id: 'bench', kind: 'box', c: [2.3, 0, -1.1], s: [1.5, .45, .48], g: .5, label: '长椅' },
  { id: 'table', kind: 'box', c: [-2.3, 0, -1.05], s: [.95, .74, .62], g: .52, label: '小桌' },
  { id: 'book', kind: 'box', c: [-2.3, .74, -1.05], s: [.34, .07, .25], g: .9, accent: true, label: '红皮书' },
  { id: 'trunk', kind: 'prism', c: [-7, 0, -13], s: [.42, 3, 0], n: 8, g: .4 },
  { id: 'crown', kind: 'prism', c: [-7, 2.6, -13], s: [2.5, 3.4, 0], n: 10, g: .58, label: '瑁珑树' },
];
export const CHARS: Char[] = [
  { id: 'sam', name: '山姆', p: [.7, 0, -.2], h: 1.1, r: .26, ref: 'sam' },
  { id: 'elanor', name: '伊拉诺', p: [-1.4, 0, .5], h: 1.08, r: .24, ref: 'elanor' },
  { id: 'messenger', name: '信使 · 占位', p: [1.3, 0, 1], h: 1.85, r: .27 },
];
/** 「自动摆机位」给每个镜头的机位：eye 起点、target 看向、fov 视角、end 运镜终点（固定镜头没有）。 */
export const AUTO_CAMS: Record<string, Cam> = {
  '镜 01': { eye: [0, 2.3, 10], target: [0, 1, -2], fov: 42, end: [0, 2, 7.4] },
  '镜 02': { eye: [3.6, 1.45, 3.2], target: [.9, 1, .4], fov: 36 },
  '镜 03': { eye: [1.2, 1.15, .75], target: [.65, .78, -.2], fov: 26 },
  '镜 04': { eye: [-3.4, 1.05, 2.6], target: [-1.4, .7, .4], fov: 36, end: [-1.5, 1.05, 3.2] },
  '镜 05': { eye: [-2, .9, -3.6], target: [-7, 2.6, -13], fov: 44, end: [-2, 4.2, -3.6] },
  '镜 06': { eye: [-2.3, 1.7, -.2], target: [-2.3, .78, -1.05], fov: 30, end: [-2.3, 1.22, -.62] },
};
export const LIGHTS0: Record<string, Light> = { '镜 01': '黄昏', '镜 02': '正午', '镜 03': '正午', '镜 04': '黄昏', '镜 05': '黄昏', '镜 06': '黄昏' };
export const DIALOGUE: Record<string, string> = { '镜 02': '信使：「船已经在灰港等着。」', '镜 03': '山姆（轻声）：「我知道。」', '镜 04': '伊拉诺：「斗篷补好了。」' };
export const PRICE = 2.4;
