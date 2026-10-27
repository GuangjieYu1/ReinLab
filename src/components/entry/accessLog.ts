// 登录页「操作日志」：每次提交口令都记一条，存在本机，刷新后仍在。
// 只记录时间、结果和口令长度，不保存口令本身。

export type AccessEntry = { at: number; result: 'denied' | 'granted'; length: number };

const KEY = 'rhine.accessLog';
const LIMIT = 30;

export function readAccessLog(): AccessEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(e => e && typeof e.at === 'number').slice(-LIMIT) : [];
  } catch { return []; }
}

export function appendAccessLog(entry: AccessEntry): AccessEntry[] {
  const next = [...readAccessLog(), entry].slice(-LIMIT);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 隐私模式下无法写入时只保留内存中的记录 */ }
  return next;
}

export const formatTime = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });
