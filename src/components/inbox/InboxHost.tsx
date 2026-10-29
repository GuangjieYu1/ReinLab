import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Inbox } from 'lucide-react';
import InboxPanel from './InboxPanel';
import '../../styles/rhine.css';
import './inbox.css';
import { mockAdapter } from './mockInbox';
import type { InboxAdapter } from './inboxTypes';

// 收件箱的宿主：什么时候弹、入口按钮上的数字。
// 弹出时机（§13）：登录后到达终端时一次；从后台回到前台且离开超过 30 分钟时再一次；不是每来一条就打扰。
// adapter 默认用示例数据；接后端时由宿主传入 live 版，界面不变。

const AWAY_MS = 30 * 60_000;
let shared: InboxAdapter | null = null;
// 自动弹出一次就够：切换工作台会重新挂载入口按钮，不能每切一次弹一次
let autoOpened = false;
const defaultAdapter = () => (shared ??= mockAdapter());

export function useInboxCount(adapter: InboxAdapter) {
  const [n, setN] = useState<number | null>(null);
  const refresh = useMemo(() => () => adapter.load().then(({ promotions, approvals }) => setN(promotions.length + approvals.filter(a => a.state === 'pending').length)).catch(() => {}), [adapter]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { n, setN, refresh };
}

export default function InboxHost({ autoOpen, adapter = defaultAdapter(), button = true, className }: {
  autoOpen: boolean; adapter?: InboxAdapter; button?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { n, setN, refresh } = useInboxCount(adapter);
  const opened = useRef(false), hiddenAt = useRef<number | null>(null);

  useEffect(() => { if (autoOpen && !opened.current && !autoOpened && n !== null && n > 0) { opened.current = true; autoOpened = true; setOpen(true); } }, [autoOpen, n]);
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) { hiddenAt.current = Date.now(); return; }
      if (hiddenAt.current && Date.now() - hiddenAt.current > AWAY_MS) void refresh().then(() => setOpen(true));
      hiddenAt.current = null;
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  useEffect(() => { document.body.classList.toggle('ibx-lock', open); return () => document.body.classList.remove('ibx-lock'); }, [open]);

  return <>
    {button && <button className={`ibx-open ${className ?? ''}`} data-n={n ? n : undefined} onClick={() => setOpen(true)} aria-label={`收件箱${n ? `，${n} 件待处理` : ''}`}><Inbox size={14} /> 收件箱</button>}
    {/* 挂到 body：宿主（比如带 transform 的导航条）会把 position:fixed 限制在自己里面 */}
    {open && createPortal(<InboxPanel adapter={adapter} onRemaining={setN} onClose={() => { setOpen(false); void refresh(); }} />, document.body)}
  </>;
}
