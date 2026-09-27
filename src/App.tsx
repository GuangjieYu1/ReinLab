import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Atom, BookOpen, Check, ChevronRight, Command, Compass, FlaskConical, FolderClosed, GitBranch, Globe2, Grid2X2, LayoutTemplate, Menu, Plus, Search, Settings2, Sparkles, X } from 'lucide-react';
import { ArchiveObject, BrandMark, PlatformArt } from './components/Visuals';
import BlurText from './components/reactbits/BlurText';
import Conversation from './components/Conversation';
import TemplateStudio from './components/TemplateStudio';
import CinematicExperience from './components/cinematic/CinematicExperience';
import { enterOpenMAIC } from './components/cinematic/openMaicPortal';
import { defaultTemplate, isTemplate, platforms, readStored, type Page, type Platform, type Template } from './model';

type Modal = 'settings' | 'search' | 'about' | 'new' | 'conversation' | null;
interface CustomProject { id: string; name: string; template: Template }
const icons = { research: FlaskConical, learning: BookOpen, engineering: Atom, travel: Globe2 };
const ResearchLab = lazy(() => import('./components/research/ResearchLab'));
const workspaceNames: Record<Platform, string[]> = {
  research: ['文献与实验', '方法与证据', '研究笔记'],
  learning: ['线性代数', '概率与统计', '神经网络'],
  engineering: ['交互设计', '组件与规范', '验证与交付'],
  travel: ['路线与灵感', '城市观察', '旅途记录'],
};
const workspaceDescriptions: Record<Platform, string[]> = {
  research: ['让每一份证据，都找到它的位置。', '在不同方法之间，建立有意义的比较。', '记录观察，也记录尚未解答的问题。'],
  learning: ['从向量与空间开始，构建数学直觉。', '理解随机性，发现数据背后的规律。', '从简单单元，走向复杂的连接。'],
  engineering: ['将构想转化为清晰、自然的体验。', '用一致的语言，连接每一个细节。', '验证假设，让想法真正落地。'],
  travel: ['连接地点，让旅程有自己的节奏。', '走进街道，留意日常中的不同。', '把短暂的瞬间，留在可回溯的档案里。'],
};
const units: Record<Platform, string[]> = {
  research: ['可解释性研究', '相关工作整理', '实验假设与方案', '证据交叉验证'],
  learning: ['特征值与特征向量', '向量空间与基', '矩阵分解', '从线性代数到机器学习'],
  engineering: ['档案交互原型', '动效节奏与状态', '组件边界与规范', '交互验证记录'],
  travel: ['城市漫步路线', '建筑与街区观察', '交通与停留安排', '旅行资料整理'],
};

function isProjects(value: unknown): value is CustomProject[] {
  return Array.isArray(value) && value.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && isTemplate(p.template));
}

function App() {
  const [page, setPage] = useState<Page>('home');
  const [platform, setPlatform] = useState<Platform>('learning');
  const [workspace, setWorkspace] = useState('线性代数');
  const [unit, setUnit] = useState('特征值与特征向量');
  const [activeProject, setActiveProject] = useState<CustomProject | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [newPlatform, setNewPlatform] = useState<Platform>('learning');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedTemplate, setSavedTemplate] = useState<Template | null>(() => readStored('reinlab-template-v1', null, (v): v is Template | null => v === null || isTemplate(v)));
  const [projects, setProjects] = useState<CustomProject[]>(() => readStored('reinlab-projects-v1', [], isProjects));
  const [customUnits, setCustomUnits] = useState<Record<string, string[]>>(() => readStored('reinlab-units-v1', {}, (v): v is Record<string, string[]> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(a => Array.isArray(a) && a.every(s => typeof s === 'string'))));
  const [reducedSetting, setReducedSetting] = useState(() => readStored('reinlab-reduced', false, (v): v is boolean => typeof v === 'boolean'));
  const systemReduced = useReducedMotion();
  const reduced = reducedSetting || !!systemReduced;
  const [cinemaVisible, setCinemaVisible] = useState(true);
  const [cinemaReplay, setCinemaReplay] = useState(0);
  const [classroomRequest, setClassroomRequest] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const currentConfig = platforms.find(p => p.id === platform)!;
  const storageScope = `${platform}:${activeProject?.id ?? 'builtin'}`;
  const unitScope = `${storageScope}:${workspace}`;
  const addedUnits = customUnits[unitScope] ?? [];

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4200);
  }
  function navigate(next: Page) { setPage(next); setMobileNav(false); }
  function openPlatform(id: Platform) {
    if (id === 'learning') { enterOpenMAIC('reinlab', reduced); return; }
    setPlatform(id);
    setActiveProject(null);
    if (id === 'research') setWorkspace(workspaceNames.research[0]);
    navigate(id === 'research' ? 'research-lab' : 'projects');
  }
  function openConversation(name = units[platform][0]) { setUnit(name); navigate('conversation'); }
  function continueLast() { setPlatform('learning'); setActiveProject(null); setWorkspace('群论'); setUnit('对称与群'); setClassroomRequest(n => n + 1); setCinemaVisible(true); }
  function saveTemplate(template: Template) {
    if (!template.name.trim() || !template.workspaceLabel.trim() || !template.unitLabel.trim()) { notify('请填写模板名称、档案称谓和对话称谓'); return; }
    setSavedTemplate(template);
    try { localStorage.setItem('reinlab-template-v1', JSON.stringify(template)); notify('模板已保存到本机，已有项目保持原样'); } catch { notify('模板保留在本次会话，浏览器存储不可用'); }
  }
  function createProject(template: Template, name?: string) {
    const project = { id: `project-${Date.now()}`, name: name ?? `${template.name} · 新探索`, template: structuredClone(template) };
    const next = [...projects, project];
    setProjects(next);
    try { localStorage.setItem('reinlab-projects-v1', JSON.stringify(next)); } catch { notify('浏览器存储不可用，项目仅保留在本次会话'); }
    setPlatform(template.platform); setActiveProject(project);
    if (template.platform === 'research') setWorkspace(project.name);
    setPage(template.platform === 'research' ? 'research-lab' : 'projects');
    setModal(null);
    notify(`已创建「${project.name}」示例项目`);
  }
  function createConversation() {
    const name = newName.trim();
    if (!name) return;
    if ([...units[platform], ...addedUnits].includes(name)) {
      notify('这个档案里已有同名对话，请换一个名称');
      return;
    }
    const next = { ...customUnits, [unitScope]: [...addedUnits, name] };
    setCustomUnits(next);
    try { localStorage.setItem('reinlab-units-v1', JSON.stringify(next)); } catch { /* Optional persistence. */ }
    setUnit(name);
    setModal(null);
    navigate('conversation');
  }

  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); document.title = `${page === 'home' ? '研究中枢' : page === 'studio' ? '模板工坊' : page === 'conversation' ? unit : currentConfig.title} — REINLAB`; }, [page, unit, currentConfig.title]);
  useEffect(() => {
    if (modal && dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
      dialogRef.current.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus();
    }
    if (!modal && dialogRef.current?.open) dialogRef.current.close();
  }, [modal]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('.cinema-experience:not([hidden])')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setModal(m => m === 'search' ? null : 'search'); }
      if (event.key === 'Escape') setMobileNav(false);
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);

  const breadcrumbs = page === 'home' ? ['研究中枢', '总览'] : page === 'studio' ? ['研究中枢', '模板工坊'] : [currentConfig.title, ...(activeProject ? [activeProject.name] : []), ...(page === 'projects' ? ['项目总览'] : page === 'workspace' || page === 'research-lab' ? [workspace] : [workspace, '对话工作区'])];
  const modalTitle = modal === 'settings' ? '终端设置' : modal === 'search' ? '检索档案' : modal === 'new' ? '开启一项新探索' : modal === 'conversation' ? '创建新的对话' : '关于这座研究终端';

  return <MotionConfig reducedMotion={reduced ? 'always' : 'user'}>
    <div className={`app ${reduced ? 'reduced-motion' : ''}`}>
      {mobileNav && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`} inert={cinemaVisible}>
        <button className="brand" onClick={() => navigate('home')} aria-label="莱茵生命首页"><BrandMark /><span><strong>REINLAB<span>®</span></strong><small>莱 茵 生 命</small></span></button>
        <div className="sidebar-tag"><span className="status-light" /> PERSONAL RESEARCH TERMINAL</div>
        <button className="sidebar-search" onClick={() => { setQuery(''); setModal('search'); }}><Search size={14} /><span>检索档案</span><kbd>⌘ K</kbd></button>
        <div className="nav-section-label">工作空间 <span>WORKSPACE</span></div>
        <nav aria-label="主导航"><button className={`nav-item ${page === 'home' ? 'active' : ''}`} onClick={() => navigate('home')}><Grid2X2 size={17} /><span>研究中枢</span><span className="nav-active-marker" /></button>
          {platforms.map(p => { const Icon = icons[p.id]; return <button className={`nav-item ${!['home', 'studio'].includes(page) && platform === p.id ? 'active' : ''}`} key={p.id} onClick={() => openPlatform(p.id)}><Icon size={17} /><span>{p.title}</span><span className="nav-number">{p.code}</span></button>; })}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-section-label">创造与连接 <span>CREATE</span></div>
        <button className={`nav-item ${page === 'studio' ? 'active' : ''}`} onClick={() => navigate('studio')}><LayoutTemplate size={17} /><span>模板工坊</span><span className="new-label">LAB</span></button>
        <div className="sidebar-recent"><div className="nav-section-label">最近打开 <span>RECENT</span></div><button onClick={continueLast}><span className="recent-dot" />继续上次课堂<ArrowUpRight size={12} /></button><button onClick={() => { setPlatform('research'); setWorkspace('文献与实验'); setActiveProject(null); navigate('research-lab'); }}><span className="recent-dot muted" />文献与实验<ArrowUpRight size={12} /></button></div>
        <div className="sidebar-bottom">
          <div className="sidebar-quote"><span className="quote-cross">+</span><p>向未知，<br />保持开放。</p><span className="mono">STAY CURIOUS.</span><div className="quote-grid" /></div>
          <button className="nav-item settings-link" onClick={() => setModal('settings')}><Settings2 size={16} /><span>终端设置</span></button>
          <button className="user-profile" onClick={() => setModal('about')}><span className="avatar">R</span><span><b>独立研究员</b><small>PERSONAL LAB</small></span><ChevronRight size={14} /></button>
        </div>
      </aside>
      <div className="main-shell" inert={cinemaVisible}>
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="展开导航"><Menu size={18} /></button>
          <div className="breadcrumbs"><button onClick={() => navigate('home')} aria-label="返回研究中枢"><BrandMark small /></button>{breadcrumbs.map((b, i) => <span key={`${b}-${i}`}>{i > 0 && <ChevronRight size={11} />}{b}</span>)}</div>
          <div className="topbar-right">{page === 'research-lab' && <button className="cinema-launch-button legacy-research-link" onClick={() => navigate('projects')}>原有对话档案<ArrowUpRight size={13} /></button>}<button className="cinema-launch-button" onClick={() => setCinemaVisible(true)}><Compass size={13} />沉浸档案</button><span className="terminal-status"><i />本地设计预览</span><span className="mono">RL—001</span><button className="icon-button" onClick={() => setModal('about')} aria-label="关于原型"><Command size={15} /></button></div>
        </header>
        <main className={`main-content page-${page}`} ref={mainRef}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div className="page-wrapper" key={page} initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -4 }} transition={{ duration: reduced ? 0 : .2 }}>
              {page === 'home' && <div className="home-view">
                <section className="home-hero">
                  <div className="hero-copy"><div className="eyebrow"><span className="tiny-square" /> REINLAB / PERSONAL RESEARCH SYSTEM</div><h1>{reduced ? <>让好奇心，<br />成为下一项发现。</> : <><BlurText text="让好奇心，" animateBy="letters" delay={55} stepDuration={.32} /><BlurText text="成为下一项发现。" animateBy="letters" delay={45} stepDuration={.32} /></>}</h1><p className="hero-description">一个问题，一份档案，一次新的探索。<br />在这里，连接知识、创造与更广阔的世界。</p><button className="primary-button hero-cta" onClick={continueLast}><span>继续上次探索</span><ArrowUpRight size={16} /></button><div className="hero-footnote"><span className="tiny-dot" /> ALL GREAT DISCOVERIES BEGIN WITH A QUESTION.</div></div>
                  <ArchiveObject reduced={reduced} />
                  <div className="hero-corner corner-left" /><div className="hero-corner corner-right" />
                </section>
                <section className="platform-section">
                  <div className="section-heading"><div><h2>选择你的探索方向</h2><span>YOUR NEXT DISCOVERY</span></div><span className="section-count">04 <span>/ PLATFORMS</span></span></div>
                  <div className="platform-grid">{platforms.map((p, i) => <motion.button className={`platform-card platform-${p.id}`} key={p.id} onClick={() => openPlatform(p.id)} initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduced ? 0 : .15 + i * .09, duration: .45 }}><div className="platform-card-top"><span>{p.code} /</span><ArrowUpRight size={17} /></div><PlatformArt kind={p.id} /><div className="platform-card-text"><span className="platform-english">{p.english}</span><h3>{p.title}</h3><p>{p.desc}</p></div><div className="platform-card-bottom"><span>{p.id === 'learning' ? '继续积累' : '开启探索'}</span><span className="entry-line" /><ArrowRight size={13} /></div></motion.button>)}</div>
                </section>
                <section className="recent-section"><div className="section-heading"><div><h2>未完的探索</h2><span>PICK UP WHERE YOU LEFT OFF</span></div><button className="text-link" onClick={() => openPlatform('learning')}>查看档案 <ArrowRight size={13} /></button></div><button className="recent-project" onClick={continueLast}><div className="recent-project-symbol"><BookOpen size={21} /></div><div className="recent-project-copy"><span className="mono">LEARNING / ARCHIVE 001</span><h3>课堂档案：让理解发生</h3><p>六种学习活动 <span>/</span> 独立的讲义、对象与手记</p></div><div className="recent-project-progress"><span>继续课堂 <b>06 类场景</b></span><div><i /></div></div><span className="recent-project-time">示例档案</span><span className="round-button"><ArrowUpRight size={19} /></span></button></section>
                <section className="studio-invite"><div><Sparkles size={18} /><p>每一种探索，都可以有自己的方式。<span>在模板工坊，构建属于你的研究系统。</span></p></div><button className="text-link" onClick={() => navigate('studio')}>前往模板工坊 <ArrowUpRight size={14} /></button></section>
                <footer className="page-footer"><span>REINLAB © 2026 <i>非官方概念设计</i></span><span>RESEARCH. EXPLORE. CREATE. <span className="footer-cross">+</span></span></footer>
              </div>}
              {page === 'projects' && <div className="projects-view">
                <div className="page-heading"><div><div className="eyebrow">{currentConfig.english} / PROJECT OVERVIEW</div><h1>{activeProject?.name ?? currentConfig.project}<span className="heading-slash">/</span></h1><p>{activeProject?.template.description ?? '把宏大的好奇，分成可以逐一探索的档案。'}</p></div><button className="secondary-button" onClick={() => { setNewPlatform(platform); setNewName(''); setModal('new'); }}><Plus size={14} />新建项目</button></div>
                <div className={`project-overview accent-${activeProject?.template.accent ?? 'sage'}`}><div><span className="eyebrow">CURRENT EXPLORATION</span><h2>{activeProject ? '第一份档案，等待你的发现。' : platform === 'learning' ? '从理解一个向量，到理解一个世界。' : '每一个未知，都值得一次认真探索。'}</h2><p>{activeProject ? `基于「${activeProject.template.name}」模板创建 · 独立的示例项目` : '保持问题之间的连接，让每一步都有迹可循。'}</p><div className="project-stats"><span><b>03</b>工作区档案</span><span><b>12</b>{activeProject?.template.unitLabel ?? (platform === 'learning' ? '学习单元' : '探索课题')}</span><span className="demo-stats">示例内容</span></div></div><div className="project-overview-art"><PlatformArt kind={platform} /></div></div>
                {projects.filter(p => p.template.platform === platform).length > 0 && <div className="custom-project-picker"><span>我的项目</span>{projects.filter(p => p.template.platform === platform).map(p => <button key={p.id} className={activeProject?.id === p.id ? 'selected' : ''} onClick={() => setActiveProject(p)}>{p.name}<ArrowUpRight size={12} /></button>)}{activeProject && <button onClick={() => setActiveProject(null)}>返回内置示例</button>}</div>}
                <div className="section-heading"><div><h2>{activeProject?.template.workspaceLabel ?? '工作区档案'}</h2><span>YOUR KNOWLEDGE ARCHIVES</span></div><span className="mono muted-text">03 ARCHIVES</span></div>
                <div className="workspace-grid">{workspaceNames[platform].map((name, i) => <button key={name} className="workspace-card" onClick={() => { setWorkspace(name); navigate('workspace'); }}><div className="workspace-visual"><div className={`mini-physical-archive archive-${i}`}><div className="archive-ring ring-a" /><div className="archive-ring ring-b" /><span>RL—00{i + 1}</span><i /></div><span className="workspace-visual-cross">+</span></div><div className="workspace-info"><span className="mono">ARCHIVE / 00{i + 1}</span><h3>{name}</h3><p>{workspaceDescriptions[platform][i]}</p><div><span>04 {activeProject?.template.unitLabel ?? (platform === 'learning' ? '学习单元' : '探索课题')}</span><ArrowUpRight size={17} /></div></div></button>)}</div>
                <div className="project-bottom-note"><GitBranch size={17} /><div><b>探索可以分叉，知识始终相连。</b><p>每个档案独立组织对话，所有分支都保留完整的探索过程。</p></div><span className="mono">CONNECTED BY CURIOSITY.</span></div>
              </div>}
              {page === 'research-lab' && <Suspense fallback={<div className="research-lab-loading" role="status">正在展开研究档案…</div>}>
                <ResearchLab key={workspace} archiveName={workspace} reduced={reduced} onBack={() => navigate('home')} onArchiveChange={name => { setWorkspace(name); setActiveProject(null); }} />
              </Suspense>}
              {page === 'workspace' && <div className="workspace-view">
                <button className="text-link back-link" onClick={() => navigate('projects')}><ArrowLeft size={14} />返回项目总览</button>
                <div className="page-heading"><div><div className="eyebrow">ARCHIVE / {platform.toUpperCase()}</div><h1>{workspace}<span className="outline-label">工作区档案</span></h1><p>{workspaceDescriptions[platform][Math.max(0, workspaceNames[platform].indexOf(workspace))]}</p></div><button className="primary-button" onClick={() => { setNewName(''); setModal('conversation'); }}><Plus size={14} />开启新对话</button></div>
                <div className="archive-directory"><div className="directory-header"><span>名称 / 简述</span><span>探索状态</span><span>内容形式</span><span /></div>{[...units[platform], ...addedUnits].map((name, i) => <button key={name} className="unit-row" onClick={() => openConversation(name)}><span className="unit-order">{String(i + 1).padStart(2, '0')}</span><div><h3>{name}</h3><p>{['从直觉出发，建立可以操作、可以验证的理解。', '连接已有知识，找出新的解释路径。', '整理关键概念与方法，逐步构建整体认识。', '从原理走向应用，在实践中检验想法。'][i] ?? '你创建的新对话 · 在这里继续探索。'}</p></div><span className={`unit-status ${i === 0 ? 'live' : ''}`}><i />{i === 0 ? '探索中' : '待继续'}</span><span className="unit-format"><BookOpen size={14} />回应卡片</span><ArrowUpRight size={17} /></button>)}</div>
                <div className="archive-directory-note"><span className="mono">{String(4 + addedUnits.length).padStart(2, '0')} RECORDS / 01 ARCHIVE</span><span>点击一项，展开它的探索路径 <ArrowDown size={12} /></span></div>
              </div>}
              {page === 'conversation' && <Conversation key={`${storageScope}:${workspace}:${unit}`} platform={platform} unit={unit} workspace={workspace} storageScope={storageScope} fresh={addedUnits.includes(unit)} reduced={reduced} defaultMode={activeProject?.template.mode ?? 'document'} onBack={() => navigate('workspace')} notify={notify} />}
              {page === 'studio' && <TemplateStudio saved={savedTemplate} onSave={saveTemplate} onCreate={createProject} notify={notify} />}
            </motion.div>
          </AnimatePresence>
        </main>
        <footer className="terminal-footer"><span><i />TERMINAL READY<span className="footer-divider">/</span>示例数据 · 无模型连接</span><span>REINLAB SYSTEM <b>0.1 / DESIGN PREVIEW</b></span></footer>
      </div>
      <CinematicExperience active={cinemaVisible} reduced={reduced} replayRequest={cinemaReplay} classroomRequest={classroomRequest}
        onWorkbench={() => setCinemaVisible(false)}
        onOpenWorkspace={(id, name) => { setPlatform(id); setWorkspace(name); setActiveProject(null); navigate(id === 'research' ? 'research-lab' : 'workspace'); setCinemaVisible(false); }} />
      <AnimatePresence>{toast && <motion.div className="toast" role="status" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 5 }}><Check size={15} /><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={13} /></button></motion.div>}</AnimatePresence>
      <dialog ref={dialogRef} className={`app-dialog ${modal === 'search' ? 'search-dialog' : ''}`} onCancel={() => setModal(null)} onClose={() => setModal(null)} aria-labelledby="dialog-title">
        <div className="dialog-header"><div><span className="eyebrow">REINLAB / SYSTEM</span><h2 id="dialog-title">{modalTitle}</h2></div><button className="icon-button" aria-label="关闭弹窗" onClick={() => setModal(null)}><X size={19} /></button></div>
        {modal === 'settings' && <div className="dialog-body"><label className="setting-row"><span><b>减少动态效果</b><small>关闭入场、透视倾斜与呼吸动效</small></span><input type="checkbox" className="toggle" checked={reducedSetting} onChange={e => { setReducedSetting(e.target.checked); try { localStorage.setItem('reinlab-reduced', JSON.stringify(e.target.checked)); } catch { /* Optional preference. */ } }} /></label>{systemReduced && <p className="setting-note">已遵循系统的减少动态效果偏好。</p>}<div className="setting-row"><span><b>完整终端演出</b><small>约 35 秒：开场、阵列传播、抽取与解密</small></span><button className="secondary-button" disabled={reduced} onClick={() => { setModal(null); setCinemaReplay(v => v + 1); setCinemaVisible(true); }}>重播完整演出</button></div><div className="setting-row"><span><b>存储与连接</b><small>模板、项目及对话演示仅保存在当前浏览器。不连接任何模型或外部工具。</small></span><span className="outline-label">LOCAL ONLY</span></div></div>}
        {modal === 'search' && <div className="dialog-body"><div className="search-input-wrap"><Search size={18} /><input autoFocus placeholder="搜索平台、档案或学习单元…" value={query} onChange={e => setQuery(e.target.value)} aria-label="检索内容" /></div><div className="search-results">{platforms.filter(p => `${p.title}${p.project}${p.workspace}${p.unit}`.toLowerCase().includes(query.toLowerCase())).map(p => <button key={p.id} onClick={() => { openPlatform(p.id); setModal(null); }}><FolderClosed size={18} /><span><b>{p.project}</b><small>{p.title} / {p.workspace} / {p.unit}</small></span><ArrowUpRight size={16} /></button>)}{('模板工坊知识探索论文精读'.includes(query) || !query) && <button onClick={() => { navigate('studio'); setModal(null); }}><LayoutTemplate size={18} /><span><b>模板工坊</b><small>设计属于你的工作方式</small></span><ArrowUpRight size={16} /></button>}{!platforms.some(p => `${p.title}${p.project}${p.workspace}${p.unit}`.toLowerCase().includes(query.toLowerCase())) && !'模板工坊知识探索论文精读'.includes(query) && <p className="no-results">没有匹配的档案，试试“学习”或“科研”。</p>}</div></div>}
        {modal === 'new' && <form className="dialog-body" onSubmit={e => { e.preventDefault(); if (newName.trim()) createProject({ ...defaultTemplate, platform: newPlatform }, newName.trim()); }}><p className="dialog-intro">用一个清晰的问题，开启一项新的探索。</p><label className="field-label">项目名称<input autoFocus value={newName} maxLength={60} onChange={e => setNewName(e.target.value)} placeholder="例如：我的机器学习计划" required /></label><label className="field-label">所属平台<select value={newPlatform} onChange={e => setNewPlatform(e.target.value as Platform)}>{platforms.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label><p className="setting-note">将创建带有示例档案的本地项目，用于验证交互。</p><button className="primary-button" disabled={!newName.trim()}><Plus size={14} />创建项目</button></form>}
        {modal === 'conversation' && <form className="dialog-body" onSubmit={e => { e.preventDefault(); createConversation(); }}><p className="dialog-intro">在「{workspace}」里，留下一条新的探索路径。</p><label className="field-label">对话名称<input autoFocus value={newName} maxLength={60} onChange={e => setNewName(e.target.value)} placeholder="给这次探索起一个名字" required /></label><p className="setting-note">新对话从空白开始，不继承其他对话的示例节点。</p><button className="primary-button" disabled={!newName.trim()}><Plus size={14} />创建对话</button></form>}
        {modal === 'about' && <div className="dialog-body about-content"><BrandMark /><h3>为好奇心，留一个位置。</h3><p>这是莱茵生命主题的第一轮可交互设计原型。页面中的模型状态、研究内容和工具记录均为示例，不代表真实 AI 输出。</p><div className="about-capabilities"><span>React Bits 动效</span><span>CSS 透视 / SVG</span><span>无 WebGL</span><span>本地数据</span></div><p className="setting-note">非官方同人概念设计，与《明日方舟》或 DeepSeek 官方无隶属关系。React Bits 组件的许可与来源保存在项目第三方声明中。</p><button className="secondary-button" onClick={() => { setModal(null); navigate('studio'); }}><Compass size={14} />探索模板工坊</button></div>}
      </dialog>
    </div>
  </MotionConfig>;
}

export default App;
