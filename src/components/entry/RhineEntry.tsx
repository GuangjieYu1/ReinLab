import { lazy, startTransition, Suspense, useCallback, useEffect, useState } from 'react';
import '../../styles/rhine.css';
import './rhine-login.css';
import RhineLogin, { LOGIN_EXIT_MS, LOGIN_HANDOFF_MS } from './RhineLogin';
import type { CeremonyDesign } from '../cinematic/CeremonyWorkbenchChooser';
import { mockEntryAuth, type EntryAuth } from './entryAuth';

const EntryComparison = lazy(() => import('../cinematic/EntryComparison'));

// 每次登录随机进入两种选台之一；?design= 可固定其中一种（从工作台返回时也靠它保持同一种）。
const DESIGNS: CeremonyDesign[] = ['aperture', 'mobius'];
const randomDesign = () => DESIGNS[Math.floor(Math.random() * DESIGNS.length)];

function pickDesign(): CeremonyDesign {
  const asked = new URLSearchParams(window.location.search).get('design') as CeremonyDesign | null;
  return asked && DESIGNS.includes(asked) ? asked : randomDesign();
}

/** 常驻品牌：登录、选台、Files 共用同一个，转场时不动，作为视线的锚点。 */
function RhineBrand() {
  return <div className="rb" aria-label="Rhine Lab Synthesize Information Analysis OS">
    <strong>RHINE LAB</strong><span>SYNTHESIZE INFORMATION</span><em>ANALYSIS<b>OS</b></em>
  </div>;
}

export default function RhineEntry({ auth = mockEntryAuth }: { auth?: EntryAuth } = {}) {
  // 从工作台返回（?return=）且仍在会话中，直接回到对应的 Files；会话已失效（live 刷新页面后）则重新登录。
  const [returning] = useState(() => new URLSearchParams(window.location.search).has('return') && auth.active());
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [design, setDesign] = useState(pickDesign);
  const [chooser, setChooser] = useState(returning);
  // hold：选台页已挂上（档案场在登录层下方备好），但选台本身先不出场，等交接时刻再放出来。
  const [hold, setHold] = useState(false);
  const [login, setLogin] = useState(!returning);
  const [relocking, setRelocking] = useState(false);
  const [session, setSession] = useState(0);

  // 登录期间预取选台与 Files 的代码，转场时不卡顿。
  useEffect(() => { void import('../cinematic/EntryComparison'); }, []);

  // 口令通过、开始核验时就挂上选台页（最重的档案场在此刻构建），交接时只需放出选台。
  const verify = useCallback(() => { startTransition(() => { setHold(true); setChooser(true); }); }, []);
  const exit = useCallback(() => {
    // 刻度环即将成形时放出选台，让它的开场圆环从同一位置画出；登录层播完后卸载。
    window.setTimeout(() => startTransition(() => { setChooser(true); setHold(false); }), reduced ? 0 : LOGIN_HANDOFF_MS);
    window.setTimeout(() => { setLogin(false); setRelocking(false); }, reduced ? 0 : LOGIN_EXIT_MS);
  }, [reduced]);

  // 锁定：登录层倒放着回来盖住选台，再卸载选台；下次登录重新抽一种选台。
  const lock = useCallback(() => {
    const url = new URL(window.location.href);
    ['return', 'file', 'design'].forEach(k => url.searchParams.delete(k));
    window.history.replaceState(null, '', url.pathname + url.search);
    auth.lock?.();
    setRelocking(true); setLogin(true);
  }, [auth]);
  const arrived = useCallback(() => {
    setChooser(false); setRelocking(false); setSession(n => n + 1); setDesign(randomDesign());
  }, []);

  return <>
    {chooser && <Suspense fallback={null}><EntryComparison key={session} shell="entry" initialDesign={design} hold={hold} onLock={lock} /></Suspense>}
    {login && <RhineLogin auth={auth} reduced={reduced} design={design} arriving={relocking} onVerify={verify} onExit={exit} onArrived={arrived} />}
    <RhineBrand />
  </>;
}
