/** 事件与规则的指纹：模型判规则的结果按它缓存，内容没变就不重复花钱。 */

import type { CreativeDocument } from './world';

export function fingerprintOf(document: CreativeDocument): string {
  const events = document.events
    .map((event) =>
      [
        event.id,
        event.title,
        event.start?.t ?? '',
        event.end?.t ?? '',
        event.placeId ?? '',
        event.narrative,
        event.participants.map((item) => item.entityId).join(','),
      ].join('|'),
    )
    .sort()
    .join('\n');
  const rules = document.rules.map((rule) => `${rule.id}|${rule.text}|${rule.machine ? rule.machine.kind : ''}`).join('\n');
  let hash = 0;
  for (const chunk of `${events}\n--\n${rules}`) hash = (hash * 31 + chunk.charCodeAt(0)) | 0;
  return `${document.events.length}:${document.rules.length}:${(hash >>> 0).toString(36)}`;
}
