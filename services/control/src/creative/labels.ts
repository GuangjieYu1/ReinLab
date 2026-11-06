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
