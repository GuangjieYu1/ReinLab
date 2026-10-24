import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import LoginGate from '../components/cinematic/LoginGate';
import { loggedIn, subscribeSession, sessionGeneration } from './research-live';
const snapshot = () => `${sessionGeneration()}:${loggedIn()}`;

/** Existing login presentation only; account changes unmount any previous account's inbox state. */
export default function LiveSessionBoundary({ children }: { children: ReactNode }) {
  const identity = useSyncExternalStore(subscribeSession, snapshot, () => '0:false');
  return loggedIn() ? <Fragment key={identity}>{children}</Fragment> : <LoginGate reduced music={false} onMusicChange={() => {}} onLogin={() => {}} />;
}
