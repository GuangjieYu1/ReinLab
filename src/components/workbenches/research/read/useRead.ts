import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
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
  if ((e.type === 'tool' || e.type === 'approval' || e.type === 'agent' || e.type === 'user' || e.type === 'pick') && l.some(x => x.type === e.type && x.id === e.id)) return l.map(x => (x.type === e.type && x.id === e.id ? e : x));
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
  const mounted = useRef(true);
  // 读取失败照实显示原因，不悄悄退回示例数据，也不一直转圈（F3）
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // 每次 effect 用自己的取消标记：卸载（或 StrictMode 二次执行）后才 resolve 的 load 不再订阅，避免留下没人关的事件流（Q-097）
    let active = true, off: (() => void) | null = null;
    mounted.current = true;
    setError(null);
    adapter.load().then(s => {
      if (!active) return;
      dispatch({ t: 'load', s });
      off = adapter.subscribe(e => { if (active) dispatch({ t: 'event', e }); });
    }).catch((e: unknown) => { if (active) setError(e instanceof Error && e.message ? e.message : '读取档案失败'); });
    return () => { active = false; mounted.current = false; off?.(); };
  }, [adapter, attempt]);
  const reload = useCallback(() => adapter.load().then(s => { if (mounted.current) dispatch({ t: 'load', s }); }), [adapter]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { state, reload, error, retry };
}
