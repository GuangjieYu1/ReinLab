import React, { lazy, startTransition, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import { NAV_EVENT } from './nav';
import { previewLiveAuth } from './components/entry/entryAuth';
import LiveSessionBoundary from './data/LiveSessionBoundary';
import { liveBackend, restoreSession, sessionState, subscribeSession } from './data/research-live';
import { liveEntryAuth } from './data/entry-live';
import { liveInboxAdapter } from './data/inbox-live';
import InboxHost from './components/inbox/InboxHost';
import './styles.css';

const WorkbenchStudio = lazy(() => import('./components/workbenches/WorkbenchStudio'));
const RhineSpecimen = lazy(() => import('./components/rhine/RhineSpecimen'));
const RhineEntry = lazy(() => import('./components/entry/RhineEntry'));
const EmblemTransit = lazy(() => import('./components/entry/EmblemTransit'));
const InboxPreview = lazy(() => import('./components/inbox/InboxPreview'));

// 正式产品：入口（默认）→ 工作台。演示区：?preview=rhine（设计语言样张）、?preview=inbox（收件箱 mock 预览）。
function Page({ preview }: { preview: string | null }) {
  if (preview === '__blank') return null;
  return preview === 'workbench'
    ? <Suspense fallback={null}><WorkbenchStudio /></Suspense>
    : preview === 'template' || preview === 'rhine'
    ? <Suspense fallback={<div role="status" style={{ padding: 30 }}>正在展开工作台设计模板…</div>}><RhineSpecimen /></Suspense>
    : preview === 'inbox'
    ? <Suspense fallback={null}>{liveBackend ? <InboxHost autoOpen adapter={liveInboxAdapter} /> : <InboxPreview />}</Suspense>
    : <Suspense fallback={null}><RhineEntry auth={liveBackend ? liveEntryAuth : new URLSearchParams(window.location.search).get('auth') === 'live' ? previewLiveAuth : undefined} /></Suspense>;
}

// 登录会话（地基第 5 项）：先用 Cookie 恢复登录再决定显示什么，不先闪登录页。
// 连不上服务时给一个可重试的提示，不当成退出。
void restoreSession();
function SessionGate({ children }: { children: React.ReactNode }) {
  const state = useSyncExternalStore(subscribeSession, sessionState, sessionState);
  if (!liveBackend) return <>{children}</>;
  if (state === 'restoring') return <div role="status" className="rh-micro" style={{ position: 'fixed', inset: 'auto 0 24px', textAlign: 'center', opacity: 0.6 }}>正在恢复登录…</div>;
  if (state === 'offline') return <div role="alert" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', gap: 12, alignContent: 'center' }}>
    <b>连不上本地服务</b><span className="rh-micro">登录没有丢，恢复连接后会自动继续</span>
    <button className="rh-btn" onClick={() => void restoreSession()}>重试</button></div>;
  return <>{children}</>;
}

// 页内导航时按地址重新挂载页面；转场层常驻在页面之外，跨页面不中断。
function Root() {
  const [nav, setNav] = useState(() => ({ preview: new URLSearchParams(window.location.search).get('preview'), n: 0 }));
  useEffect(() => {
    // 新页面的挂载放进并发渲染：转场层里的标识与刻度环继续流畅转动，不被一次大渲染卡住。
    // 先卸下旧页面，下一帧再挂上新页面：两次各自较小的提交，代替一次「卸载 + 挂载」的大提交。
    const on = () => {
      const preview = new URLSearchParams(window.location.search).get('preview');
      startTransition(() => setNav(prev => ({ preview: '__blank', n: prev.n + 1 })));
      requestAnimationFrame(() => requestAnimationFrame(() => startTransition(() => setNav(prev => ({ preview, n: prev.n + 1 })))));
    };
    window.addEventListener(NAV_EVENT, on); window.addEventListener('popstate', on);
    return () => { window.removeEventListener(NAV_EVENT, on); window.removeEventListener('popstate', on); };
  }, []);
  const withTransit = nav.preview !== 'rhine' && nav.preview !== 'template' && nav.preview !== 'inbox';
  const entry = nav.preview === null || nav.preview === 'entry' || nav.preview === '__blank';
  return <SessionGate>
    {liveBackend && !entry
      ? <LiveSessionBoundary><Page key={nav.n} preview={nav.preview} /></LiveSessionBoundary>
      : <Page key={nav.n} preview={nav.preview} />}
    {withTransit && <Suspense fallback={null}><EmblemTransit /></Suspense>}
  </SessionGate>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
