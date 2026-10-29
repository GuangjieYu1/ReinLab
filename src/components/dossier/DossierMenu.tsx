import { useEffect, useRef, useState } from 'react';
import type { Artifact, BenchId, Confirmation, Dossier, DossierSummary } from './adapter';
import { DossierError } from './adapter';
import { dossiers, useBenchDossiers, when } from './store';
import './dossier.css';

const WORK: Record<DossierSummary['work']['state'], string> = { idle: '', running: '运行中', waiting: '等你处理', failed: '上次失败' };
const LIFE: Record<DossierSummary['lifecycle'], string> = { active: '进行中', completed: '已完成', archived: '已归档' };
const KIND_LABEL: Record<Artifact['kind'], string> = { paper: '论文', layer: '讲解', finding: '发现', quiz: '检验题', course_plan: '课程计划', course: '课程', file: '文件' };

/** 工作台头部的档案菜单：真实列表、搜索、归档视图、新建；当前档案的改名 / 目标 / 完成 / 归档 / 删除和成果。 */
export default function DossierMenu({ bench, noun, current, onSwitch, onConfirm, onOpenArtifact }: {
  bench: BenchId; noun: string; current: Dossier | null;
  onSwitch: (id: string) => void;
  onConfirm: (c: Confirmation) => void;
  onOpenArtifact: (a: Artifact) => void;
}) {
  const [q, setQ] = useState('');
  const [view, setView] = useState<'active' | 'archived'>('active');
  const { items, error, reload } = useBenchDossiers(bench, { q: q || undefined, view });
  const [editing, setEditing] = useState<'title' | 'intent' | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [arts, setArts] = useState<Artifact[] | null>(null);
  // 学习台：把已有课程加入当前学习档案（只建立关联，不复制、不重新生成课程）
  const [picking, setPicking] = useState<{ courseId: string; title: string; progress: number | null }[] | null>(null);
  const pickCourse = () => run(async () => setPicking(await dossiers().courses()));
  const attach = (courseId: string) => current && run(async () => { await dossiers().attachCourse(current.id, courseId); setPicking(null); setArts(await dossiers().artifacts(current.id)); });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (current) dossiers().artifacts(current.id).then(setArts, () => setArts([])); else setArts(null); }, [current?.id, current?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (editing || creating) input.current?.focus(); }, [editing, creating]);

  const run = async (f: () => Promise<unknown>) => {
    setMsg(null);
    try { await f(); await reload(); }
    catch (e) { setMsg(e instanceof DossierError || e instanceof Error ? e.message : '没有成功，请重试'); }
  };
  const save = () => current && run(async () => {
    await dossiers().update(current.id, { baseVersion: current.version, ...(editing === 'title' ? { title: draft } : { intent: draft }) });
    setEditing(null);
  });
  const create = () => run(async () => {
    const d = await dossiers().create({ bench, ...(newTitle.trim() ? { title: newTitle.trim() } : {}) });
    setCreating(false); setNewTitle(''); onSwitch(d.id);
  });

  return <div className="dm" role="dialog" aria-label={`${noun}档案`}>
    {current && <section className="dm-cur">
      <span className="rh-micro">当前档案 · {LIFE[current.lifecycle]}{WORK[current.work.state] && ` · ${WORK[current.work.state]}`}</span>
      {editing === 'title'
        ? <form onSubmit={e => { e.preventDefault(); void save(); }}><input ref={input} value={draft} onChange={e => setDraft(e.target.value)} aria-label="档案标题" /><button className="rh-btn is-solid">保存</button><button type="button" className="rh-btn" onClick={() => setEditing(null)}>取消</button></form>
        : <h3>{current.title}<button className="dm-link" onClick={() => { setDraft(current.title); setEditing('title'); }}>改名</button></h3>}
      {editing === 'intent'
        ? <form onSubmit={e => { e.preventDefault(); void save(); }}><input ref={input} value={draft} onChange={e => setDraft(e.target.value)} aria-label="目标 / 简介" placeholder="这份档案要做什么" /><button className="rh-btn is-solid">保存</button><button type="button" className="rh-btn" onClick={() => setEditing(null)}>取消</button></form>
        : <p className="dm-intent">{current.intent ?? <em>还没写目标</em>}<button className="dm-link" onClick={() => { setDraft(current.intent ?? ''); setEditing('intent'); }}>{current.intent ? '修改目标' : '写目标'}</button></p>}
      {current.progress && <small className="dm-progress">{current.progress}</small>}
      <div className="dm-acts">
        {current.lifecycle !== 'archived' && <button className="rh-btn" onClick={() => void run(() => dossiers().update(current.id, { baseVersion: current.version, lifecycle: current.lifecycle === 'completed' ? 'active' : 'completed' }))}>{current.lifecycle === 'completed' ? '恢复进行中' : '标为完成'}</button>}
        {current.lifecycle === 'archived'
          ? <button className="rh-btn" onClick={() => void run(() => dossiers().unarchive(current.id))}>取消归档</button>
          : <button className="rh-btn" onClick={() => void run(async () => { const r = await dossiers().archive(current.id); if ('confirmation' in r) onConfirm(r.confirmation); })}>归档</button>}
        <button className="rh-btn dm-danger" onClick={() => void run(async () => onConfirm((await dossiers().remove(current.id)).confirmation))}>删除</button>
      </div>
      {bench === 'curriculum' && (picking
        ? <div className="dm-arts"><span className="rh-micro">选一门已有课程加入 · {picking.length}</span>
            {picking.length === 0 ? <p className="dm-empty">没有可加入的课程（本地 OpenMAIC 里还没有课程，或暂时连不上）。</p>
              : picking.map(c => <button key={c.courseId} className="dm-art" onClick={() => void attach(c.courseId)}><em>课程</em><b>{c.title}</b>{c.progress !== null && <small style={{ color: 'inherit' }}>已学 {Math.round(c.progress * 100)}%</small>}</button>)}
            <button className="dm-link" onClick={() => setPicking(null)}>收起</button></div>
        : <button className="dm-add" onClick={() => void pickCourse()}>＋ 加入已有课程</button>)}
      {arts && arts.length > 0 && <div className="dm-arts"><span className="rh-micro">成果 · {arts.length}</span>
        {arts.map(a => <button key={a.id} className="dm-art" disabled={a.status !== 'available' || a.open.to === 'none'} onClick={() => onOpenArtifact(a)}><em>{KIND_LABEL[a.kind]}</em><b>{a.title}</b>{a.status === 'missing' && <small>不可访问</small>}</button>)}
      </div>}
    </section>}

    <section className="dm-list">
      <div className="dm-tools">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={`搜索${noun}`} aria-label={`搜索${noun}`} />
        <div className="dm-seg" role="tablist"><button aria-selected={view === 'active'} onClick={() => setView('active')}>进行中</button><button aria-selected={view === 'archived'} onClick={() => setView('archived')}>已归档</button></div>
      </div>
      {error && <p className="dm-msg">{error}</p>}
      {items === null ? <p className="dm-empty">正在读取…</p> : items.length === 0 ? <p className="dm-empty">{q ? '没有匹配的档案' : view === 'archived' ? '没有归档的档案' : `这个工作台还没有${noun}档案`}</p>
        : <ol>{items.map(d => <li key={d.id}><button aria-current={d.id === current?.id || undefined} onClick={() => onSwitch(d.id)}>
          <b>{d.title}</b>
          <small>{[when(d.lastActivityAt), d.progress, WORK[d.work.state], d.pending ? `${d.pending} 件待处理` : '', d.artifacts.total ? `${d.artifacts.total} 项成果` : ''].filter(Boolean).join(' · ')}</small>
        </button></li>)}</ol>}
      {creating
        ? <form className="dm-new" onSubmit={e => { e.preventDefault(); void create(); }}><input ref={input} value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="标题（可以先不填）" aria-label="新档案标题" /><button className="rh-btn is-solid">新建</button><button type="button" className="rh-btn" onClick={() => setCreating(false)}>取消</button></form>
        : <button className="dm-add" onClick={() => setCreating(true)}>＋ 新建{noun}档案</button>}
    </section>
    {msg && <p className="dm-msg" role="alert">{msg}</p>}
  </div>;
}
