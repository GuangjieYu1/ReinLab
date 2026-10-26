import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { navigate } from '../nav';
import { loggedIn, subscribeSession, sessionGeneration } from './research-live';
const snapshot = () => `${sessionGeneration()}:${loggedIn()}`;

/** Account changes unmount prior account state; the entry owns login presentation. */
export default function LiveSessionBoundary({ children }: { children: ReactNode }) {
  const identity = useSyncExternalStore(subscribeSession, snapshot, () => '0:false');
  const active = loggedIn();
  useEffect(() => {
    if (!active && new URLSearchParams(window.location.search).get('preview') !== 'entry')
      navigate('/?preview=entry');
  }, [active]);
  return active ? <Fragment key={identity}>{children}</Fragment> : null;
}
