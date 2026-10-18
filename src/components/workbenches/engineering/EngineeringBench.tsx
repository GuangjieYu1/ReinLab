import { useCallback, useEffect, useState } from 'react';
import BenchFrame from '../BenchFrame';
import type { BenchProps } from '../WorkbenchStudio';
import RequirementsFace from './RequirementsFace';
import DevFace from './DevFace';
import TestFace from './TestFace';
import OntoFace from './OntoFace';

// 工程台 ENGR：一个档案 = 一个工作区 = 一个 Git 仓库，分四个面。
// 需求 → 开发 → 测试 → 本体，每一面依赖前一面产出的数据；追溯链 REQ ⇄ AC ⇄ issue ⇄ 提交 ⇄ 用例 ⇄ 本体概念 贯穿四面。
// 规格见 design/WORKBENCH_SPEC.md 第一节。外壳（面签、快门、状态条）由共用的 BenchFrame 提供。

type Face = 'req' | 'dev' | 'test' | 'onto';
const FACES: { id: Face; label: string; en: string }[] = [
  { id: 'req', label: '需求', en: 'REQUIREMENTS' }, { id: 'dev', label: '开发', en: 'DEVELOPMENT' },
  { id: 'test', label: '测试', en: 'TESTING' }, { id: 'onto', label: '本体', en: 'ONTOLOGY' },
];
const BRANCHES = [
  { name: 'develop', note: '无冲突' }, { name: 'req/REQ-012', note: '当前 · 变更集 2' },
  { name: 'req/REQ-013', note: '新增需求' }, { name: 'feat/ISS-31-archive-list', note: '待测试' },
];

export default function EngineeringBench({ file, reduced, chrome }: BenchProps) {
  const [face, setFace] = useState<Face>('req');
  const [branchOpen, setBranchOpen] = useState(false);
  const [devIssues, setDevIssues] = useState(4);
  const [testing, setTesting] = useState(2);
  const [devIssue, setDevIssue] = useState('ISS-32');
  const goDev = useCallback((issue: string) => { setDevIssue(issue); setFace('dev'); }, []);
  const onTesting = useCallback((n: number) => setTesting(v => v + n), []);
  const [counts, setCounts] = useState({ req: 1, conflicts: 0, mr: 0 });
  const onCounts = useCallback((c: typeof counts) => setCounts(c), []);
  const onIssues = useCallback((n: number) => setDevIssues(v => v + n), []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setBranchOpen(false); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const badge: Record<Face, number> = { req: counts.req, dev: devIssues, test: testing, onto: 0 };
  return <BenchFrame code="ENGR" section="003" file={file} reduced={reduced} chrome={chrome}
    faces={FACES.map(f => ({ ...f, badge: badge[f.id] }))} face={face} onFace={id => setFace(id as Face)}
    strip={<>HEAD a1f3c9 <i>·</i> BASE develop <i>·</i> FILE X—{String(file + 13).padStart(3, '0')}</>}
    tools={<>
      <button className="en-branch-btn" onClick={() => setBranchOpen(v => !v)} aria-expanded={branchOpen}><i>⎇</i>req/REQ-012<b>▾</b></button>
      {branchOpen && <div className="en-branch-menu" role="menu">
        <span className="rh-micro">BRANCHES · 分支</span>
        {BRANCHES.map(b => <button key={b.name} role="menuitem" aria-current={b.name === 'req/REQ-012' || undefined} onClick={() => setBranchOpen(false)}><code>{b.name}</code><small>{b.note}</small></button>)}
      </div>}
      <kbd title="命令面板（设计中）">⌘K</kbd>
    </>}
    shutterLines={f => [`> mount face ${String(FACES.findIndex(x => x.id === f.id) + 1).padStart(2, '0')} · ${f.en.toLowerCase()}`, '> restore session · branch req/REQ-012', '> sync ontology · develop @ a1f3c9', '> ready']}
    status={<>
      <span><i className="en-sq" />develop @ a1f3c9</span>
      <span>需求待审 {counts.mr}</span><span>issue {devIssues}</span><span>待测 2</span>
      <span data-alert={counts.conflicts > 0 || undefined}>冲突 {counts.conflicts}</span>
      <span>示例数据 · 不连接模型</span>
    </>}>
    {face === 'req' ? <RequirementsFace onIssues={onIssues} onCounts={onCounts} reduced={reduced} />
      : face === 'dev' ? <DevFace reduced={reduced} onIssues={onIssues} onTesting={onTesting} initialIssue={devIssue} />
      : face === 'test' ? <TestFace reduced={reduced} onGoDev={goDev} />
      : <OntoFace reduced={reduced} />}
  </BenchFrame>;
}
