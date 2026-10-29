import { createPortal } from 'react-dom';
import { useState } from 'react';
import type { Confirmation } from './adapter';
import { dossiers } from './store';
import './dossier.css';

/** 删除 / 归档活跃档案的一次确认。和收件箱、Agent 坞里是同一张卡（同一个 id），在哪里决定都一样。 */
export default function ConfirmDialog({ c, onClose }: { c: Confirmation; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const del = c.kind === 'dossier.delete';
  const decide = async (approve: boolean) => {
    setBusy(true); setErr(null);
    try { await dossiers().decide(c.id, approve); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : '没有成功'); setBusy(false); }
  };
  const lines = [
    c.impact.activeRuns ? `会停止 ${c.impact.activeRuns} 个正在进行的任务` : '',
    c.impact.pendingRequests ? `会关闭 ${c.impact.pendingRequests} 个等你处理的请求` : '',
    c.impact.artifacts ? `${c.impact.artifacts} 项成果将不能再从这份档案打开` : '',
  ].filter(Boolean);
  return createPortal(<div className="dsc-back" role="presentation" onPointerDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="dsc" role="alertdialog" aria-modal="true" aria-label={del ? '确认删除档案' : '确认归档档案'}>
      <span className="rh-micro">{del ? 'DELETE · 需要你确认一次' : 'ARCHIVE · 需要你确认一次'}</span>
      <h3>{del ? '删除' : '归档'}《{c.target.title}》？</h3>
      {lines.length > 0 && <ul>{lines.map(l => <li key={l}>{l}</li>)}</ul>}
      <p>{c.impact.note}</p>
      {err && <p className="dm-msg" role="alert">{err}</p>}
      <div className="dsc-acts">
        <button className="rh-btn" disabled={busy} onClick={() => void decide(false)}>不{del ? '删除' : '归档'}</button>
        <button className={`rh-btn is-solid ${del ? 'dm-danger' : ''}`} disabled={busy} onClick={() => void decide(true)}>{busy ? '处理中…' : del ? '确认删除' : '确认归档'}</button>
      </div>
    </div>
  </div>, document.body);
}
