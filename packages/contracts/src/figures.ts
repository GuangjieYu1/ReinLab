/**
 * 人偶衣色与颜色名（契约 §13.9 / §14.7）：前后端共用。
 * 前端：取选用立绘中段不太亮的像素平均色；没有立绘按 id 分固定色。
 * 服务端：用 ffmpeg 把立绘缩到 48×72 取同一区域的平均色，算法保持一致。
 */

export type RGB = [number, number, number];

export const CLOTH_PALETTE: RGB[] = [
  [98, 120, 138],
  [146, 92, 74],
  [104, 124, 92],
  [128, 104, 140],
  [150, 128, 84],
  [86, 108, 116],
];

/** 没有立绘时按 id 分一个固定色（和前端同一规则）。 */
export function fallbackClothColor(id: string, index = 0): RGB {
  return CLOTH_PALETTE[[...id].reduce((sum, char) => sum + char.charCodeAt(0), index) % CLOTH_PALETTE.length]!;
}

/** 颜色 → 中文说法（提示词里写「灰绿」「蓝灰」这种）。 */
export function colorName(rgb: RGB): string {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (r + g + b) / 3;
  if (max - min < 18) return light < 90 ? '深灰' : light > 180 ? '浅灰' : '灰色';
  const hue = (() => {
    if (max === r) return ((g - b) / (max - min) + 6) % 6;
    if (max === g) return (b - r) / (max - min) + 2;
    return (r - g) / (max - min) + 4;
  })() * 60;
  const names: [number, string][] = [
    [15, '红'], [40, '橙'], [65, '黄'], [95, '黄绿'], [150, '绿'], [185, '青绿'], [210, '青'], [250, '蓝'], [290, '蓝紫'], [330, '紫'], [360, '红'],
  ];
  const name = names.find(([limit]) => hue < limit)?.[1] ?? '红';
  const tone = light < 80 ? '深' : light > 175 ? '浅' : min > 60 && max - min < 60 ? '灰' : '';
  return `${tone}${name}`;
}
