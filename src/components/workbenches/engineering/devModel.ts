// 工程台 · 开发面的示例数据（纯前端，本地模拟）。
// issue = 分支 = 会话：点一条 issue，分支、会话、预览、Archify 高亮全部切到这个 issue。

import type { TreeNode } from './Explorer';

export type IssueState = 'todo' | 'doing' | 'testing' | 'merged';
export const STATE_LABEL: Record<IssueState, string> = { todo: '待开始', doing: '进行中', testing: '待测试', merged: '已合并' };
export type Issue = {
  id: string; title: string; from: string; state: IssueState; kind: 'feat' | 'fix'; slug: string;
  modules: string[];            // Archify 里波及的模块
  files: string[];              // 本 issue 改动的文件
  concepts: string[];           // 追溯：引用的本体概念
  tests: { name: string; pass: boolean | null }[];
};
export const branchOf = (i: Issue) => `${i.kind}/${i.id}-${i.slug}`;

export const ISSUES: Issue[] = [
  { id: 'ISS-32', title: '档案浏览器 · 键盘选择', from: 'REQ-012 · AC-1 · AC-2', state: 'doing', kind: 'feat', slug: 'keyboard-nav',
    modules: ['ArchiveBrowser', 'ArchiveList', 'useKeys'], files: ['src/components/useKeys.ts', 'src/components/ArchiveBrowser.tsx', 'src/components/ArchiveList.tsx', 'tests/browser.test.tsx'], concepts: ['档案', '档案号', '档案盒'],
    tests: [{ name: '↓ 选中下一份档案', pass: true }, { name: '↑ 选中上一份档案', pass: true }, { name: 'Enter 抽出档案盒', pass: true }, { name: '选中项朗读档案号', pass: false }] },
  { id: 'ISS-33', title: '窄屏列表竖排', from: 'REQ-012 · AC-3', state: 'todo', kind: 'feat', slug: 'narrow-layout',
    modules: ['ArchiveBrowser', 'FileCallout', 'browser.css'], files: ['src/styles/browser.css', 'src/components/FileCallout.tsx'], concepts: ['档案'],
    tests: [{ name: '< 900px 列表竖排', pass: null }, { name: '不出现横向滚动', pass: null }] },
  { id: 'ISS-31', title: '档案列表 option 语义', from: 'REQ-012 · AC-1', state: 'testing', kind: 'fix', slug: 'list-semantics',
    modules: ['ArchiveList'], files: ['src/components/ArchiveList.tsx'], concepts: ['档案'],
    tests: [{ name: 'role=option 与 aria-selected', pass: true }, { name: '选中项可被读屏读出', pass: true }] },
  { id: 'ISS-30', title: '档案小票取出动画', from: 'REQ-010 · AC-2', state: 'merged', kind: 'feat', slug: 'slip-motion',
    modules: ['FileCallout'], files: ['src/components/FileCallout.tsx'], concepts: ['档案小票', '档案盒'], tests: [{ name: '小票从盒口提出', pass: true }] },
  { id: 'ISS-29', title: '档案场显影与抽取', from: 'REQ-010 · AC-1', state: 'merged', kind: 'feat', slug: 'field-reveal',
    modules: ['ArchiveField', 'archives.ts'], files: ['src/data/archives.ts'], concepts: ['档案场'], tests: [{ name: '选中的档案盒抬升', pass: true }] },
];
/** 「↻ 刷新」：从需求面拉取审核通过后生成的新 issue。 */
export const PULLED: Issue[] = [
  { id: 'ISS-34', title: '跨轮浏览（无限档案场）', from: 'REQ-013 · AC-2', state: 'todo', kind: 'feat', slug: 'endless-rows',
    modules: ['ArchiveField', 'useKeys'], files: ['src/components/ArchiveField.tsx'], concepts: ['档案场'], tests: [{ name: '到本轮末尾进入下一轮', pass: null }] },
  { id: 'ISS-35', title: '横竖屏切换保持选中', from: 'REQ-012 · AC-6', state: 'todo', kind: 'feat', slug: 'rotate-keep',
    modules: ['ArchiveBrowser', 'browser.css'], files: ['src/styles/browser.css'], concepts: ['档案'], tests: [{ name: '旋转后选中不变', pass: null }] },
];

/* ———— 代码仓库 ———— */
const f = (path: string, extra: Partial<TreeNode> = {}): TreeNode => ({ name: path.split('/').pop()!, path, ...extra });
export function codeTree(issue: Issue): TreeNode[] {
  const mark = (p: string): Partial<TreeNode> => issue.files.includes(p) ? { badge: CODE[p]?.isNew ? 'A' : 'M', ai: issue.state === 'doing' } : {};
  return [
    { name: 'src', path: 'src', children: [
      { name: 'components', path: 'src/components', children: ['ArchiveBrowser.tsx', 'ArchiveField.tsx', 'ArchiveList.tsx', 'FileCallout.tsx', 'useKeys.ts'].map(n => f(`src/components/${n}`, mark(`src/components/${n}`))) },
      { name: 'styles', path: 'src/styles', children: ['browser.css', 'tokens.css'].map(n => f(`src/styles/${n}`, mark(`src/styles/${n}`))) },
      { name: 'data', path: 'src/data', children: [f('src/data/archives.ts', mark('src/data/archives.ts'))] },
      f('src/main.tsx'),
    ] },
    { name: 'tests', path: 'tests', children: [f('tests/browser.test.tsx', mark('tests/browser.test.tsx'))] },
    { name: 'requirements', path: 'requirements', children: [f('requirements/browse/REQ-012.md', { title: '只读 · 需求面' })] },
    f('package.json'), f('vite.config.ts'), f('openapi.yaml', { title: '接口描述' }),
  ];
}

/** 文件内容：每行可标记为本 issue 中助手新增 / 修改。 */
export const CODE: Record<string, { lines: string[]; ai?: number[]; isNew?: boolean }> = {
  'src/components/ArchiveBrowser.tsx': { ai: [4, 5, 6], lines: [
    "import { useMemo, useState } from 'react';", "import { useKeys } from './useKeys';", '',
    'export function ArchiveBrowser({ files, open }: Props) {', '  const [index, setIndex] = useState(0);', '  const sorted = useMemo(() => byNumber(files), [files]);',
    '  useKeys({ up: () => setIndex(i => i - 1), down: () => setIndex(i => i + 1),', '            enter: () => open(sorted[index]) });',
    '  const file = sorted[modulo(index, sorted.length)];', '  return <section className="browser">',
    '    <ArchiveList items={sorted} active={index} onPick={setIndex} />', '    <FileCallout file={file} onOpen={() => open(file)} />', '  </section>;', '}'] },
  'src/components/useKeys.ts': { isNew: true, ai: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], lines: [
    'export function useKeys(map: KeyMap) {', '  useEffect(() => {', '    const on = (e: KeyboardEvent) => {', "      const key = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'enter' }[e.key];",
    '      if (key && map[key]) { e.preventDefault(); map[key](); }', '    };', "    window.addEventListener('keydown', on);", "    return () => window.removeEventListener('keydown', on);", '  }, [map]);', '}'] },
  'src/components/ArchiveList.tsx': { ai: [3, 4], lines: [
    'export function ArchiveList({ items, active, onPick }: Props) {', '  return <ol className="list" role="listbox">', '    {items.map((it, i) =>',
    '      <li key={it.no} role="option" aria-selected={i === active}', '          onClick={() => onPick(i)}>', '        <em>{it.no}</em>{it.title}', '      </li>)}', '  </ol>;', '}'] },
  'src/styles/browser.css': { lines: ['.browser { display: grid; grid-template-columns: 320px 1fr; }', '.list li[aria-selected="true"] { background: var(--ink); color: var(--paper); }', '@container (max-width: 700px) {', '  .browser { grid-template-columns: 1fr; }', '  .browser .list { order: 2; }', '}'] },
  'tests/browser.test.tsx': { isNew: true, ai: [0, 1, 2, 3, 4, 6, 7, 8, 9, 10], lines: [
    "test('arrow keys move the selection', async () => {", '  render(<ArchiveBrowser files={files} />);', "  await user.keyboard('{ArrowDown}');", "  expect(screen.getByRole('heading')).toHaveTextContent('X—014');", '});', '',
    "test('selected file is announced', async () => {", '  render(<ArchiveBrowser files={files} />);', "  await user.keyboard('{ArrowDown}');", "  expect(screen.getByRole('status')).toHaveTextContent('X—014 方法与证据');", '});'] },
  'src/components/FileCallout.tsx': { lines: ['export function FileCallout({ file, onOpen }: Props) {', '  return <aside className="callout">', '    <h1>{file.no}</h1><h2>{file.title}</h2>', '    <button onClick={onOpen}>ACCESS FILE</button>', '  </aside>;', '}'] },
};

/* ———— Diff（本分支相对 develop）———— */
export type Hunk = { path: string; add: number; del: number; lines: { op: ' ' | '+' | '-'; text: string; no: number }[] };
export function diffOf(issue: Issue): Hunk[] {
  return issue.files.filter(p => CODE[p]).map(p => {
    const c = CODE[p]!;
    const lines = c.lines.map((text, i) => ({ op: (c.ai?.includes(i) ? '+' : ' ') as ' ' | '+', text, no: i + 1 }));
    const del = p.endsWith('ArchiveBrowser.tsx') ? [{ op: '-' as const, text: '  const onKey = (e) => { if (e.key === "ArrowDown") next(); };', no: 7 }, { op: '-' as const, text: '  window.onkeydown = onKey;', no: 8 }] : [];
    const out = [...lines.slice(0, 6), ...del, ...lines.slice(6)];
    return { path: p, add: lines.filter(l => l.op === '+').length, del: del.length, lines: out };
  });
}

/* ———— 接口（从 openapi.yaml 读出）———— */
export type Endpoint = { method: 'GET' | 'POST' | 'PATCH'; path: string; title: string; body?: string; response: unknown; ms: number; fresh?: 'new' | 'changed' };
export const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/api/archives?bench=research', title: '列出档案', ms: 38, response: { items: [{ no: 'X—013', title: '文献与实验' }, { no: 'X—014', title: '方法与证据' }, { no: 'X—015', title: '模型结构对照' }, { no: 'X—016', title: '研究笔记' }], total: 4 } },
  { method: 'GET', path: '/api/archives/X—013', title: '档案详情', ms: 24, response: { no: 'X—013', title: '文献与实验', last: { label: '等待确认研究方向', step: 1, total: 5 } } },
  { method: 'POST', path: '/api/archives/X—013/open', title: '抽取档案', body: '{\n  "via": "keyboard"\n}', ms: 61, response: { ok: true, session: 's-7f2a', opened: 'X—013' } },
  { method: 'PATCH', path: '/api/session/selection', title: '记录选中', body: '{\n  "no": "X—014"\n}', ms: 19, response: { ok: true } },
];
/** 「刷新接口」后重新读取：新增一个、变更一个。 */
export const ENDPOINTS_REFRESHED: Endpoint[] = [
  { ...ENDPOINTS[0] }, { ...ENDPOINTS[1] }, { ...ENDPOINTS[2] },
  { ...ENDPOINTS[3], fresh: 'changed', body: '{\n  "no": "X—014",\n  "via": "keyboard"\n}', response: { ok: true, announced: 'X—014 方法与证据' } },
  { method: 'GET', path: '/api/archives/X—013/neighbors', title: '前后档案', ms: 22, fresh: 'new', response: { prev: 'X—016', next: 'X—014', round: 1 } },
];

/* ———— 终端 ———— */
export const TERMINAL_BOOT = ['$ npm run dev', '  VITE v6.0.7  ready in 412 ms', '  ➜  Local:   http://127.0.0.1:5173/'];
export function testRun(issue: Issue) {
  return ['$ npx vitest run tests/browser.test.tsx', ...issue.tests.map(t => t.pass === false ? ` × ${t.name}` : t.pass ? ` ✓ ${t.name} (${20 + t.name.length}ms)` : ` ○ ${t.name}（未实现）`),
    `      Tests  ${issue.tests.filter(t => t.pass).length} passed | ${issue.tests.filter(t => t.pass === false).length} failed (${issue.tests.length})`];
}

/* ———— Archify：项目结构，四层 ———— */
export type Mod = { id: string; layer: 0 | 1 | 2 | 3; x: number; file?: string };
export const LAYERS = ['L1 · 界面', 'L2 · 状态', 'L3 · 数据', 'L4 · 服务'];
export const MODULES: Mod[] = [
  { id: 'ArchiveBrowser', layer: 0, x: 14, file: 'src/components/ArchiveBrowser.tsx' }, { id: 'ArchiveList', layer: 0, x: 34, file: 'src/components/ArchiveList.tsx' },
  { id: 'FileCallout', layer: 0, x: 54, file: 'src/components/FileCallout.tsx' }, { id: 'ArchiveField', layer: 0, x: 74, file: 'src/components/ArchiveField.tsx' },
  { id: 'useKeys', layer: 1, x: 22, file: 'src/components/useKeys.ts' }, { id: 'browser.css', layer: 1, x: 44, file: 'src/styles/browser.css' }, { id: 'session', layer: 1, x: 66 },
  { id: 'archives.ts', layer: 2, x: 34, file: 'src/data/archives.ts' }, { id: 'courseApi', layer: 2, x: 62 },
  { id: 'reinlab_dev', layer: 3, x: 34 }, { id: 'course-cache', layer: 3, x: 54 }, { id: 'OpenMAIC', layer: 3, x: 74 },
];
export const EDGES: [string, string][] = [
  ['ArchiveBrowser', 'ArchiveList'], ['ArchiveBrowser', 'FileCallout'], ['ArchiveBrowser', 'useKeys'], ['ArchiveBrowser', 'browser.css'], ['ArchiveField', 'session'],
  ['ArchiveList', 'archives.ts'], ['FileCallout', 'session'], ['session', 'courseApi'], ['archives.ts', 'reinlab_dev'], ['courseApi', 'course-cache'], ['courseApi', 'OpenMAIC'],
];

/* ———— 数据库与服务 ———— */
export const DATABASES = [{ name: 'reinlab_dev', kind: 'PostgreSQL', tables: ['archives', 'sessions', 'selections', 'workbenches'] }, { name: 'course-cache', kind: 'SQLite', tables: ['courses', 'progress'] }];
export const SERVICES = [{ name: 'dev server', addr: '127.0.0.1:5173', on: true }, { name: 'ontology-checker', addr: 'MCP · stdio', on: true }, { name: 'OpenMAIC', addr: 'localhost:4290', on: false }];
