// 十种姿势小人的 SVG 路径（09-explore-v2.md 第 8 节）。页面和计划书 PDF 共用这一份，改这里两边一起变。
// 画法：viewBox 0 0 40 50，只描边不填充（stroke 墨色、线宽 2、圆头圆角），头部是 a4 4 的小圆。
import type { Pose } from './explore';

export const POSE_VIEWBOX = '0 0 40 50';
export const POSE_PATHS: Record<Pose, string> = {
  walk: 'M20 8 a4 4 0 1 0 0.1 0 M20 16 L19 32 M19 20 L12 27 M19 20 L27 25 M19 32 L13 46 M19 32 L26 45',
  'look-back': 'M23 8 a4 4 0 1 0 0.1 0 M21 16 L19 32 M20 20 L14 28 M20 20 L25 27 M19 32 L15 46 M19 32 L23 46 M26 9 L30 8',
  lean: 'M16 8 a4 4 0 1 0 0.1 0 M17 16 L21 32 M18 20 L28 24 M18 20 L12 26 M21 32 L17 46 M21 32 L25 46 M30 16 L30 46',
  touch: 'M18 8 a4 4 0 1 0 0.1 0 M18 16 L18 32 M18 20 L28 13 M18 20 L13 28 M18 32 L15 46 M18 32 L22 46 M30 6 C 33 9 33 14 29 16',
  pockets: 'M20 8 a4 4 0 1 0 0.1 0 M20 16 L20 32 M20 20 L14 26 L17 31 M20 20 L26 26 L23 31 M20 32 L16 46 M20 32 L24 46',
  scarf: 'M20 8 a4 4 0 1 0 0.1 0 M20 16 L20 32 M20 20 L15 23 L19 13 M20 20 L25 23 L21 13 M20 32 L17 46 M20 32 L23 46',
  step: 'M16 16 a4 4 0 1 0 0.1 0 M17 24 L19 36 M18 27 L26 31 M18 27 L24 33 M19 36 L29 37 L29 46 M19 36 L14 46 M6 46 H34',
  stand: 'M20 8 a4 4 0 1 0 0.1 0 M20 16 L20 32 M20 20 L14 30 M20 20 L26 30 M20 32 L17 46 M20 32 L23 46',
  // 坐：上身直、大腿水平、小腿垂直，下面一条凳面
  sit: 'M17 12 a4 4 0 1 0 0.1 0 M17 20 L17 33 M17 24 L11 31 M17 24 L24 30 M17 33 L28 33 L28 46 M9 35 H21 M10 35 V46 M20 35 V46',
  // 蹲：膝盖折到胸前
  squat: 'M18 18 a4 4 0 1 0 0.1 0 M18 26 L20 36 M19 29 L27 33 M19 29 L13 34 M20 36 L28 38 L24 46 M20 36 L14 40 L16 46 M6 46 H34',
};
export const POSE_LABEL: Record<Pose, string> = { walk: '走', 'look-back': '回头', lean: '靠', touch: '扶', pockets: '插兜', scarf: '拢围巾', step: '迈步', stand: '站', sit: '坐', squat: '蹲' };

