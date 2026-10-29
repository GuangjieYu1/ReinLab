// 工程台 · 测试面的示例数据（纯前端，本地模拟）。
// 用例由需求的验收标准生成：需求 → 验收标准 → 用例；每个用例在三个环境下各跑一次。

export type Env = 'desktop' | 'tablet' | 'mobile';
export const ENVS: { id: Env; label: string; w: number }[] = [{ id: 'desktop', label: '桌面', w: 1440 }, { id: 'tablet', label: '平板', w: 768 }, { id: 'mobile', label: '手机', w: 390 }];
export type Status = 'pass' | 'fail' | 'flaky' | 'none' | 'running';
export const STATUS_LABEL: Record<Status, string> = { pass: '通过', fail: '失败', flaky: '不稳定', none: '未运行', running: '运行中' };

export type Step = { action: string; expect: string; actual?: string; ok?: boolean };
export type Failure =
  | { kind: 'visual'; summary: string; dom: string; stack: { file: string; line: number; text: string }; issue: string }
  | { kind: 'api'; summary: string; expected: unknown; actual: unknown; stack: { file: string; line: number; text: string }; issue: string };
export type Case = {
  id: string; title: string; req: string; ac: string; kind: 'ui' | 'api'; tags: string[];
  results: Record<Env, Status>; ms: number; steps: Step[]; failure?: Failure; draft?: boolean; lastRun: string;
};

const all = (s: Status): Record<Env, Status> => ({ desktop: s, tablet: s, mobile: s });
export const CASES: Case[] = [
  { id: 'CASE-101', title: '↓ 选中下一份档案', req: 'REQ-012', ac: 'AC-1', kind: 'ui', tags: ['键盘'], results: all('pass'), ms: 420, lastRun: '10:12',
    steps: [{ action: '打开模块 Files', expect: '选中 X—013', ok: true }, { action: '按 ↓', expect: '选中 X—014，标题同步更新', ok: true }] },
  { id: 'CASE-102', title: '↑ 选中上一份档案', req: 'REQ-012', ac: 'AC-1', kind: 'ui', tags: ['键盘'], results: all('pass'), ms: 390, lastRun: '10:12',
    steps: [{ action: '选中 X—014', expect: '—', ok: true }, { action: '按 ↑', expect: '选中 X—013', ok: true }] },
  { id: 'CASE-110', title: 'Enter 抽出档案盒', req: 'REQ-012', ac: 'AC-2', kind: 'ui', tags: ['键盘'], results: { desktop: 'pass', tablet: 'pass', mobile: 'flaky' }, ms: 1180, lastRun: '10:12',
    steps: [{ action: '选中 X—013', expect: '—', ok: true }, { action: '按 Enter', expect: '档案盒抬升，小票从盒口提出', actual: '手机宽度下偶尔在动画结束前截图', ok: true }] },
  { id: 'CASE-118', title: '窄屏下列表竖排', req: 'REQ-012', ac: 'AC-3', kind: 'ui', tags: ['窄屏', '布局'], results: { desktop: 'pass', tablet: 'pass', mobile: 'fail' }, ms: 640, lastRun: '10:13',
    steps: [{ action: '视口设为 390 × 844', expect: '—', ok: true }, { action: '打开模块 Files', expect: '页面加载完成', ok: true }, { action: '观察列表位置', expect: '列表竖排在说明下方', actual: '列表仍在左侧，说明被挤出视口', ok: false }],
    failure: { kind: 'visual', summary: '容器查询没有生效：.browser 的父级没有声明 container-type，@container 规则从未匹配。', issue: 'ISS-33',
      dom: '<section class="browser">\n  <ol class="list" role="listbox">…</ol>   ← 宽 320px，未换行\n  <aside class="callout">…</aside>       ← 溢出 112px\n</section>',
      stack: { file: 'src/styles/browser.css', line: 3, text: '@container (max-width: 700px) {' } } },
  { id: 'CASE-119', title: '窄屏不出现横向滚动', req: 'REQ-012', ac: 'AC-3', kind: 'ui', tags: ['窄屏'], results: { desktop: 'pass', tablet: 'pass', mobile: 'fail' }, ms: 300, lastRun: '10:13',
    steps: [{ action: '视口设为 390 × 844', expect: '—', ok: true }, { action: '读取 scrollWidth', expect: '≤ 390', actual: '502', ok: false }],
    failure: { kind: 'visual', summary: '与 CASE-118 同源：说明区溢出导致横向滚动。', issue: 'ISS-33', dom: '<html scrollWidth="502" clientWidth="390">', stack: { file: 'src/styles/browser.css', line: 1, text: '.browser { display: grid; grid-template-columns: 320px 1fr; }' } } },
  { id: 'CASE-121', title: '连续浏览 30 份无掉帧', req: 'REQ-012', ac: 'AC-4', kind: 'ui', tags: ['性能', '键盘'], results: all('none'), ms: 0, lastRun: '—',
    steps: [{ action: '按住 ↓ 浏览 30 份', expect: '没有超过 34ms 的帧' }] },
  { id: 'CASE-131', title: '小票从盒口提出', req: 'REQ-010', ac: 'AC-2', kind: 'ui', tags: ['动效'], results: all('pass'), ms: 1320, lastRun: '09:58',
    steps: [{ action: '点击 ACCESS FILE', expect: '小票落在档案盒右边', ok: true }] },
  { id: 'CASE-132', title: '继续工作展开为工作台', req: 'REQ-010', ac: 'AC-3', kind: 'ui', tags: ['动效'], results: all('pass'), ms: 3900, lastRun: '09:58',
    steps: [{ action: '点击「继续工作」', expect: '档案盒打开，文档展开为工作台', ok: true }] },
  { id: 'CASE-201', title: 'GET /archives 返回 4 份档案', req: 'REQ-012', ac: 'AC-1', kind: 'api', tags: ['接口'], results: all('pass'), ms: 38, lastRun: '10:12',
    steps: [{ action: 'GET /api/archives?bench=research', expect: '200 · items.length = 4', ok: true }] },
  { id: 'CASE-202', title: 'PATCH /session/selection 读出档案号', req: 'REQ-012', ac: 'AC-1', kind: 'api', tags: ['接口', '读屏'], results: all('fail'), ms: 19, lastRun: '10:12',
    steps: [{ action: 'PATCH /api/session/selection { no: "X—014" }', expect: '200 · announced = "X—014 方法与证据"', actual: '200 · 没有 announced 字段', ok: false }],
    failure: { kind: 'api', summary: '响应缺少 announced 字段：接口描述在 feat/ISS-32 上已变更，develop 上的实现还没有合入。', issue: 'ISS-32',
      expected: { ok: true, announced: 'X—014 方法与证据' }, actual: { ok: true },
      stack: { file: 'server/routes/session.ts', line: 14, text: "return res.json({ ok: true });" } } },
  { id: 'CASE-203', title: 'GET /neighbors 返回前后档案', req: 'REQ-013', ac: 'AC-2', kind: 'api', tags: ['接口'], results: all('none'), ms: 0, lastRun: '—',
    steps: [{ action: 'GET /api/archives/X—013/neighbors', expect: '200 · prev / next / round' }] },
];
/** 「为 AC-3 补边界用例」生成的草稿。 */
export const DRAFTS: Case[] = [
  { id: 'CASE-118b', title: '恰好 900px 时的布局', req: 'REQ-012', ac: 'AC-3', kind: 'ui', tags: ['窄屏', '边界'], results: all('none'), ms: 0, lastRun: '—', draft: true, steps: [{ action: '视口设为 900 × 900', expect: '保持左右布局（< 900 才竖排）' }] },
  { id: 'CASE-118c', title: '竖排后选中项可见', req: 'REQ-012', ac: 'AC-3', kind: 'ui', tags: ['窄屏', '边界'], results: all('none'), ms: 0, lastRun: '—', draft: true, steps: [{ action: '390 宽下连续按 ↓ 4 次', expect: '选中的档案始终在视口内' }] },
];

export const REQ_TITLE: Record<string, string> = { 'REQ-010': '档案场与抽取', 'REQ-012': '档案浏览器 · 键盘与窄屏', 'REQ-013': '无限档案场' };
export const QUEUE = [
  { id: 'ISS-31', title: '档案列表 option 语义', from: 'REQ-012 · AC-1', cases: 3 },
  { id: 'ISS-32', title: '档案浏览器 · 键盘选择', from: 'REQ-012 · AC-1 · AC-2', cases: 4 },
];

/* ———— 接口测试：端点 + 断言 + 契约检查 ———— */
export type Assertion = { text: string; ok: boolean };
export type ApiCase = { method: 'GET' | 'POST' | 'PATCH'; path: string; title: string; caseId?: string; body?: string; response: unknown; status: number; ms: number; assertions: Assertion[]; contract?: 'new' | 'changed' };
export const API_CASES: ApiCase[] = [
  { method: 'GET', path: '/api/archives?bench=research', title: '列出档案', caseId: 'CASE-201', status: 200, ms: 38, response: { items: [{ no: 'X—013' }, { no: 'X—014' }, { no: 'X—015' }, { no: 'X—016' }], total: 4 },
    assertions: [{ text: 'status = 200', ok: true }, { text: 'items.length = 4', ok: true }, { text: '符合 openapi 模式 ArchiveList', ok: true }] },
  { method: 'GET', path: '/api/archives/X—013', title: '档案详情', status: 200, ms: 24, response: { no: 'X—013', title: '文献与实验', last: { step: 1, total: 5 } },
    assertions: [{ text: 'status = 200', ok: true }, { text: 'last.step ≤ last.total', ok: true }] },
  { method: 'POST', path: '/api/archives/X—013/open', title: '抽取档案', body: '{\n  "via": "keyboard"\n}', status: 200, ms: 61, response: { ok: true, opened: 'X—013' },
    assertions: [{ text: 'status = 200', ok: true }, { text: 'opened = "X—013"', ok: true }] },
  { method: 'PATCH', path: '/api/session/selection', title: '记录选中', caseId: 'CASE-202', body: '{\n  "no": "X—014",\n  "via": "keyboard"\n}', status: 200, ms: 19, response: { ok: true }, contract: 'changed',
    assertions: [{ text: 'status = 200', ok: true }, { text: 'announced = "X—014 方法与证据"', ok: false }, { text: '符合 openapi 模式 SelectionResult', ok: false }] },
  { method: 'GET', path: '/api/archives/X—013/neighbors', title: '前后档案', caseId: 'CASE-203', status: 404, ms: 9, response: { error: 'not found' }, contract: 'new',
    assertions: [{ text: 'status = 200', ok: false }, { text: '返回 prev / next / round', ok: false }] },
];

/* ———— 录制回放 ———— */
export type Frame = { at: number; step: string; layout: 'loading' | 'side' | 'stacked' | 'overflow'; fail?: boolean };
export const RECORDING: Frame[] = [
  { at: 0, step: '视口设为 390 × 844', layout: 'loading' },
  { at: 0.8, step: '打开模块 Files', layout: 'overflow' },
  { at: 1.6, step: '等待档案场显影', layout: 'overflow' },
  { at: 2.4, step: '观察列表位置 → 列表仍在左侧，说明溢出 112px', layout: 'overflow', fail: true },
];

/** 上一批（#6）的结果，用来在报告里对比。 */
export const LAST_BATCH = { n: 6, pass: 14, fail: 1, flaky: 2, none: 6 };
