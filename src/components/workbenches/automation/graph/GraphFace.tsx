import { useEffect, useState } from 'react';
import { DEF, type GGroup, type GLink, type GNode, type Output, type Workflow } from './graphModel';
import type { Live, QItem } from './useGraphRunner';
import GraphCanvas from './GraphCanvas';
import Art from './Art';
import './graph.css';

// 节点面：上面是工作区的标签栏（照 ComfyUI-Workspace-Manager：多开、未保存圆点、版本、保存），
// 中间是节点画布，右上角浮着队列面板（照 ComfyUI 的菜单：排队运行 · 批次 · 队列与历史），
// 「发布为工具」把选中的参数暴露出去，例程用 @工具名 调用。

export default function GraphFace({ fitKey, workflows, open, cur, onTab, onCloseTab, onChange, live, errors, latest, queue, installed, onQueue, onClearQueue, onSave, onSaveVersion, onRestore, onPublish, onOpenRoutine, dockOpen, onDock, lightbox, onLightbox, onUseSeed }: {
  fitKey: number; workflows: Workflow[]; open: string[]; cur: string; onTab: (id: string) => void; onCloseTab: (id: string) => void;
  onChange: (id: string, p: { nodes?: GNode[]; links?: GLink[]; groups?: GGroup[] }) => void;
  live: Live | null; errors: Record<string, string>; latest: Output[] | undefined; queue: QItem[]; installed: (name: string) => boolean;
  onQueue: (count: number) => void; onClearQueue: () => void; onSave: () => void; onSaveVersion: () => void; onRestore: (v: string) => void;
  onPublish: (toolId: string, params: string[]) => void; onOpenRoutine: (id: string) => void;
  dockOpen: boolean; onDock: () => void; lightbox: Output | null; onLightbox: (o: Output | null) => void; onUseSeed: (o: Output) => void;
}) {
  const wf = workflows.find(w => w.id === cur)!;
  const [batch, setBatch] = useState(1);
  const [pop, setPop] = useState<'ver' | 'pub' | null>(null);
  const [toolId, setToolId] = useState(wf.tool?.id ?? '');
  const [params, setParams] = useState<string[]>(wf.tool?.params ?? []);
  useEffect(() => { setToolId(wf.tool?.id ?? `graph_${wf.id.slice(4)}`); setParams(wf.tool?.params ?? []); setPop(null); }, [wf.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ctrl/⌘ + Enter 排队，Ctrl/⌘ + S 保存（同 ComfyUI / Workspace Manager）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'Enter') { e.preventDefault(); onQueue(batch); }
      if (e.key.toLowerCase() === 's') { e.preventDefault(); onSave(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [batch, onQueue, onSave]);
  const candidates = wf.nodes.flatMap(n => DEF[n.type].widgets.filter(w => !w.model && w.name !== 'control_after_generate').map(w => ({ key: `${n.id}.${w.name}`, node: n.title ?? DEF[n.type].title, w: w.name, v: n.v[w.name] })));
  const running = queue.find(q => q.status === 'running'), pending = queue.filter(q => q.status === 'pending').length;

  return <div className="gf">
    <div className="gf-tabs">
      {open.map(id => { const w = workflows.find(x => x.id === id)!; return <div key={id} className="gf-tab" aria-current={id === cur || undefined}>
        <button onClick={() => onTab(id)}>{!w.saved && <i title="有未保存的改动" />}{w.name}</button>
        {open.length > 1 && <button className="gf-x" onClick={() => onCloseTab(id)} aria-label={`关闭 ${w.name}`}>×</button>}
      </div>; })}
      <span className="gf-path rh-micro">{wf.folder} / {wf.id}{wf.tags.map(t => <em key={t}>{t}</em>)}</span>
      <div className="gf-act">
        <div className="gf-popwrap"><button onClick={() => setPop(p => p === 'ver' ? null : 'ver')} aria-expanded={pop === 'ver'}>{wf.versions[0].v} ▾</button>
          {pop === 'ver' && <div className="gf-pop"><span className="rh-micro">版本 · VERSIONS</span><ol>{wf.versions.map((v, i) => <li key={v.v + i}><b>{v.v}</b><time>{v.at}</time><span>{v.note}</span>{i > 0 && <button onClick={() => { onRestore(v.v); setPop(null); }}>恢复</button>}</li>)}</ol>
            <button className="rh-btn" onClick={() => { onSaveVersion(); setPop(null); }}>存为新版本</button></div>}</div>
        <button onClick={onSave} disabled={wf.saved}>{wf.saved ? '已保存' : '保存'}</button>
        <div className="gf-popwrap"><button className={wf.tool?.published ? 'is-pub' : ''} onClick={() => setPop(p => p === 'pub' ? null : 'pub')} aria-expanded={pop === 'pub'}>{wf.tool?.published ? `@${wf.tool.id}` : '发布为工具'}</button>
          {pop === 'pub' && <div className="gf-pop is-pub">
            <span className="rh-micro">发布为例程工具 · 例程用 @工具名 调用</span>
            <label className="gf-toolid"><i>@</i><input value={toolId} onChange={e => setToolId(e.target.value.replace(/[^\w]/g, ''))} /></label>
            <p>暴露的参数（例程调用时可以改）：</p>
            <ul className="gf-params">{candidates.map(c => <li key={c.key}><label><input type="checkbox" checked={params.includes(c.key)} onChange={e => setParams(p => e.target.checked ? [...p, c.key] : p.filter(x => x !== c.key))} />
              <b>{c.node}</b><code>{c.w}</code><small>{String(c.v).slice(0, 18)}</small></label></li>)}</ul>
            <p>输出：{wf.nodes.filter(n => DEF[n.type].output).map(n => n.title ?? DEF[n.type].title).join('、')}{wf.nodes.some(n => DEF[n.type].write) && <em> · 含写入，例程里默认「询问」</em>}</p>
            {wf.tool?.usedBy.length ? <p className="gf-used">被引用：{wf.tool.usedBy.map(r => <button key={r} onClick={() => onOpenRoutine(r)}>{r} ↗</button>)}</p> : null}
            <button className="rh-btn is-solid" disabled={!toolId || !params.length} onClick={() => { onPublish(toolId, params); setPop(null); }}>{wf.tool?.published ? '更新工具' : '发布'}</button>
          </div>}</div>
        <button className={dockOpen ? 'is-on' : ''} onClick={onDock}>节点助手</button>
      </div>
    </div>
    <div className="gf-stage">
      <GraphCanvas fitKey={fitKey} wf={wf} onChange={p => onChange(wf.id, p)} live={live} errors={errors} latest={latest} installed={installed} params={wf.tool?.params ?? []} />
      <aside className="gq" aria-label="队列">
        <header><span>QUEUE</span><b>队列</b><em>{pending ? `等待 ${pending}` : running ? '运行中' : '空闲'}</em></header>
        <button className="gq-run" onClick={() => onQueue(batch)} data-busy={running ? true : undefined}><i />排队运行<small>⌘ ↵</small></button>
        <div className="gq-batch"><span>批次</span><button onClick={() => setBatch(b => Math.max(1, b - 1))}>◀</button><b>{batch}</b><button onClick={() => setBatch(b => Math.min(8, b + 1))}>▶</button></div>
        <ol>{queue.slice(-3).reverse().map(q => <li key={q.id} data-s={q.status}>
          <i /><b>{q.id}</b><span>{q.name}</span><small>seed {q.seed}</small>
          {q.status === 'done' && <div className="gq-thumbs">{q.outputs.slice(0, 4).map(o => <button key={o.id} onClick={() => onLightbox(o)}><Art seed={o.seed} w={o.w} h={o.h} theme={o.theme} stamp={false} /></button>)}</div>}
        </li>)}{!queue.length && <li className="is-none">还没有排队</li>}</ol>
        {queue.some(q => q.status === 'done') && <button className="gq-clear" onClick={onClearQueue}>清空已完成</button>}
      </aside>
      {lightbox && <div className="gf-light" onClick={() => onLightbox(null)}>
        <figure onClick={e => e.stopPropagation()}>
          <Art seed={lightbox.seed} w={lightbox.w} h={lightbox.h} theme={lightbox.theme} />
          <figcaption><span className="rh-micro">{lightbox.at} · {lightbox.w}×{lightbox.h}</span><b>seed {lightbox.seed}</b><p>{lightbox.prompt}</p>
            <div><button className="rh-btn is-solid" onClick={() => { onUseSeed(lightbox); onLightbox(null); }}>载入这个种子</button><button className="rh-btn" onClick={() => onLightbox(null)}>关闭</button></div></figcaption>
        </figure>
      </div>}
    </div>
  </div>;
}
