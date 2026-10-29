// 档案的单一入口：选 mock / live 适配器，提供列表 hook（变化通知 + 15 秒兜底刷新）。
import { useCallback, useEffect, useState } from 'react';
import { backendMode } from '../../backendMode';
import { liveDossierAdapter } from '../../data/dossier-live';
import type { BenchId, DossierAdapter, DossierSummary } from './adapter';
import { mockDossierAdapter } from './mockDossiers';

let shared: DossierAdapter | null = null;
export const dossiers = (): DossierAdapter => (shared ??= backendMode === 'live' ? liveDossierAdapter() : mockDossierAdapter());

/** 某个台的档案列表。via='user' 只在用户主动打开 / 搜索时传（服务端记一条轻量操作），自动刷新不传。 */
export function useBenchDossiers(bench: BenchId | null, opts: { q?: string; view?: 'active' | 'archived' } = {}) {
  const [items, setItems] = useState<DossierSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((via?: 'user') => {
    if (!bench) return Promise.resolve();
    return dossiers().list(bench, { ...opts, via }).then(v => { setItems(v); setError(null); }, (e: Error) => setError(e.message));
  }, [bench, opts.q, opts.view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!bench) return;
    void load('user');
    const off = dossiers().subscribe(bench, e => { if (e.type !== 'activity') void load(); });
    const t = window.setInterval(() => void load(), 15000);
    return () => { off(); window.clearInterval(t); };
  }, [bench, load]);
  return { items, error, reload: load };
}

/** 相对时间：刚刚 / 5 分钟前 / 今天 09:12 / 10月28日。 */
export function when(iso: string) {
  const t = new Date(iso), d = Date.now() - t.getTime();
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.round(d / 60e3)} 分钟前`;
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (new Date().toDateString() === t.toDateString()) return `今天 ${hm}`;
  return `${t.getMonth() + 1}月${t.getDate()}日`;
}
