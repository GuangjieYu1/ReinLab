import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BENCH, RISK_TEXT, TARGET, type EvidenceView, type InboxAdapter, type InboxApproval, type InboxPromotion, type InboxQuestion, type Json, type PromotionDecision, type PromotionItem, type SupersededView } from './inboxTypes';
import '../../styles/rhine.css';
import './inbox.css';

// 「上线时待批准」收件箱（design/BACKEND_MEMORY_SESSION.md §13）。
// 登录 / 回到前台时弹出一次：左边按工作台分组，中间是「要记住什么 · 依据 · 会影响什么」，底部四个动作。
// 不批准就不生效；过期作废，不会默认通过。键盘：↑↓ 切换，A 批准，E 改后批准，L 只存本档案，R 驳回，Esc 稍后处理。

type Entry = { kind: 'promotion'; p: InboxPromotion } | { kind: 'approval'; a: InboxApproval };
type Done = 'approve' | 'edit' | 'reject' | 'keep_local' | 'approved' | 'rejected' | 'answered';
const DONE_TEXT: Record<Done, string> = { approve: '已批准', edit: '已修改并批准', reject: '已驳回', keep_local: '只存本档案', approved: '已批准一次', rejected: '已驳回', answered: '已回答' };
const idOf = (e: Entry) => (e.kind === 'promotion' ? e.p.id : e.a.id);

function ago(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  const h = Math.round(m / 60); return h < 48 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`;
}
function left(iso: string) {
  const h = (Date.parse(iso) - Date.now()) / 3600000;
  if (h <= 0) return { text: '已过期', soon: true };
  return { text: h < 1 ? `${Math.max(1, Math.round(h * 60))} 分钟后作废` : h < 48 ? `${Math.round(h)} 小时后作废` : `${Math.round(h / 24)} 天后作废`, soon: h < 6 };
}
function Value({ v }: { v: Json }) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return <dl className="ibx-kv">{Object.entries(v).map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{typeof x === 'string' ? x : JSON.stringify(x)}</dd></div>)}</dl>;
  if (Array.isArray(v)) return <ul className="ibx-arr">{v.map((x, i) => <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>)}</ul>;
  return <p className="ibx-val">{String(v)}</p>;
}
/** 编辑用：字符串一个输入框；对象逐字段一个输入框。 */
function editable(v: Json): Record<string, string> | string {
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]));
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export default function InboxPanel({ adapter, onClose, onRemaining }: { adapter: InboxAdapter; onClose: () => void; onRemaining?: (n: number) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [done, setDone] = useState<Record<string, Done>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<(Record<string, string> | string)[] | null>(null);
  const [openEv, setOpenEv] = useState<Record<string, EvidenceView | 'loading' | 'missing'>>({});
  const [old, setOld] = useState<Record<string, SupersededView | null>>({});
  const [answers, setAnswers] = useState<Record<string, string[][]>>({});
  const sheet = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    adapter.load().then(({ promotions, approvals }) => {
      if (!live) return;
      const order = Object.keys(BENCH);
      const ps = [...promotions].sort((a, b) => order.indexOf(a.source.bench) - order.indexOf(b.source.bench) || Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
      const list: Entry[] = [...ps.map(p => ({ kind: 'promotion' as const, p })), ...approvals.map(a => ({ kind: 'approval' as const, a }))];
      setEntries(list); setSel(list[0] ? idOf(list[0]) : null);
    }).catch(() => live && setError('收件箱暂时打不开，稍后会再试。'));
    return () => { live = false; };
  }, [adapter]);
  useEffect(() => { sheet.current?.focus(); }, [entries === null]);

  const pending = useMemo(() => (entries ?? []).filter(e => !done[idOf(e)] && !(e.kind === 'approval' && e.a.state === 'indeterminate')), [entries, done]);
  useEffect(() => { if (entries) onRemaining?.(pending.length); }, [pending.length, entries, onRemaining]);
  const cur = entries?.find(e => idOf(e) === sel) ?? null;

  // 选中带「替换」的条目时，取回被替换的旧条目
  useEffect(() => {
    if (cur?.kind !== 'promotion') return;
    for (const it of cur.p.items) if (it.supersedes && !(it.supersedes in old)) adapter.superseded(it.supersedes).then(v => setOld(m => ({ ...m, [it.supersedes!]: v })));
  }, [cur, adapter, old]);

  const next = useCallback((from: string) => {
    if (!entries) return;
    const i = entries.findIndex(e => idOf(e) === from);
    const after = [...entries.slice(i + 1), ...entries.slice(0, i)].find(e => !done[idOf(e)] && idOf(e) !== from && !(e.kind === 'approval' && e.a.state === 'indeterminate'));
    setSel(after ? idOf(after) : null);
  }, [entries, done]);

  async function decide(d: PromotionDecision | 'approve-once' | 'reject-once') {
    if (!cur || busy || done[idOf(cur)]) return;
    setBusy(true); setError('');
    try {
      if (cur.kind === 'promotion' && typeof d === 'object') await adapter.decidePromotion(cur.p.id, d);
      else if (cur.kind === 'approval') await adapter.decideApproval(cur.a.id, d === 'approve-once' ? 'approve' : 'reject', d === 'approve-once' && cur.a.questions ? answers[cur.a.id] : undefined);
      const mark: Done = d === 'approve-once' ? (cur.kind === 'approval' && cur.a.kind === 'question' ? 'answered' : 'approved') : d === 'reject-once' ? 'rejected' : (d as PromotionDecision).decision;
      setDone(m => ({ ...m, [idOf(cur)]: mark })); setEditing(null);
      window.setTimeout(() => next(idOf(cur)), 650);
    } catch { setError('没有提交成功，这一条保持原样，可以再点一次。'); }
    finally { setBusy(false); }
  }
  const answered = (a: InboxApproval) => !a.questions || a.questions.every((_, i) => (answers[a.id]?.[i] ?? []).some(x => x.trim()));
  function startEdit() { if (cur?.kind === 'promotion' && !done[cur.p.id]) setEditing(cur.p.items.map(it => editable(it.value))); }
  function saveEdit() {
    if (cur?.kind !== 'promotion' || !editing) return;
    const items: PromotionItem[] = cur.p.items.map((it, i) => {
      const e = editing[i];
      if (typeof e === 'string') return { ...it, value: e.trim() };
      return { ...it, value: Object.fromEntries(Object.entries(e).map(([k, x]) => [k, x.trim()])) };
    });
    if (items.some(it => (typeof it.value === 'string' ? !it.value : Object.values(it.value as Record<string, string>).some(x => !x)))) { setError('修改后的内容不能为空。'); return; }
    void decide({ decision: 'edit', items });
  }
  async function toggleEvidence(ref: string) {
    if (openEv[ref] && openEv[ref] !== 'loading') { setOpenEv(m => { const n = { ...m }; delete n[ref]; return n; }); return; }
    setOpenEv(m => ({ ...m, [ref]: 'loading' }));
    try { const v = await adapter.evidence(ref); setOpenEv(m => ({ ...m, [ref]: v })); } catch { setOpenEv(m => ({ ...m, [ref]: 'missing' })); }
  }

  function onKey(e: KeyboardEvent) {
    // 只有收件箱自己的输入框算「正在编辑」；焦点停在后面页面的输入框里（比如助手对话框）时，Esc 照样关收件箱
    if ((e.target as HTMLElement | null)?.closest?.('.ibx textarea, .ibx input')) { if (e.key === 'Escape') setEditing(null); return; }
    if (!entries) { if (e.key === 'Escape') onClose(); return; }
    const i = entries.findIndex(x => idOf(x) === sel);
    const k = e.key.toLowerCase();
    if (k === 'escape') { editing ? setEditing(null) : onClose(); }
    else if (k === 'arrowdown' || k === 'j') { const n = entries[Math.min(entries.length - 1, i + 1)]; if (n) setSel(idOf(n)); }
    else if (k === 'arrowup' || k === 'k') { const n = entries[Math.max(0, i - 1)]; if (n) setSel(idOf(n)); }
    else if (!cur || editing) return;
    else if (k === 'a') { if (cur.kind === 'approval' && !answered(cur.a)) return; void decide(cur.kind === 'promotion' ? { decision: 'approve' } : 'approve-once'); }
    else if (k === 'r') void decide(cur.kind === 'promotion' ? { decision: 'reject' } : 'reject-once');
    else if (k === 'e' && cur.kind === 'promotion') startEdit();
    else if (k === 'l' && cur.kind === 'promotion') void decide({ decision: 'keep_local' });
    else return;
    e.preventDefault();
  }

  // 键盘挂在 window 上：切换条目时旧的焦点元素会被卸载，挂在面板上会丢事件
  const keyRef = useRef(onKey); keyRef.current = onKey;
  useEffect(() => { const h = (e: KeyboardEvent) => keyRef.current(e); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, []);

  const promos = (entries ?? []).filter((e): e is Extract<Entry, { kind: 'promotion' }> => e.kind === 'promotion');
  const approvals = (entries ?? []).filter((e): e is Extract<Entry, { kind: 'approval' }> => e.kind === 'approval');
  const groups = Object.keys(BENCH).map(b => ({ b, list: promos.filter(e => e.p.source.bench === b) })).filter(g => g.list.length);
  const actionable = (entries ?? []).filter(e => !(e.kind === 'approval' && e.a.state === 'indeterminate'));
  const total = actionable.length, handled = Object.keys(done).length;
  const allDone = entries !== null && pending.length === 0;

  const row = (e: Entry) => {
    const id = idOf(e), d = done[id];
    const title = e.kind === 'promotion' ? (e.p.items.length > 1 ? `${e.p.items[0].key} 等 ${e.p.items.length} 条` : e.p.items[0].key) : e.a.title;
    const exp = e.kind === 'promotion' ? left(e.p.expiresAt) : null;
    return <button key={id} className="ibx-row" aria-current={id === sel || undefined} data-done={d || undefined} onClick={() => { setSel(id); setEditing(null); }}>
      <span className="ibx-tag" data-k={e.kind === 'promotion' ? TARGET[e.p.target].layer : e.a.kind === 'question' ? 'ask' : e.a.risk}>{e.kind === 'promotion' ? TARGET[e.p.target].layer : e.a.kind === 'question' ? '问' : e.a.risk === 'danger' ? '危' : '写'}</span>
      <span className="ibx-row-main"><b>{title}</b><small>{e.kind === 'promotion' ? `${TARGET[e.p.target].name} · ${e.p.source.dossierTitle}` : e.a.state === 'indeterminate' ? '结果未知 · 等待核对' : `${BENCH[e.a.source.bench]?.name ?? e.a.source.bench} · ${e.a.source.dossierTitle}`}</small></span>
      {d ? <em className="ibx-stamp-s">{DONE_TEXT[d]}</em> : exp ? <em className="ibx-exp" data-soon={exp.soon || undefined}>{exp.text.replace('后作废', '')}</em> : null}
    </button>;
  };

  return <div className="ibx-scrim" role="dialog" aria-modal="true" aria-label="上线时待批准">
    <section className="ibx" ref={sheet} tabIndex={-1}>
      <header className="ibx-head">
        <span className="ibx-mark">INBOX</span>
        <div className="ibx-title"><strong>上线时待批准</strong>
          <span>{entries === null ? '正在读取…' : entries.length === 0 ? '你离开期间没有新的待办' : `你离开期间：${promos.length} 条提议记住 · ${approvals.length} 个动作等你确认`}</span></div>
        <div className="ibx-progress" aria-label={`已处理 ${handled} / ${total}`}>{actionable.map(e => <i key={idOf(e)} data-on={done[idOf(e)] ? true : undefined} data-cur={idOf(e) === sel || undefined} />)}<small>{handled} / {total}</small></div>
        <button className="ibx-later" onClick={onClose}>稍后处理<kbd>Esc</kbd></button>
      </header>

      <div className="ibx-body">
        <nav className="ibx-list" aria-label="待处理">
          {groups.length > 0 && <h3>提议记住 <small>不批准就不生效</small></h3>}
          {groups.map(g => <div key={g.b} className="ibx-group"><header><code>{BENCH[g.b].code}</code>{BENCH[g.b].name}<small>{g.list.length}</small></header>{g.list.map(row)}</div>)}
          {approvals.length > 0 && <h3>待确认动作 <small>只放行这一次</small></h3>}
          {approvals.length > 0 && <div className="ibx-group">{approvals.map(row)}</div>}
          {entries?.length === 0 && <p className="ibx-empty">没有待处理的事项。</p>}
        </nav>

        <article className="ibx-detail" aria-live="polite">
          {entries === null ? <p className="ibx-loading">正在读取收件箱…</p>
            : allDone && !cur ? <div className="ibx-clear"><span className="ibx-bigstamp">{handled ? '已清空' : '无待办'}</span><p>{handled ? `处理了 ${handled} 件事。批准的内容从下一次读取开始生效，驳回的不会再提。` : '你离开期间没有需要你决定的事。AI 提议记住什么、或者有动作要你确认时，会出现在这里。'}</p><button className="ibx-go" onClick={onClose}>进入终端</button></div>
            : cur?.kind === 'promotion' ? <PromotionView p={cur.p} d={done[cur.p.id]} editing={editing} setEditing={setEditing} openEv={openEv} toggle={toggleEvidence} old={old} />
            : cur?.kind === 'approval' ? <ApprovalView a={cur.a} d={done[cur.a.id]} answers={answers[cur.a.id] ?? []} setAnswers={v => setAnswers(m => ({ ...m, [cur.a.id]: v }))} />
            : <p className="ibx-loading">选一条开始处理。</p>}
        </article>
      </div>

      <footer className="ibx-actions">
        {error && <p className="ibx-error" role="alert">{error}</p>}
        {cur?.kind === 'promotion' && !done[cur.p.id] && (editing
          ? <><span className="ibx-hint">改完后保存，等于「改一下再批准」</span><button className="ibx-btn" onClick={() => setEditing(null)} disabled={busy}>取消</button><button className="ibx-btn is-solid" onClick={saveEdit} disabled={busy}>保存并批准</button></>
          : <><span className="ibx-hint" data-soon={left(cur.p.expiresAt).soon || undefined}>{left(cur.p.expiresAt).text} · 不会默认通过</span>
            <button className="ibx-btn" onClick={() => decide({ decision: 'reject' })} disabled={busy}>驳回<kbd>R</kbd></button>
            <button className="ibx-btn" onClick={() => decide({ decision: 'keep_local' })} disabled={busy}>只存本档案<kbd>L</kbd></button>
            <button className="ibx-btn" onClick={startEdit} disabled={busy}>改一下再批准<kbd>E</kbd></button>
            <button className="ibx-btn is-solid" onClick={() => decide({ decision: 'approve' })} disabled={busy}>批准<kbd>A</kbd></button></>)}
        {cur?.kind === 'approval' && !done[cur.a.id] && (cur.a.state === 'indeterminate'
          ? <span className="ibx-hint">这个动作已经发出、结果未知；不会自动重发，核对完会自动从这里消失。</span>
          : cur.a.kind === 'question'
          ? <><span className="ibx-hint">{answered(cur.a) ? '回答会原样交给提问的 Agent' : '每个问题都要回答后才能提交'}</span>
            <button className="ibx-btn" onClick={() => decide('reject-once')} disabled={busy}>不回答<kbd>R</kbd></button>
            <button className="ibx-btn is-solid" onClick={() => decide('approve-once')} disabled={busy || !answered(cur.a)}>提交回答<kbd>A</kbd></button></>
          : <><span className="ibx-hint">{RISK_TEXT[cur.a.risk]} · 只放行这一次，参数变了要重新批准</span>
            <button className="ibx-btn" onClick={() => decide('reject-once')} disabled={busy}>驳回<kbd>R</kbd></button>
            <button className="ibx-btn is-solid" onClick={() => decide('approve-once')} disabled={busy}>批准这一次<kbd>A</kbd></button></>)}
        {cur && done[idOf(cur)] && <span className="ibx-hint">{DONE_TEXT[done[idOf(cur)]]} · 正在跳到下一条</span>}
      </footer>
    </section>
  </div>;
}

function Source({ s, at }: { s: InboxPromotion['source']; at?: string }) {
  const b = BENCH[s.bench];
  return <p className="ibx-src"><code>{b?.code ?? s.bench}</code>{b?.name ?? s.bench} · 《{s.dossierTitle}》 · {s.roleId}{at && <> · {ago(at)}</>}{s.href && <a href={s.href}>打开档案 ↗</a>}</p>;
}

function PromotionView({ p, d, editing, setEditing, openEv, toggle, old }: {
  p: InboxPromotion; d?: Done; editing: (Record<string, string> | string)[] | null; setEditing: (v: (Record<string, string> | string)[]) => void;
  openEv: Record<string, EvidenceView | 'loading' | 'missing'>; toggle: (ref: string) => void; old: Record<string, SupersededView | null>;
}) {
  const t = TARGET[p.target];
  return <div className="ibx-doc" key={p.id}>
    {d && <span className="ibx-bigstamp" data-k={d}>{DONE_TEXT[d]}</span>}
    <div className="ibx-meta"><span className="ibx-layer"><b>{t.layer}</b>{t.name}</span><Source s={p.source} at={p.createdAt} /></div>
    <h2>要记住 {p.items.length} 件事</h2>
    <ol className="ibx-items">{p.items.map((it, i) => <li key={it.key}>
      <h4><em>{String(i + 1).padStart(2, '0')}</em>{it.key}</h4>
      {editing ? (typeof editing[i] === 'string'
        ? <textarea aria-label={`修改：${it.key}`} value={editing[i] as string} rows={3} onChange={e => setEditing(editing.map((x, k) => k === i ? e.target.value : x))} />
        : <div className="ibx-edit-kv">{Object.entries(editing[i] as Record<string, string>).map(([k, x]) => <label key={k}><span>{k}</span><input value={x} onChange={e => setEditing(editing.map((y, j) => j === i ? { ...(y as Record<string, string>), [k]: e.target.value } : y))} /></label>)}</div>)
        : <Value v={it.value} />}
      {it.supersedes && <div className="ibx-old"><small>将替换旧条目</small>{old[it.supersedes] ? <s>{typeof old[it.supersedes]!.value === 'string' ? old[it.supersedes]!.value as string : JSON.stringify(old[it.supersedes]!.value)}</s> : <s>读取中…</s>}</div>}
      <div className="ibx-ev"><small>依据</small>{it.evidence.map(ref => { const v = openEv[ref]; return <button key={ref} aria-expanded={!!v && v !== 'loading'} onClick={() => toggle(ref)}>{v && typeof v === 'object' ? v.kind : '依据'} {it.evidence.indexOf(ref) + 1}</button>; })}</div>
      {it.evidence.map(ref => { const v = openEv[ref]; if (!v) return null; return <blockquote key={ref} className="ibx-quote">
        {v === 'loading' ? '正在读取原文…' : v === 'missing' ? '这条依据已经找不到了。批准前建议先驳回或只存本档案。' : <><b>{v.title}</b><q>{v.quote}</q><footer>{v.kind} · {ago(v.at)}{v.href && <a href={v.href}>回到原对话 ↗</a>}</footer></>}
      </blockquote>; })}
    </li>)}</ol>
    <section className="ibx-why"><h5>为什么值得记住</h5><p>{p.reason}</p></section>
    <section className="ibx-effect"><h5>会影响什么</h5><p>{t.effect}。处理之前，相关读取仍用旧版本。</p></section>
  </div>;
}

function ApprovalView({ a, d, answers, setAnswers }: { a: InboxApproval; d?: Done; answers: string[][]; setAnswers: (v: string[][]) => void }) {
  return <div className="ibx-doc" key={a.id}>
    {d && <span className="ibx-bigstamp" data-k={d}>{DONE_TEXT[d]}</span>}
    <div className="ibx-meta"><span className="ibx-layer" data-risk={a.risk}><b>{a.kind === 'question' ? '提问' : a.risk === 'danger' ? '危险' : '写入'}</b>{a.kind === 'question' ? 'AI 在问你' : a.kind}</span><Source s={a.source} /></div>
    <h2>{a.title}</h2>
    {a.questions && <Questions qs={a.questions} answers={answers} set={setAnswers} locked={!!d} />}
    {a.state === 'indeterminate' && <p className="ibx-warn"><b>结果未知</b>上次批准后已经发出，但没有收到结果。为了不重复执行，这里不会再发一次；核对完会自动消失。</p>}
    <section className="ibx-effect"><h5>会发生什么</h5><ul>{a.effects.map(x => <li key={x}>{x}</li>)}</ul></section>
    <section className="ibx-why"><h5>为什么在这里</h5><p>{a.kind === 'question' ? '提问的 Agent 停在这里等你；回答只对这一次运行有效，不会写进长期记忆。' : '这个动作不阻塞运行，所以等你上线时一起处理。批准只放行这一次；参数一变就要重新批准。'}</p></section>
  </div>;
}

/** 原生问题：单选 / 多选；允许自定义时可以写自己的答案。答案按题目顺序组成 string[][]。 */
function Questions({ qs, answers, set, locked }: { qs: InboxQuestion[]; answers: string[][]; set: (v: string[][]) => void; locked: boolean }) {
  const [own, setOwn] = useState<Record<number, string>>({});
  const at = (i: number) => answers[i] ?? [];
  const put = (i: number, v: string[]) => set(qs.map((_, k) => (k === i ? v : at(k))));
  const pick = (i: number, label: string) => {
    const q = qs[i], cur = at(i);
    put(i, q.multiple ? (cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label]) : [label]);
  };
  return <ol className="ibx-qs">{qs.map((q, i) => {
    const allowOwn = q.custom !== false, mine = own[i] ?? '';
    return <li key={i}>
      <h4><em>{q.header}</em>{q.question}<small>{q.multiple ? '可多选' : '单选'}</small></h4>
      <div className="ibx-opts" role={q.multiple ? 'group' : 'radiogroup'} aria-label={q.question}>
        {q.options.map(o => { const on = at(i).includes(o.label); return <button key={o.label} role={q.multiple ? 'checkbox' : 'radio'} aria-checked={on} disabled={locked} onClick={() => pick(i, o.label)}>
          <i aria-hidden="true" data-multi={q.multiple || undefined} /><span><b>{o.label}</b><small>{o.description}</small></span></button>; })}
      </div>
      {allowOwn && <label className="ibx-own"><span>自己写</span><input value={mine} disabled={locked} placeholder="都不合适时写你的答案"
        onChange={e => { const v = e.target.value; setOwn(m => ({ ...m, [i]: v })); const base = at(i).filter(x => q.options.some(o => o.label === x)); put(i, v.trim() ? (q.multiple ? [...base, v.trim()] : [v.trim()]) : (q.multiple ? base : [])); }} /></label>}
    </li>;
  })}</ol>;
}
