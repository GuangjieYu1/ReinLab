/**
 * 轨迹（design/prd/20-creative-contract.md §1「轨迹」）。
 *
 * 只按服务端算出来的东西拼：事件的在场段、相邻事件之间的行程段、死亡之后变灰。
 * 位置未定就是 unknown 段（不画点），路线算不出来也走 unknown，绝不编一段直线。
 * 前端只做一件事：move 段里按时间比例沿 leg.path 取点。
 */

import type { CreativeRouteLeg, Track, WorldEvent } from '@reinlab/contracts';
import { boundsOf } from './story-time';
import { pointOf } from './routing';
import { legIdFor, type CreativeDocument } from './world';

export type TrackRange = { from: number | null; to: number | null };

const inside = (range: TrackRange, t0: number, t1: number) =>
  (range.to === null || t0 <= range.to) && (range.from === null || t1 >= range.from);

export function buildTracks(
  document: CreativeDocument,
  legs: CreativeRouteLeg[],
  range: TrackRange,
  entityIds?: string[],
  options?: { /** 预览用：提议带来的死后事件也照常排进轨迹（冲突照样报）。 */ ignoreDeath?: boolean },
): Track[] {
  const tracks: Track[] = [];
  for (const entity of document.entities) {
    if (entity.kind !== 'person') continue;
    if (entityIds?.length && !entityIds.includes(entity.id)) continue;
    const events = document.events
      .filter((event) => event.participants.some((item) => item.entityId === entity.id))
      .map((event) => ({ event, start: boundsOf(event.start).start, end: boundsOf(event.end).end }))
      .sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));

    const spans: Track['spans'] = [];
    for (const [index, item] of events.entries()) {
      spans.push(...spansOfEvent(document, item.event, item.start, item.end));
      const nextItem = events[index + 1];
      if (!nextItem) continue;
      const t0 = item.end;
      const t1 = nextItem.start;
      if (t0 === null || t1 === null || t1 <= t0) continue;
      const leg = legs.find((candidate) => candidate.id === legIdFor(entity.id, item.event.id, nextItem.event.id));
      const legId = leg?.id ?? legIdFor(entity.id, item.event.id, nextItem.event.id);
      if (leg && leg.kind !== 'none') {
        spans.push({ kind: 'move', t0, t1, legId, routeKind: leg.kind });
      } else {
        spans.push({
          kind: 'unknown',
          t0,
          t1,
          why: leg?.failure ?? '这段路上没有可用的路线',
        });
      }
    }

    const deathEventId = entity.person?.died ?? null;
    const deathEvent = deathEventId ? document.events.find((event) => event.id === deathEventId) : undefined;
    const deathT = options?.ignoreDeath ? null : deathEvent ? boundsOf(deathEvent.start).start : null;

    const clipped: Track['spans'] = [];
    for (const span of spans) {
      const t0 = span.t0;
      if (deathT !== null && t0 >= deathT) continue;
      const t1 = 't1' in span ? span.t1 : span.t0;
      if (!inside(range, t0, deathT !== null ? Math.min(t1, deathT) : t1)) continue;
      clipped.push(span);
    }
    if (deathT !== null && inside(range, deathT, deathT)) clipped.push({ kind: 'dead', t0: deathT });

    // 两件事之间什么都没记的时间段：位置未定，页面那一段不画点。
    const sorted = [...clipped].sort((a, b) => a.t0 - b.t0);
    const filled: Track['spans'] = [];
    let cursor: number | null = null;
    for (const span of sorted) {
      if (cursor !== null && span.t0 > cursor) filled.push({ kind: 'unknown', t0: cursor, t1: span.t0, why: '这段时间没有记录' });
      filled.push(span);
      const end = 't1' in span ? span.t1 : span.t0;
      cursor = cursor === null ? end : Math.max(cursor, end);
    }
    tracks.push({ entityId: entity.id, spans: filled });
  }
  return tracks;
}

function spansOfEvent(
  document: CreativeDocument,
  event: WorldEvent,
  start: number | null,
  end: number | null,
): Track['spans'] {
  if (start === null || end === null)
    return [{ kind: 'unknown', t0: start ?? end ?? 0, t1: end ?? start ?? 0, why: '这条事件的时间未定' }];
  const place = event.placeId ? document.entities.find((item) => item.id === event.placeId) : undefined;
  const at = pointOf(place?.place?.geo);
  if (!place || !at) return [{ kind: 'unknown', t0: start, t1: end, why: place ? '这个地点没有坐标' : '这条事件没写地点' }];
  return [{ kind: 'at', t0: start, t1: end, eventId: event.id, placeId: place.id, at }];
}
