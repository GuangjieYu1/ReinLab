import type React from 'react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import Logo from '../cinematic/WorkbenchLogo';
import { startTransit, transitActive } from '../entry/transitStore';
import { navigate } from '../../nav';
import { BENCHES, CODES, FILE_NOUN, benchInfo, fileNo, type BenchId } from './benches';
import ResearchBench from '../../data/ResearchStudioData';
import EngineeringBench from './engineering/EngineeringBench';
import CreativeBench from './creative/CreativeStudio';
import AutomationBench from './automation/AutomationStudio';
import DataBench from './data/DataStudio';
import ExplorationBench from './explore/ExploreStudio';
import CourseStudio from './course/CourseStudio';
import './workbench-shell.css';

/** 外壳交给工作台的三样东西：返回 Files、工作台标识（转场的落点）、档案切换。工作台把它们放进自己的头部。 */
export interface BenchChrome { back: ReactNode; logo: ReactNode; file: ReactNode }
export interface BenchProps { file: number; reduced: boolean; chrome: BenchChrome }

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 已迁到新设计、自己画头部的工作台；其余暂用一条细条承载外壳的三样东西。 */
const OWN_HEADER: BenchId[] = ['curriculum', 'engineering', 'research', 'creative', 'data', 'automation', 'exploration'];

// 返回入口：回到同一种选台（design）和这个工作台的 Files。
function entryHref(bench?: BenchId, file?: number) {
  const q = new URLSearchParams(window.location.search);
  const out = new URLSearchParams({ preview: 'entry' });
  if (q.get('design')) out.set('design', q.get('design')!);
  if (bench) { out.set('return', bench); out.set('file', String(file ?? 0)); }
  return `${window.location.pathname}?${out}`;
}
function initial(): { bench: BenchId; file: number } {
  const q = new URLSearchParams(window.location.search);
  const bench = (BENCHES as string[]).includes(q.get('studio') ?? '') ? q.get('studio') as BenchId : 'research';
  const file = Math.min(3, Math.max(0, Number(q.get('file') ?? 0) || 0));
  return { bench, file };
}

export default function WorkbenchStudio() {
  const [{ bench, file }, setPlace] = useState(initial);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const reduced = useMemo(reducedMotion, []);
  const info = benchInfo(bench);
  // 返回 Files：顶栏里的标识升到中央（倒放进入时的标识转场），切回 Files 后飞落到档案盒的印章上。
  function leaveTo(event: React.MouseEvent<HTMLAnchorElement>, toFiles: boolean) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const href = event.currentTarget.href;
    const fromEntry = new URLSearchParams(window.location.search).get('from') === 'entry';
    event.preventDefault();
    // 页内跳转：真实模式的登录只在内存里，整页刷新会掉线
    if (!fromEntry) { navigate(href); return; }
    const logo = event.currentTarget.ownerDocument.querySelector('.wb-crumb-logo')?.getBoundingClientRect();
    if (!toFiles || reduced || !logo || transitActive()) { navigate(href); return; }
    startTransit({ direction: 'return', workbench: info, from: logo, land: '.cine-cassette.selected .entry-seal', target: href,
      caption: { code: CODES[bench], title: info.title, name: info.files[file], fileNo: fileNo(file) } });
  }

  useEffect(() => {
    document.title = `${info.title} · ${info.files[file]} — ReinLab`;
    const url = new URL(window.location.href); url.searchParams.set('studio', bench); url.searchParams.set('file', String(file));
    window.history.replaceState(null, '', url.pathname + url.search);
  }, [bench, file, info]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent | KeyboardEvent) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) setMenu(false); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [menu]);

  const Bench = { curriculum: CourseStudio, research: ResearchBench, engineering: EngineeringBench, creative: CreativeBench, automation: AutomationBench, data: DataBench, exploration: ExplorationBench }[bench];

  // 工作台之间的切换在入口的「选择工作台」里完成，这里不再放台签；外壳只留返回、标识、档案切换。
  const chrome: BenchChrome = {
    back: <a className="wb-back" onClick={e => leaveTo(e, true)} href={entryHref(bench, file)} title={`返回 ${CODES[bench]} Files`} aria-label={`返回 ${CODES[bench]} Files`}>←</a>,
    logo: <span className="wb-crumb-logo" title={info.title}><Logo key={bench} workbench={info} still={reduced} /></span>,
    file: <div className="wb-file" ref={menuRef}>
      <button className="wb-crumb-file" aria-expanded={menu} aria-haspopup="listbox" onClick={() => setMenu(v => !v)}><em>{fileNo(file)}</em><span>{info.files[file]}</span><b>▾</b></button>
      {menu && <div className="wb-menu" role="listbox" aria-label={`切换${FILE_NOUN[bench]}`}>
        <span>{info.fileKind} · {FILE_NOUN[bench]}</span>
        {info.files.map((name, index) => <button key={name} role="option" aria-selected={index === file} onClick={() => { setPlace({ bench, file: index }); setMenu(false); }}><em>{fileNo(index)}</em>{name}</button>)}
      </div>}
    </div>,
  };
  const own = OWN_HEADER.includes(bench);
  return <main className={`wb wb-${bench}`} data-reduced={reduced || undefined} data-own-header={own || undefined}>
    {!own && <header className="wb-strip" data-wb-bar>
      {chrome.back}{chrome.logo}<span className="wb-strip-bench"><b>{CODES[bench]}</b>{info.title}</span>{chrome.file}
      <span className="wb-status"><i />LOCAL PREVIEW<small>示例数据 · 不连接模型</small></span>
    </header>}
    <div className="wb-body" key={`${bench}:${file}`}><Bench file={file} reduced={reduced} chrome={chrome} /></div>
  </main>;
}
