// 现场定位（09-explore-v2.md 第 4.1 节）：用户开启才用；离开现场 / 页面隐藏 / 锁定就停；只在内存，不存连续轨迹。
import { useEffect, useState } from 'react';
import type { LngLat, Stop } from '../../../../../../packages/contracts/src/explore';
import { center } from '../overlays';
import { inside, meters } from './gcj';

export const ARRIVE_M = 50;

export type Fix = { at: LngLat; accuracyM: number; time: number };

export function useFieldLocation(enabled: boolean) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => { const on = () => setHidden(document.hidden); document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on); }, []);
  useEffect(() => {
    if (!enabled || hidden) return;
    if (!('geolocation' in navigator)) { setError('这台设备不能定位，请手动切换'); return; }
    const id = navigator.geolocation.watchPosition(
      p => { setError(null); setFix({ at: [p.coords.longitude, p.coords.latitude], accuracyM: p.coords.accuracy, time: p.timestamp }); },
      e => setError(e.code === e.PERMISSION_DENIED ? '没有定位权限，请手动切换' : '暂时定不到位，请手动切换'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled, hidden]);
  useEffect(() => { if (!enabled) setFix(null); }, [enabled]);   // 关掉就不留位置
  return { fix: enabled ? fix : null, error: enabled ? error : null, paused: enabled && hidden };
}

/**
 * 到了哪个点：固定点 / 顺路点按 50 米，街区按进入区域；精度差于 50 米不判断。
 * 多个点同时命中时优先行程里的 next；还分不清就返回候选让用户选。
 */
export function arrival(fix: Fix | null, stops: Stop[], nextId: string | null): { stopId: string | null; ambiguous: string[]; tooCoarse: boolean } {
  if (!fix) return { stopId: null, ambiguous: [], tooCoarse: false };
  if (fix.accuracyM > ARRIVE_M) return { stopId: null, ambiguous: [], tooCoarse: true };
  const hits = stops.filter(s => s.geometry.type === 'Polygon'
    ? inside(fix.at, s.geometry.coordinates[0] as [number, number][])
    : meters(fix.at, center(s)) <= ARRIVE_M);
  if (hits.length <= 1) return { stopId: hits[0]?.id ?? null, ambiguous: [], tooCoarse: false };
  if (nextId && hits.some(h => h.id === nextId)) return { stopId: nextId, ambiguous: [], tooCoarse: false };
  return { stopId: null, ambiguous: hits.map(h => h.id), tooCoarse: false };
}
