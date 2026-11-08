import { useEffect, useRef, useState } from 'react';
import type { Outline, Proposal, TextEdit, Work, WorldSnapshot } from '../../../../../packages/contracts/src/creative';
import AgentDock, { type DockEvent } from '../../AgentDock';
import type { CreativeAdapter } from './adapter';

export const money = (c: { value: number | null; known: boolean }) => c.known && c.value != null ? `¥${c.value.toFixed(3)}` : '用量未知';
export const pending = (p: Proposal) => p.status === 'pending' || p.status === 'deferred';
export const batchable = (p: Proposal) => pending(p) && p.kind !== 'text_edit' && p.kind !== 'merge' && !p.doubts.length && !p.candidates?.length && !p.origin.stale && !p.dependsOn.length && !p.conflicts.length;
export const editOf = (p: Proposal) => p.kind === 'text_edit' ? p.ops[0] as TextEdit & { op: string } : null;
export const kinds: Record<string, string> = { entity: '实体', event: '事件', merge: '合并', relation: '关系', rule: '规则', map_edit: '地图', itinerary: '人物经历', route: '路线', text_edit: '正文改稿' };

/** 引用事件：已选的是可删的小标签，下拉加一条。比原生多选框好用，事件多了也不乱。 */
export function EventPicker({ ids, snap, onChange }: { ids: string[]; snap: WorldSnapshot; onChange: (ids: string[]) => void }) {
  const rest = snap.events.filter(e => !ids.includes(e.id));
  return <div className="cn-chips">
    {ids.map(id => <span key={id} className="cn-chip">{snap.events.find(e => e.id === id)?.title ?? id.slice(0, 8)}<button type="button" aria-label="去掉这条引用" onClick={() => onChange(ids.filter(x => x !== id))}>×</button></span>)}
    {rest.length > 0 && <select aria-label="加一条引用事件" value="" onChange={e => { if (e.target.value) onChange([...ids, e.target.value]); }}><option value="">＋ 引用事件</option>{rest.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select>}
    {!ids.length && !rest.length && <small className="cw-muted">世界观里还没有事件</small>}
  </div>;
}

/** 改稿对照：去掉前后相同的部分，只把改动的那一截标出来。 */
function DiffView({ before, after }: { before: string; after: string }) {
  let a = 0; while (a < before.length && a < after.length && before[a] === after[a]) a++;
  let b = 0; while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  const head = before.slice(0, a), tail = before.slice(before.length - b);
  const cut = (t: string, side: 'head' | 'tail') => t.length > 120 ? (side === 'head' ? '…' + t.slice(-120) : t.slice(0, 120) + '…') : t;
  return <div className="cn-diff">
    <p><span className="rh-micro">改前</span>{cut(head, 'head')}<del>{before.slice(a, before.length - b) || '（无）'}</del>{cut(tail, 'tail')}</p>
    <p><span className="rh-micro">改后</span>{cut(head, 'head')}<ins>{after.slice(a, after.length - b) || '（删去）'}</ins>{cut(tail, 'tail')}</p>
  </div>;
}

/** 依据和摘要开头差不多就不重复显示（服务端常把同一段话放在两处）。 */
const sameGist = (a: string, b?: string | null) => { const x = a.replace(/\s/g, ''), y = (b ?? '').replace(/\s/g, ''); return !!y && (x === y || x.startsWith(y.slice(0, 40)) || y.startsWith(x.slice(0, 40))); };

export function ProposalCard({ proposal: p, busy, decide, acceptText, source }: {
  proposal: Proposal; busy: boolean; decide: (p: Proposal, d: 'accepted' | 'rejected' | 'deferred', candidate?: number) => void;
  acceptText: (p: Proposal, text?: string) => void; source: (p: Proposal) => void;
}) {
  const edit = editOf(p), [after, setAfter] = useState(edit?.after ?? '');
  useEffect(() => setAfter(edit?.after ?? ''), [edit?.after]);
  return <article className="cw-proposal cw-pane">
    <span className="rh-micro">{kinds[p.kind] ?? p.kind} · {{ pending: '待确认', accepted: '已接受', rejected: '已拒绝', deferred: '暂缓' }[p.status]}</span>
    <h3>{p.title}</h3><p className="cn-sum">{p.summary}</p>
    {p.origin.source && <blockquote><button className="cw-link" onClick={() => source(p)}>回原文 · 第 {p.origin.source.para + 1} 段</button><p>{p.origin.source.quote}</p></blockquote>}
    {p.origin.why && !sameGist(p.origin.why, p.summary) && <details className="cn-why"><summary>依据</summary><p>{p.origin.why}</p></details>}
    {p.origin.stale && <p className="cw-muted">原文出处已过期，请先核对。</p>}
    {p.doubts.map((d, i) => <p key={i} className="cw-warn">待确认：{d}</p>)}
    {p.dependsOn.length > 0 && <p>依赖提议：{p.dependsOn.join('、')}（请先处理依赖项）</p>}
    {p.conflicts.map(c => <p key={c.id} className="cw-flag" data-sev={c.severity}>{c.severity === 'hard' ? '确定冲突' : '疑似冲突'}：{c.why}</p>)}
    {p.kind === 'itinerary' && <details><summary>人物、事件与路线</summary>{p.ops.map((op, i) => <p key={i}>{op.op === 'entity.add' ? `${({ person: '人物', place: '地点', item: '物件', org: '组织' } as Record<string, string>)[(op.entity as { kind?: string }).kind ?? ''] ?? '设定'}：${op.entity.name}` : op.op === 'event.add' ? `事件：${op.event.title} · ${op.event.what ?? ''}` : op.op === 'route.draw' ? '路线：已附行程路径' : op.op === 'relation.add' ? '人物关系：随提议一并提交' : '关联设定修改'}</p>)}{!p.conflicts.length && <p>本次硬检查未报告冲突；请同时核对疑点。</p>}</details>}
    {edit && <>{edit.mode === 'continue' || !edit.before ? <p className="cn-diff-note"><span className="rh-micro">{edit.mode === 'continue' ? '接在本场末尾' : '起稿'}</span></p> : <DiffView before={edit.before} after={after} />}
      <details className="cn-diff-edit" open={after !== edit.after}><summary>改一改再接受</summary><textarea aria-label="修改后正文" value={after} onChange={e => setAfter(e.target.value)} rows={7} disabled={!pending(p)} /></details></>}
    {pending(p) ? <div className="cw-row">
      {edit ? <button className="rh-btn" disabled={busy} onClick={() => acceptText(p, after === edit.after ? undefined : after)}>接受{after !== edit.after ? '修改后的正文' : '改稿'}</button>
        : p.candidates?.length ? p.candidates.map((c, i) => <button key={i} className="rh-btn" disabled={busy} title={c.why} onClick={() => decide(p, 'accepted', i)}>选择：{c.label}</button>)
        : <button className="rh-btn" disabled={busy} onClick={() => decide(p, 'accepted')}>接受</button>}
      <button className="rh-btn" disabled={busy} onClick={() => decide(p, 'rejected')}>拒绝</button><button className="rh-btn" disabled={busy} onClick={() => decide(p, 'deferred')}>暂缓</button>
    </div> : <p className="cw-muted">{p.resolution ? `${p.resolution.by === 'agent' ? '系统' : '作者'}${{ accepted: '已接受', rejected: p.resolution.by === 'agent' ? '已作废' : '已拒绝', deferred: '暂缓' }[p.resolution.decision as string] ?? '已处理'}${p.resolution.reason ? '：' + p.resolution.reason : ''}` : '已处理'}</p>}
    {p.candidates?.map((c, i) => <p key={i}><b>{c.label}</b>：{c.why}</p>)}
  </article>;
}

export function OutlineEditor({ work, snap, save, busy }: { work: Work; snap: WorldSnapshot; save: (o: Omit<Outline, 'state' | 'proposalIds'>, confirm: boolean) => Promise<void>; busy: boolean }) {
  const blankScene = () => ({ id: crypto.randomUUID(), title: '新场景', goal: '', eventIds: [] as string[], targetWords: null as number | null });
  const [draft, setDraft] = useState<Omit<Outline, 'state' | 'proposalIds'>>(() => {
    const current = work.chapters.map(c => ({ id: c.id, title: c.title, scenes: c.scenes.map(sc => ({ id: sc.id, title: sc.title, goal: sc.goal, eventIds: sc.eventIds, targetWords: sc.targetWords })) }));
    const chapters = structuredClone(work.outline?.chapters ?? current);
    const known = new Set(chapters.flatMap(c => c.scenes.map(sc => sc.id)));
    for (const c of current) {
      const missing = c.scenes.filter(sc => !known.has(sc.id));
      const existing = chapters.find(ch => ch.id === c.id);
      if (existing) existing.scenes.push(...missing);
      else if (missing.length) chapters.push({ ...c, scenes: missing });
    }
    return { logline: work.outline?.logline ?? '', pov: work.outline?.pov ?? '', ending: work.outline?.ending ?? '', chapters: chapters.length ? chapters : [{ id: crypto.randomUUID(), title: '第一章', scenes: [blankScene()] }] };
  });
  const [error, setError] = useState('');
  const submit = async (confirm: boolean) => { setError(''); try { await save(draft, confirm); } catch (e) { setError((e as Error).message); } };
  return <div className="cw-pane cw-form"><h3>大纲 · {work.outline?.state === 'confirmed' ? '已确认' : '待确认'}</h3>
    {(['logline', 'pov', 'ending'] as const).map((key, i) => <label key={key}>{['主线', '视角', '结局方向'][i]}<textarea value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
    {draft.chapters.map((c, ci) => <fieldset key={c.id}><legend>第 {ci + 1} 章</legend><input aria-label={`第 ${ci + 1} 章标题`} value={c.title} onChange={e => setDraft({ ...draft, chapters: draft.chapters.map((x, i) => i === ci ? { ...x, title: e.target.value } : x) })} />
      {c.scenes.map((sc, si) => { const patch = (p: Partial<typeof sc>) => setDraft({ ...draft, chapters: draft.chapters.map((x, i) => i === ci ? { ...x, scenes: x.scenes.map((y, j) => j === si ? { ...y, ...p } : y) } : x) }); return <fieldset key={sc.id}><legend>场 {si + 1}</legend>
        <label>场景名<input value={sc.title} onChange={e => patch({ title: e.target.value })} /></label><label>目标<textarea value={sc.goal} onChange={e => patch({ goal: e.target.value })} /></label>
        <label>目标字数<input type="number" min="0" value={sc.targetWords ?? ''} onChange={e => patch({ targetWords: e.target.value ? Number(e.target.value) : null })} /></label>
        <div className="cn-field"><span>引用事件</span><EventPicker ids={sc.eventIds} snap={snap} onChange={ids => patch({ eventIds: ids })} /></div>
      </fieldset>; })}<button className="rh-btn" onClick={() => setDraft({ ...draft, chapters: draft.chapters.map((x, i) => i === ci ? { ...x, scenes: [...x.scenes, blankScene()] } : x) })}>＋ 场景</button>
    </fieldset>)}
    <button className="rh-btn" onClick={() => setDraft({ ...draft, chapters: [...draft.chapters, { id: crypto.randomUUID(), title: '新章', scenes: [blankScene()] }] })}>＋ 章节</button>
    <p className="cw-muted">确认大纲会建立章场，新设定仍留在待确认。</p>{error && <p role="alert">{error}</p>}
    <div className="cw-row"><button className="rh-btn" disabled={busy} onClick={() => void submit(false)}>保存大纲</button><button className="rh-btn is-solid" disabled={busy} onClick={() => void submit(true)}>确认大纲</button></div>
  </div>;
}

export function CreativeAssistant({ adapter, workId, sceneId, onUpdate, initialMode = 'creative_writer' }: { initialMode?: 'creative_writer' | 'creative_advisor'; adapter: CreativeAdapter; workId?: string; sceneId?: string; onUpdate: () => void }) {
  const [mode, setMode] = useState<'creative_writer' | 'creative_advisor'>(initialMode);
  const [events, setEvents] = useState<DockEvent[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const epoch = useRef(0), running = useRef(false), update = useRef(onUpdate); update.current = onUpdate;
  const follow = async (id: string, token: number) => {
    let after = 0;
    while (epoch.current === token) {
      try {
        const page = await adapter.runEvents(id, after);
        if (epoch.current !== token) return;
        for (const ev of page.events) {
          if (ev.seq <= after) continue;
          after = ev.seq;
          const p = ev.payload, msg = p.message ?? p;
          const text = Array.isArray(msg.content) ? msg.content.map((b: { text?: string }) => b.text ?? '').join('') : typeof msg.content === 'string' ? msg.content : '';
          const key = `${id}:${ev.seq}`;
          if (text && (ev.action === 'user/message' || ev.action === 'assistant/message')) setEvents(xs => xs.some(x => x.id === key) ? xs : [...xs, { id: key, kind: ev.action === 'user/message' ? 'user' : 'agent', text, at: '' }]);
          if (ev.action === 'tool/call') setEvents(xs => [...xs, { id: key, kind: 'note', text: `正在调用：${p.name ?? '创作工具'}`, at: '' }]);
        }
        if (page.hasMore) continue;
        const status = await adapter.runState(id);
        if (epoch.current !== token) return;
        setError('');
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.state)) { setBusy(false); running.current = false; update.current(); return; }
        setBusy(true); running.current = true;
      } catch (e) { if (epoch.current === token) setError(`会话连接中断，正在重连：${(e as Error).message}`); }
      await new Promise(r => setTimeout(r, 1500));
    }
  };
  useEffect(() => {
    const token = ++epoch.current; setEvents([]); setError(''); setBusy(false); running.current = false;
    adapter.runs().then(({ runs }) => { if (epoch.current !== token) return; const last = runs.find(r => r.mode === mode); if (last) void follow(last.id, token); }).catch(e => setError(e.message));
    return () => { epoch.current++; };
  }, [adapter, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (text: string) => {
    if (running.current) { setError('助手仍在工作，请等本轮完成。'); return; }
    running.current = true; setBusy(true); setError('');
    try { const run = await adapter.startAssistant(text, mode, workId, sceneId); const token = ++epoch.current; await follow(run.id, token); }
    catch (e) { running.current = false; setBusy(false); setError((e as Error).message); }
  };
  return <><div className="cw-row cw-pane"><select aria-label="助手角色" disabled={busy} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="creative_writer">写作助手</option><option value="creative_advisor">设定顾问</option></select>{error && <p role="alert">{error}</p>}</div>
    <AgentDock name={mode === 'creative_writer' ? '写作助手' : '设定顾问'} target="当前世界观 · 真实会话" plan={{ stages: ['阅读资料', '提出建议', '作者确认'], current: 0 }} events={events} busy={busy} suggestions={[{ id: 'add', label: '加人物', fill: '加一个人物：请提出与现有事件、路线接得上的经历，先做硬检查再提交提议。' }]} onSend={text => void send(text)} footnote="AI 只提议，接受后才入账或落笔" />
  </>;
}
