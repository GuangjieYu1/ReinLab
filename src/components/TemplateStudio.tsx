import { useState } from 'react';
import { ArrowRight, BookOpen, Check, ChevronRight, CircleHelp, Copy, Eye, FileText, GripVertical, Layers, LayoutTemplate, Plus, RotateCcw, Save, Settings2, Sparkles } from 'lucide-react';
import { defaultTemplate, type Platform, type Template } from '../model';
import { PlatformArt } from './Visuals';

const allModules = ['知识路径', '学习进度', '工作区档案', '文献表', '方法对比'];
type PreviewState = 'example' | 'empty' | 'loading';

export default function TemplateStudio({ saved, onSave, onCreate, notify }: {
  saved: Template | null; onSave: (template: Template) => void;
  onCreate: (template: Template) => void; notify: (text: string) => void;
}) {
  const [draft, setDraft] = useState<Template>(saved ?? defaultTemplate);
  const [section, setSection] = useState('总览页面');
  const [previewState, setPreviewState] = useState<PreviewState>('example');
  const [instruction, setInstruction] = useState('');
  const [version, setVersion] = useState(saved ? 1 : 0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved ?? defaultTemplate);
  const valid = !!draft.name.trim() && !!draft.workspaceLabel.trim() && !!draft.unitLabel.trim();
  const patch = (values: Partial<Template>) => setDraft(prev => ({ ...prev, ...values }));

  function applyInstruction() {
    if (!instruction.trim()) return;
    if (/论文|科研|文献/.test(instruction)) {
      patch({ name: '论文精读', platform: 'research', description: '从文献出发，连接证据、方法与新的研究问题。', modules: ['工作区档案', '文献表', '方法对比'], workspaceLabel: '专题档案', unitLabel: '研究课题' });
      setSection('总览页面');
      notify('已应用论文精读演示配方，可继续修改右侧属性');
    } else if (/幻灯|slide/i.test(instruction)) {
      patch({ mode: 'slides' }); notify('已将默认回应方式改为幻灯片');
    } else {
      notify('当前为本地配方演示：试试“改成论文精读模板”或“默认使用幻灯片”。自由生成尚未接入模型。');
    }
    setInstruction('');
  }

  return <div className="studio-view">
    <div className="page-heading"><div><div className="eyebrow">DESIGN YOUR OWN SYSTEM</div><h1>模板工坊<span className="outline-label">DESIGN LAB</span></h1><p>不止定义页面，更定义你的工作方式。</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => { patch({ name: `${draft.name} · 副本`, id: `custom-${Date.now()}` }); notify('已复制到当前草稿，原模板不受影响'); }}><Copy size={14} />复制模板</button><button className="primary-button" disabled={!valid || (!dirty && version > 0)} onClick={() => { const next = { ...draft, id: draft.id === defaultTemplate.id ? 'custom-knowledge' : draft.id }; setDraft(next); onSave(next); setVersion(v => v + 1); }}><Save size={14} />保存模板</button></div></div>
    <div className="studio-topbar"><div><span className="tiny-square" /><b>{draft.name}</b><span className="mono">V{version || '0'}.0</span><span className="studio-draft">{dirty ? '未保存的更改' : version ? '已保存到本机' : '内置模板 · 可自由修改'}</span></div><button className="text-link" onClick={() => { setDraft(saved ?? defaultTemplate); notify('已恢复到最近保存的模板'); }}><RotateCcw size={12} /> 恢复草稿</button></div>
    <div className="studio-layout">
      <aside className="studio-structure">
        <div className="panel-caption">模板结构 <Layers size={13} /></div>
        <div className="structure-root"><LayoutTemplate size={15} /><b>{draft.name}</b></div>
        {['总览页面', '工作区档案', '对话与回应'].map((name, i) => <button className={`structure-item ${section === name ? 'active' : ''}`} key={name} onClick={() => setSection(name)}><span className="structure-line" />{i === 0 ? <LayoutTemplate size={14} /> : i === 1 ? <Layers size={14} /> : <FileText size={14} />}<span>{name}</span><ChevronRight size={12} /></button>)}
        <div className="structure-divider" />
        <div className="panel-caption">内容组件 <span className="mono">{draft.modules.length.toString().padStart(2, '0')}</span></div>
        {draft.modules.map(name => <button className="component-item" key={name} onClick={() => setSection('总览页面')}><GripVertical size={12} /><span>{name}</span><Check size={11} /></button>)}
        <button className="add-component" onClick={() => { const next = allModules.find(m => !draft.modules.includes(m)); if (next) patch({ modules: [...draft.modules, next] }); else notify('当前演示的全部组件已添加'); }}><Plus size={13} />添加组件</button>
        <div className="studio-lock-note"><CircleHelp size={16} /><p>视觉语言与分支规则由莱茵终端统一维护。你专注于工作方式。</p></div>
      </aside>
      <section className="studio-preview-area">
        <div className="preview-toolbar"><span><Eye size={13} />实时预览</span><select aria-label="预览状态" value={previewState} onChange={e => setPreviewState(e.target.value as PreviewState)}><option value="example">示例内容</option><option value="empty">空项目</option><option value="loading">加载状态</option></select><span className="preview-desktop">DESKTOP</span></div>
        <div className={`template-preview accent-${draft.accent}`}>
          <div className="mini-browser"><span /><span /><span /><p>REINLAB / {draft.platform.toUpperCase()}</p><span className="mono">↗</span></div>
          <div className="preview-body">
            <div className="preview-intro"><span className="eyebrow">A PLACE FOR YOUR CURIOSITY</span><h2>{draft.name || '未命名模板'}<span> /</span></h2><p>{draft.description || '在右侧添加模板描述。'}</p></div>
            {previewState === 'empty' ? <div className="preview-empty"><Layers size={31} /><h3>第一份档案，从这里开始。</h3><p>使用模板创建项目后，即可添加{draft.workspaceLabel}。</p><button className="primary-button" onClick={() => onCreate(draft)}><Plus size={13} />创建示例项目</button></div> : previewState === 'loading' ? <div className="preview-loading" aria-label="模拟加载状态"><div className="skeleton-line long" /><div className="skeleton-line short" /><div className="skeleton-panel" /><span>正在载入示例内容…</span></div> : section === '对话与回应' ? <div className="mini-response"><div className="mono">RESPONSE / 01 <span>{draft.mode === 'document' ? '纵向阅读' : '幻灯片'}</span></div><h3>让理解，发生在连接之间。</h3><p>用户的问题、探索过程和完整回应，始终保留在同一个节点中。</p><div className="preview-quote">一个问题，可以有很多条探索路径。</div><div className="mini-input">输入你的下一个问题…<ArrowRight size={14} /></div></div> : <>
              {section === '总览页面' && draft.modules.includes('学习进度') && <div className="preview-progress"><span>这次探索 <b>03 <small>/ 08</small></b></span><div><i /></div><span className="mono">37.5%</span></div>}
              {section === '总览页面' && draft.modules.includes('知识路径') && <div className="preview-path"><span>知识连接</span><div><b>建立直觉</b><i /><b className="current">理解原理</b><i /><b>尝试应用</b></div></div>}
              {(draft.modules.includes('工作区档案') || section === '工作区档案') && <><div className="preview-section-title">{draft.workspaceLabel}<span>02 ARCHIVES</span></div><div className="preview-archives">{[draft.platform === 'research' ? '方法与证据' : '基础知识', draft.platform === 'research' ? '实验与比较' : '进阶探索'].map((s, i) => <button key={s} onClick={() => setSection('对话与回应')}><span className="mini-archive-code">A—00{i + 1}</span><PlatformArt kind={draft.platform} /><b>{s}</b><span>04 个{draft.unitLabel} <ArrowRight size={12} /></span></button>)}</div></>}
              {section === '总览页面' && draft.modules.includes('文献表') && <div className="preview-table"><div><span>文献档案</span><span>状态</span></div><div><span>研究方法与证据整理</span><span>精读中</span></div><div><span>相关工作与开放问题</span><span>待探索</span></div></div>}
              {section === '总览页面' && draft.modules.includes('方法对比') && <div className="preview-compare"><span>方法对比</span><div><b>方法 A</b><i>↔</i><b>方法 B</b></div><small>在不同路径之间，寻找更好的解释。</small></div>}
              {!draft.modules.length && <div className="preview-empty"><Plus size={24} /><p>从右侧选择需要的内容组件。</p></div>}
            </>}
            <div className="mini-footer">REINLAB · KNOWLEDGE IS A LIVING STRUCTURE.</div>
          </div>
        </div>
        <form className="studio-prompt" onSubmit={e => { e.preventDefault(); applyInstruction(); }}><Sparkles size={17} /><input aria-label="描述模板修改" value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="试试：把它改成论文精读模板…" /><button className="icon-button" aria-label="应用模板修改" disabled={!instruction.trim()}><ArrowRight size={17} /></button></form>
        <p className="studio-prompt-note">本地配方演示 · 修改立即呈现，保存后才更新模板</p>
      </section>
      <aside className="studio-inspector">
        <div className="panel-caption">模板属性 <Settings2 size={14} /></div>
        <label className="field-label">模板名称<input value={draft.name} maxLength={32} onChange={e => patch({ name: e.target.value })} /></label>
        <label className="field-label">所属平台<select value={draft.platform} onChange={e => patch({ platform: e.target.value as Platform })}><option value="learning">学习平台</option><option value="research">AI 研究实验室</option><option value="engineering">工程与项目</option><option value="travel">旅行平台</option></select></label>
        <label className="field-label">一句话介绍<textarea value={draft.description} rows={3} maxLength={100} onChange={e => patch({ description: e.target.value })} /></label>
        <div className="inspector-divider" />
        <span className="field-caption">局部强调色</span><div className="accent-options">{(['sage', 'amber', 'slate'] as const).map((x, i) => <button aria-label={['鼠尾草', '杏金', '岩灰'][i]} aria-pressed={draft.accent === x} key={x} className={`accent-option ${x} ${draft.accent === x ? 'selected' : ''}`} onClick={() => patch({ accent: x })}>{draft.accent === x && <Check size={13} />}</button>)}<small>统一风格，保留个性。</small></div>
        <label className="field-label">档案称谓<input value={draft.workspaceLabel} maxLength={12} onChange={e => patch({ workspaceLabel: e.target.value })} /></label>
        <label className="field-label">对话称谓<input value={draft.unitLabel} maxLength={12} onChange={e => patch({ unitLabel: e.target.value })} /></label>
        <label className="field-label">默认回应形式<select value={draft.mode} onChange={e => patch({ mode: e.target.value as Template['mode'] })}><option value="document">纵向阅读</option><option value="slides">幻灯片</option></select></label>
        <div className="inspector-divider" /><span className="field-caption">总览组件</span>
        <div className="module-options">{allModules.map(name => <label key={name}><input type="checkbox" checked={draft.modules.includes(name)} onChange={e => patch({ modules: e.target.checked ? [...draft.modules, name] : draft.modules.filter(m => m !== name) })} /><span>{name}</span></label>)}</div>
        <button className="secondary-button create-from-template" disabled={!draft.name.trim() || !draft.workspaceLabel.trim() || !draft.unitLabel.trim()} onClick={() => onCreate(draft)}><BookOpen size={14} />用此模板创建项目 <ArrowRight size={13} /></button>
      </aside>
    </div>
  </div>;
}
