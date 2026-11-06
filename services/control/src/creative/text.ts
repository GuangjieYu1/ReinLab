/**
 * 文字处理的小工具（1A 遗留 2）。
 *
 * AI 写的依据、来源标题、失败原因都要截断长度，但必须按字符（码点）截：
 * 按 UTF-16 单元或字节截会把一个汉字/一个表情切成两半，存进库就是「O��M」。
 */

/** 按字符截断；不会切出半个字。max 以字符计（不是字节）。 */
export function clip(value: unknown, max: number): string {
  const text = String(value ?? '');
  if (!Number.isFinite(max) || max <= 0) return '';
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max).join('');
}
