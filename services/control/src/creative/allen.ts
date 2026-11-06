/**
 * Allen 区间关系（design/prd/19-creative.md §4：首期用时间区间关系加路网路程）。
 *
 * 只算能确定的关系：任何一端未知就返回 null，由调用方记成「信息不足」，
 * 不按 0 处理，也不拿「没查到」当「没冲突」。
 */

export type Interval = { start: number; end: number };

export type AllenRelation =
  | 'before'
  | 'meets'
  | 'overlaps'
  | 'starts'
  | 'during'
  | 'finishes'
  | 'equals'
  | 'finished_by'
  | 'contains'
  | 'started_by'
  | 'overlapped_by'
  | 'met_by'
  | 'after';

export function allen(a: Interval, b: Interval): AllenRelation {
  if (a.end < b.start) return 'before';
  if (a.end === b.start) return 'meets';
  if (a.start === b.start && a.end === b.end) return 'equals';
  if (a.start === b.start && a.end < b.end) return 'starts';
  if (a.start === b.start && a.end > b.end) return 'started_by';
  if (a.end === b.end && a.start > b.start) return 'finishes';
  if (a.end === b.end && a.start < b.start) return 'finished_by';
  if (a.start > b.start && a.end < b.end) return 'during';
  if (a.start < b.start && a.end > b.end) return 'contains';
  if (a.start < b.start && a.end > b.start && a.end < b.end) return 'overlaps';
  if (a.start > b.start && a.start < b.end && a.end > b.end) return 'overlapped_by';
  if (a.start === b.end) return 'met_by';
  return 'after';
}

/** 两个区间有没有重叠的时间（含端点相接）。 */
export function overlapsAtAll(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** 重叠的那一段时间。没有重叠返回 null。 */
export function overlapOf(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start <= end ? { start, end } : null;
}

export function minutesToHuman(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  const days = Math.floor(value / 1440);
  const hours = Math.floor((value % 1440) / 60);
  const rest = value % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (rest || parts.length === 0) parts.push(`${rest} 分钟`);
  return parts.join(' ');
}
