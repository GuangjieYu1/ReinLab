/**
 * 时间标签与「写回原文写法」（服务端生成修法要用它把 t 变回作者能再解析的写法）。
 *
 * 只做显示与格式化：判定一律在 check.ts / allen.ts 里，不在这里做。
 */

import type { Calendar } from '@reinlab/contracts';
import { gregorianLabel, inputForT, labelFor } from './story-time';

export { boundsOf } from './story-time';

export type Labels = { say: (t: number) => string; input: (t: number) => string; calendar: string };

export function labelsOf(calendars: Calendar[], calendar?: string): Labels {
  const id =
    calendar && calendars.some((item) => item.id === calendar)
      ? calendar
      : (calendars.find((item) => item.kind === 'gregorian')?.id ?? calendars[0]?.id ?? 'gregorian');
  return {
    calendar: id,
    say: (t: number) => labelFor(t, id, calendars),
    input: (t: number) => inputForT(t, id, calendars),
  };
}

export { gregorianLabel };

/**
 * 枚举值一律翻成中文再给页面（1A 遗留 5）：检查文字和修法预览里不要出现
 * 「（region）」「fact → flashback」这种原值。
 */
export const PLACE_LEVEL_LABEL: Record<string, string> = {
  world: '世界', region: '区域', city: '城市', site: '场所', building: '建筑', floor: '楼层', room: '房间',
};
export const NARRATIVE_LABEL: Record<string, string> = {
  fact: '事实', hearsay: '传闻', dream: '梦境', hypothetical: '假设', flashback: '回忆',
};
export const PARTICIPATION_LABEL: Record<string, string> = {
  actor: '主事', present: '在场', remote: '远程', mentioned: '被提及',
};
export const placeLevelLabel = (level: string): string => PLACE_LEVEL_LABEL[level] ?? level;
export const narrativeLabel = (value: string): string => NARRATIVE_LABEL[value] ?? value;
export const participationLabel = (value: string): string => PARTICIPATION_LABEL[value] ?? value;
