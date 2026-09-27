/** Reference clip checkpoints (seconds). Results are visual examples, not training output. */
export const SCENE_DURATION = 10;
export const sceneGroups = ['architecture', 'optimizer', 'schedule'] as const;
export const groupCenters = [490, 730, 970];
export const sceneEvents = [
  { at: 0, lane: 0, agent: 1, result: 'REJECT', score: 0.4312 },
  { at: 0, lane: 1, agent: 4, result: 'REJECT', score: 0.4371 },
  { at: 0, lane: 2, agent: 7, result: 'KEEP', score: 0.4480 },
  { at: 1.5, lane: 1, agent: 5, result: 'REJECT', score: 0.4391 },
  { at: 2.5, lane: 0, agent: 2, result: 'REJECT', score: 0.4423 },
  { at: 3.5, lane: 2, agent: 8, result: 'REJECT', score: 0.4462 },
  { at: 4.5, lane: 1, agent: 6, result: 'REJECT', score: 0.4435 },
  { at: 5.4, lane: 0, agent: 3, result: 'REJECT', score: 0.4442 },
  { at: 5.5, lane: 2, agent: 9, result: 'KEEP', score: 0.4526 },
  { at: 7.2, lane: 2, agent: 7, result: 'REJECT', score: 0.4492 },
] as const;
export function sceneAt(seconds: number) {
  const time = Math.max(0, Math.min(SCENE_DURATION, Number.isFinite(seconds) ? seconds : 0));
  const events = sceneEvents.filter(event => event.at <= time);
  // The slip appears before its result is written back to the shared state.
  const kept = events.filter(event => event.result === 'KEEP' && event.at + 1.3 <= time);
  return { time, events, kept, champion: kept.at(-1), deadLanes: [time >= 7.2, false, time >= 8.4],
    phase: time < 1.3 ? '并行探索' : time < 6.8 ? '实验结果写回共享状态' : time < 8.4 ? '记录研究结论' : '返回讨论，保留反例' };
}
export function agentPosition(index: number, time: number) {
  const lane = Math.floor(index / 3), slot = index % 3;
  const home = { x: groupCenters[lane] - 47 + slot * 47, y: 463 };
  const departure = [7.2, 8.0, 8.4][lane] + slot * .2;
  if (time < departure) return home;
  const angle = (-155 + index * 38) * Math.PI / 180;
  return { x: 742 + Math.cos(angle) * 288, y: 242 + Math.sin(angle) * 91 };
}
