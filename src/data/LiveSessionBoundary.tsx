import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { navigate } from '../nav';
import { sessionState, subscribeSession, sessionGeneration } from './research-live';
import { RETURN_KEY } from './entry-live';
const snapshot = () => `${sessionGeneration()}:${sessionState()}`;

/** Account changes unmount prior account state; the entry owns login presentation. */
export default function LiveSessionBoundary({ children }: { children: ReactNode }) {
  const identity = useSyncExternalStore(subscribeSession, snapshot, () => '0:false');
  const state = sessionState();
  const active = state === 'active';
  // 恢复中、连不上时不跳登录页：只有确定退出 / 过期才去登录，并记下原来要去的地方
  const leave = state === 'signedOut' || state === 'expired';
  useEffect(() => {
    if (leave && new URLSearchParams(window.location.search).get('preview') !== 'entry') {
      sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
      navigate('/?preview=entry');
    }
  }, [leave]);
  return active ? <Fragment key={identity.split(':')[0]}>{children}</Fragment> : null;
}
