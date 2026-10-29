import InboxHost from './InboxHost';
import { mockAdapter } from './mockInbox';

// ?preview=inbox：单独看收件箱（开发与回归用）。每次进入都用一份新的示例数据，并且直接弹出。
const adapter = mockAdapter();

export default function InboxPreview() {
  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', gap: 14, background: 'var(--rh-paper)', fontFamily: 'var(--rh-f-ui)' }}>
    <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
      <span style={{ font: '500 11px var(--rh-f-mono)', letterSpacing: '.12em', color: 'var(--rh-ink-4)' }}>PREVIEW · INBOX</span>
      <InboxHost autoOpen adapter={adapter} className="rh-btn" />
    </div>
  </main>;
}
