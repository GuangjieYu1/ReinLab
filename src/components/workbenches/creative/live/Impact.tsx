import { useEffect, useMemo, useState } from 'react';
import type { CheckRun, ImpactItem, ImpactReport, ItemChange, Work, WorkOp, WorldSnapshot, WorldVersion } from '../../../../../packages/contracts/src/creative';
import type { CreativeAdapter } from './adapter';

// 1C（契约 20 §6.5）：版本面板（左栏）、影响面板（右栏「影响」页）。
// 服务端算好版本差异、影响清单和检查试算，这里只排版和发操作。

const CHANGE_ZH: Record<ItemChange['change'], string> = { add: '新增', update: '修改', remove: '删除' };
const KIND_ZH: Record<string, string> = { entity: '实体', relation: '关系', event: '事件', mode: '交通方式', rule: '规则', edit: '改造层' };
const money = (c: { value: number | null; known: boolean }) => c.known && c.value != null ? `¥${c.value.toFixed(3)}` : '用量未知';

/** 前后对照：只列顶层里真变了的字段，值截短。fields 是服务端给的人话字段名，放在标题行。 */
function diffKeys(before: unknown, after: unknown) {
  const a = (before ?? {}) as Record<string, unknown>, b = (after ?? {}) as Record<string, unknown>;
  const show = (v: unknown) => { if (v == null) return '—'; const t = typeof v === 'string' ? v : JSON.stringify(v); return t.length > 90 ? t.slice(0, 90) + '…' : t; };
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(k => !['id', 'origin', 'status', 'gaps', 'workRefs', 'overriddenBy', 'setting'].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map(k => ({ k, from: show(a[k]), to: show(b[k]) }));
}

export function ChangeRow({ c, open }: { c: ItemChange; open?: boolean }) {
  const rows = c.change === 'update' ? diffKeys(c.before, c.after) : [];
  return <details className="ci-change" data-change={c.change} open={open}>
    <summary><em>{CHANGE_ZH[c.change]}</em><b>{c.title}</b><small>{KIND_ZH[c.kind] ?? c.kind}{c.fields.length ? ` · ${c.fields.join('、')}` : ''}</small></summary>
    {rows.length > 0 && <dl>{rows.map(r => <div key={r.k}><dt>{r.k}</dt><dd><del>{r.from}</del><ins>{r.to}</ins></dd></div>)}</dl>}
    {c.change !== 'update' && <p className="cw-muted">{c.change === 'add' ? '这一版新加的。' : '这一版删掉了。'}</p>}
  </details>;
}

/** 左栏「版本」：列表、点开看这一版改了什么、只读打开；保存前先看草稿差异。 */
export function VersionsPanel({ adapter, snap, viewing, onView, onSave, busy, readOnly }: {
  adapter: CreativeAdapter; snap: WorldSnapshot; viewing: number | null; busy: boolean; readOnly: boolean;
  onView: (n: number) => void; onSave: (summary: string) => Promise<void>;
}) {
  const [open, setOpen] = useState<number | null>(null), [detail, setDetail] = useState<Record<number, WorldVersion>>({});
  const [draft, setDraft] = useState<ItemChange[] | null>(null), [summary, setSummary] = useState(''), [err, setErr] = useState('');
  const toggle = (n: number) => {
    setOpen(open === n ? null : n);
    if (!detail[n]) adapter.version(n).then(v => setDetail(d => ({ ...d, [n]: v })), e => setErr((e as Error).message));
  };
  const peek = () => { setErr(''); adapter.draftDiff().then(r => setDraft(r.items), e => setErr((e as Error).message)); };
  return <div className="ci-versions">
    {!readOnly && (draft ? <div className="ci-draft">
      <span className="rh-micro">草稿上没成版的改动 · {draft.length} 条</span>
      {draft.length ? draft.map(c => <ChangeRow key={c.itemId} c={c} />) : <p className="cw-muted">草稿和最新版本一样，没有可存的改动。</p>}
      {draft.length > 0 && <><input value={summary} onChange={e => setSummary(e.target.value)} placeholder="这一版改了什么（一句话）" />
        <div className="cw-row"><button className="rh-btn is-solid" disabled={busy} onClick={() => void onSave(summary.trim() || '手动保存').then(() => { setDraft(null); setSummary(''); })}>保存为 v{(snap.versions.at(-1)?.n ?? 0) + 1}</button><button className="rh-btn" onClick={() => setDraft(null)}>先不存</button></div></>}
    </div> : <button className="rh-btn" disabled={busy} onClick={peek}>保存为版本…{snap.world.version.draftChanges ? `（草稿有 ${snap.world.version.draftChanges} 处改动）` : ''}</button>)}
    {err && <p role="alert">{err}</p>}
    <ol className="ci-vlist">{snap.versions.slice().reverse().map(v => <li key={v.n} aria-current={viewing === v.n || undefined}>
      <button onClick={() => toggle(v.n)}><b>v{v.n}</b><span>{v.summary}</span><small>{new Date(v.at).toLocaleDateString()} · 改了 {v.changes} 条</small></button>
      {open === v.n && <div className="ci-vbody">
        {detail[v.n]?.items ? detail[v.n].items!.map(c => <ChangeRow key={c.itemId} c={c} />) : <p className="cw-muted">载入中…</p>}
        <button className="rh-btn" onClick={() => onView(v.n)}>只读打开这一版</button>
      </div>}
    </li>)}</ol>
  </div>;
}

const checkLine = (c: CheckRun | null) => {
  if (!c) return '没试算';
  const hard = c.conflicts.filter(x => x.severity === 'hard').length, sus = c.conflicts.filter(x => x.severity === 'suspect').length;
  return hard || sus ? `采用后：红 ${hard} · 黄 ${sus}` : '采用后：没查出冲突';
};

/** 右栏「影响」：按原因分组，每组列条目变化、确定和可能受影响的地方、每部作品的选择。 */
export function ImpactPanel({ adapter, snap, works, onOpenScene, onEditItem, onWorksChanged }: {
  adapter: CreativeAdapter; snap: WorldSnapshot; works: Work[];
  onOpenScene: (ref: { workId: string; chapterId?: string; sceneId?: string }) => void;
  onEditItem: (c: ItemChange) => void; onWorksChanged: () => void;
}) {
  const latest = snap.versions.at(-1)?.n ?? 0;
  const oldest = works.length ? Math.min(...works.map(w => w.setting?.baseVersion ?? w.baseVersion)) : Math.max(1, latest - 1);
  const [from, setFrom] = useState(Math.min(oldest, latest)), [to, setTo] = useState(latest);
  useEffect(() => { setTo(latest); }, [latest]);
  const [rep, setRep] = useState<ImpactReport | null>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const load = () => { if (from >= to) { setRep(null); return; } setErr(''); adapter.impact(from, to).then(setRep, e => setErr((e as Error).message)); };
  useEffect(load, [adapter, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  // 扫正文是异步的：在跑就隔两秒再取一次
  useEffect(() => { if (rep?.maybeScan.state !== 'running') return; const t = setTimeout(load, 2000); return () => clearTimeout(t); }, [rep]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => { const m = new Map<string, ImpactItem[]>(); for (const it of rep?.items ?? []) m.set(it.group, [...(m.get(it.group) ?? []), it]); return [...m]; }, [rep]);
  const title = (id: string) => works.find(w => w.id === id)?.title ?? id.slice(0, 8);
  const decide = async (workId: string, op: WorkOp) => {
    setBusy(true); setErr('');
    try { const w = await adapter.work(workId); await adapter.workOps(workId, w.revision, [op]); onWorksChanged(); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const scan = () => { setErr(''); adapter.impactScan(from, to).then(s => setRep(r => r ? { ...r, maybeScan: s } : r), e => setErr((e as Error).message)); };
  const sceneName = (r: { workId: string; chapterId: string; sceneId: string }) => {
    const w = works.find(x => x.id === r.workId), ch = w?.chapters.find(c => c.id === r.chapterId), sc = ch?.scenes.find(s => s.id === r.sceneId);
    return `《${w?.title ?? '作品'}》${ch ? ` · ${ch.title}` : ''}${sc ? ` · ${sc.title}` : ''}`;
  };
  const versions = snap.versions.map(v => v.n);
  return <div className="cw-pane ci-impact">
    <div className="ci-range"><span>从</span><select value={from} onChange={e => setFrom(Number(e.target.value))}>{versions.map(n => <option key={n} value={n}>v{n}</option>)}</select>
      <span>到</span><select value={to} onChange={e => setTo(Number(e.target.value))}>{versions.map(n => <option key={n} value={n}>v{n}</option>)}</select>
      <small>{rep ? `${rep.items.length} 条改动` : ''}</small></div>
    {from >= to && <p className="cw-muted">选两个不同的版本，看后一版对各部作品的影响。</p>}
    {rep && <div className="ci-scan" data-state={rep.maybeScan.state}>
      <span>可能受影响（AI 读正文找的）：{{ none: '还没扫', running: '正在扫…', done: '扫过了', failed: `扫失败：${rep.maybeScan.error ?? ''}` }[rep.maybeScan.state]} · {money(rep.maybeScan.cost)}</span>
      <button className="rh-btn" disabled={rep.maybeScan.state === 'running'} onClick={scan}>{rep.maybeScan.state === 'done' ? '重新扫一遍' : '让 AI 扫一遍正文'}</button>
    </div>}
    {err && <p role="alert">{err}</p>}
    {groups.map(([g, items]) => <section key={g} className="ci-group">
      <h4>{g}</h4>
      {items.map(it => <article key={it.change.itemId} className="ci-item">
        <ChangeRow c={it.change} />
        {it.sure.length > 0 && <div className="ci-refs"><span className="rh-micro">确定受影响 · {it.sure.length}</span>
          <ul>{it.sure.map((r, i) => <li key={i}>{r.kind === 'scene' ? <button className="cw-link" onClick={() => onOpenScene({ workId: r.workId, chapterId: r.chapterId, sceneId: r.sceneId })}>{sceneName(r)} ↗</button> : <span>{r.kind === 'event' ? `事件 ${snap.events.find(e => e.id === r.eventId)?.title ?? r.eventId.slice(0, 8)}` : '一段路线'}</span>}<small>{r.why}</small></li>)}</ul></div>}
        {it.maybe.length > 0 && <div className="ci-refs ci-maybe"><span className="rh-micro">可能受影响 · {it.maybe.length} · AI 找的，可能不准</span>
          <ul>{it.maybe.map((r, i) => <li key={i}>{r.kind === 'scene' ? <button className="cw-link" onClick={() => onOpenScene({ workId: r.workId, chapterId: r.chapterId, sceneId: r.sceneId })}>{sceneName(r)} ↗</button> : null}<q>{r.quote}</q><small>{r.why}</small></li>)}</ul></div>}
        {it.works.length > 0 && <div className="ci-works">{it.works.map(w => <div key={w.workId} className="ci-work" data-uses={w.uses}>
          <p><b>《{title(w.workId)}》</b><span>{{ old: '用旧版', new: '用新版', override: '本作品改写' }[w.uses]}{w.decision ? ` · ${w.decision === 'follow' ? '已跟着改' : '已保留旧版'}` : ''}</span><small data-bad={!!w.checkAfter?.conflicts.length || undefined}>{checkLine(w.checkAfter)}</small></p>
          <div className="ci-acts">{w.uses === 'old' && !w.decision && <>
            <button className="rh-btn is-solid" disabled={busy} onClick={() => void decide(w.workId, { op: 'setting.follow', itemId: it.change.itemId, toVersion: to })}>跟着改</button>
            <button className="rh-btn" disabled={busy} onClick={() => void decide(w.workId, { op: 'setting.keep', itemId: it.change.itemId, toVersion: to })}>保留旧版</button></>}
            <button className="rh-btn" onClick={() => onEditItem(it.change)}>改设定</button></div>
        </div>)}</div>}
      </article>)}
    </section>)}
    {rep && !rep.items.length && <p className="cw-muted">这两个版本之间没有改动。</p>}
  </div>;
}
