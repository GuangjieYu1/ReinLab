import { useState } from 'react';
import type { CreativeConflict, ItemChange, Proposal, ProposalPreview } from '../../../../../packages/contracts/src/creative';
import { KIND_ZH } from './Panels';

// 1D（契约 20 §11.5）：提议条和「这条提议带来的冲突」。看板优先：明细画在地图和时间轴上，这里只放计数和决定。

const changeLine = (cs: ItemChange[]) => cs.slice(0, 4).map(c => `${c.title}${c.change === 'update' && c.fields.length ? `（${c.fields.join('、')}）` : c.change === 'add' ? '（新加）' : c.change === 'remove' ? '（去掉）' : ''}`).join('；') + (cs.length > 4 ? ` 等 ${cs.length} 处` : '');

/** 这是第几版：沿 supersedes 往回数。 */
function versionOf(p: Proposal, all: Proposal[]) {
  let n = 1, cur: Proposal | undefined = p;
  while (cur?.supersedes && n < 20) { n++; cur = all.find(x => x.id === cur!.supersedes); }
  return n;
}

export function ProposalBar({ proposal, preview: pv, previewError, proposals, busy, onDecide, onClose, onRevise, ruleJudged = 0 }: {
  proposal: Proposal; preview: ProposalPreview | null; proposals: Proposal[]; busy: boolean;
  /** 预览没取到的原因：照样给接受 / 拒绝 / 改一下，只是看板上画不出来。 */ previewError?: string;
  /** 现在有几条「模型判的规则疑似」：提议动了事件，接受后它们要重判。 */ ruleJudged?: number;
  onDecide: (d: 'accepted' | 'rejected') => void; onClose: () => void; onRevise: (text: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false), [text, setText] = useState(''), [err, setErr] = useState(''), [sent, setSent] = useState(false);
  const preview: ProposalPreview = pv ?? { added: { entities: [], events: [], relations: [], rules: [] }, changed: [], removed: [], conflictsNew: [], conflictsGone: [], unresolved: [] } as unknown as ProposalPreview;
  const a = preview.added, people = a.entities.filter(e => e.kind === 'person').length, places = a.entities.filter(e => e.kind === 'place').length;
  const hard = preview.conflictsNew.filter(c => c.severity === 'hard').length, sus = preview.conflictsNew.length - hard;
  const counts = [people && `${people} 人物`, places && `${places} 地点`, a.events.length && `${a.events.length} 事件`, a.relations.length && `${a.relations.length} 关系`, a.rules.length && `${a.rules.length} 规则`,
    a.prims?.length && `${a.prims.length} 白模部件`, a.shots?.length && `${a.shots.length} 镜头`,
    preview.changed.length && `改 ${preview.changed.length} 处`, preview.removed.length && `去掉 ${preview.removed.length} 处`].filter(Boolean).join(' · ');
  const v = versionOf(proposal, proposals);
  const revise = async () => {
    if (!text.trim()) return; setErr('');
    try { await onRevise(text.trim()); setSent(true); setText(''); setOpen(false); } catch (e) { setErr((e as Error).message); }
  };
  return <div className="cw-pbar" role="region" aria-label="提议">
    <div className="cw-pbar-main">
      <em>{proposal.kind === 'whitebox' || proposal.kind === 'shots' ? '导演提议' : proposal.runId ? '顾问提议' : '提议'}{v > 1 ? ` · 第 ${v} 版` : ''}</em>
      <b>{proposal.title}</b>
      <span>{pv ? counts || '没有看板上能画的改动' : '看板上画不出来'}</span>
      {pv && <span data-sev={hard ? 'hard' : sus ? 'suspect' : undefined}>{preview.conflictsNew.length ? `新冲突 ${preview.conflictsNew.length}${hard ? `（红 ${hard}）` : ''}` : '没有新冲突'}{preview.conflictsGone.length ? ` · 消掉 ${preview.conflictsGone.length}` : ''}</span>}
    </div>
    {!pv && previewError && <p className="cw-pbar-warn">预览没取到：{previewError.replace(/[。.]+$/, "")}。可以点「改一下…」让顾问重交，或者直接拒绝。</p>}
    {v > 1 && preview.vsPrevious && <p className="cw-pbar-vs">比上一版：{preview.vsPrevious.length ? changeLine(preview.vsPrevious) : '看板上没有变化'}</p>}
    {ruleJudged > 0 && (preview.added.events.length > 0 || preview.changed.some(c => c.kind === 'event')) && <p className="cw-pbar-vs">接受后事件变了，模型判过的 {ruleJudged} 条规则疑似要重判（检查页点「让模型判规则」）。</p>}
    {pv && (() => { const f = [...new Set((preview.legs ?? []).map(l => l.failure?.replace(/[。.]+$/, '')).filter(Boolean))]; return f.length > 0 && <p className="cw-pbar-warn">路线画不出：{f.join('；')}</p>; })()}
    {pv && !!preview.unmet?.length && <p className="cw-pbar-vs">没满足的摆放要求：{preview.unmet.join('；')}</p>}
    {preview.unresolved.length > 0 && <p className="cw-pbar-warn">{proposal.kind === 'whitebox' || proposal.kind === 'shots' ? '对不上（接受会被拒）' : '对不上的名字'}：{preview.unresolved.join('；')}</p>}
    {sent && <p className="cw-pbar-vs">已经转达，新版交上来会替换这一条。</p>}
    {open && <div className="cw-pbar-revise"><input autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void revise(); }} placeholder="改哪里？比如：让他晚一天出现" />
      <button className="rh-btn is-solid" onClick={() => void revise()} disabled={!text.trim()}>发给顾问</button></div>}
    {err && <p role="alert">{err}</p>}
    <div className="cw-pbar-acts">
      <button className="rh-btn is-solid" disabled={busy} onClick={() => onDecide('accepted')}>接受</button>
      <button className="rh-btn" disabled={busy} onClick={() => onDecide('rejected')}>拒绝</button>
      <button className="rh-btn" disabled={busy || !proposal.runId} title={proposal.runId ? '' : '这条不是在顾问对话里交的'} onClick={() => setOpen(o => !o)}>改一下…</button>
      <button className="rh-btn" onClick={onClose}>先收起</button>
    </div>
  </div>;
}

/** 检查页在看提议时：只列这条提议新带来的冲突和会消掉的冲突。 */
export function GhostConflicts({ title, preview, look, onAll }: { title: string; preview: ProposalPreview; look: { events: Map<string, { title: string }> }; onAll: () => void }) {
  const row = (c: CreativeConflict) => <article key={c.id} className="cw-conf" data-sev={c.severity}>
    <div className="cw-conf-head"><em>{c.severity === 'hard' ? '确定冲突' : '疑似'} · 接受后会出现</em><b>{KIND_ZH[c.kind] ?? c.kind}</b><p>{c.why}</p></div></article>;
  return <div className="cw-pane">
    <p className="rh-micro">正在看提议《{title}》：只列它带来的变化</p>
    {preview.conflictsNew.length ? preview.conflictsNew.map(row) : <p className="cw-muted">接受后不会多出冲突。</p>}
    {preview.conflictsGone.length > 0 && <p className="cw-muted">接受后会消掉 {preview.conflictsGone.length} 条现有冲突。</p>}
    <button className="rh-btn" onClick={onAll}>看全部冲突</button>
    {void look}
  </div>;
}
