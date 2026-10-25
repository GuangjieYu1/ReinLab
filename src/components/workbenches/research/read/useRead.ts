import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ReadAdapter, ReadEvent, ReadSnapshot } from './readTypes';

// 把「快照 + 事件流」折叠成界面状态。mock 和 live 共用，所以两版界面不会走样。

export type ReadState = (ReadSnapshot & { log: ReadEvent[] }) | null;
type Action = { t: 'load'; s: ReadSnapshot } | { t: 'event'; e: ReadEvent } | { t: 'reset' };

const upsert = <T extends { id: string }>(list: T[], item: T) => {
  const i = list.findIndex(x => x.id === item.id);
  return i < 0 ? [...list, item] : list.map((x, k) => (k === i ? item : x));
};
/** 工具和审批按 id 更新同一行；其他事件追加。 */
const log = (l: ReadEvent[], e: ReadEvent) => {
  if ((e.type === 'tool' || e.type === 'approval' || e.type === 'agent' || e.type === 'user') && l.some(x => x.type === e.type && x.id === e.id)) return l.map(x => (x.type === e.type && x.id === e.id ? e : x));
  return [...l, e];
};

function reduce(s: ReadState, a: Action): ReadState {
  if (a.t === 'load') return { ...a.s, log: a.s.history };
  if (a.t === 'reset' || !s) return s;
  const e = a.e;
  switch (e.type) {
    case 'run': return { ...s, run: { ...s.run, ...e.run } };
    case 'paper': return { ...s, paper: e.paper };
    case 'section': return s.paper ? { ...s, paper: { ...s.paper, sections: upsert(s.paper.sections, e.section) } } : s;
    case 'layer': return { ...s, layers: upsert(s.layers, e.layer) };
    case 'quiz': return { ...s, quizzes: upsert(s.quizzes, e.quiz) };
    case 'finding': return { ...s, findings: upsert(s.findings, e.finding) };
    default: return { ...s, log: log(s.log, e) };
  }
}

export function useRead(adapter: ReadAdapter) {
  const [state, dispatch] = useReducer(reduce, null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    let off = () => {};
    adapter.load().then(s => { if (!live.current) return; dispatch({ t: 'load', s }); off = adapter.subscribe(e => live.current && dispatch({ t: 'event', e })); });
    return () => { live.current = false; off(); };
  }, [adapter]);
  const reload = useCallback(() => adapter.load().then(s => live.current && dispatch({ t: 'load', s })), [adapter]);
  return { state, reload };
}
