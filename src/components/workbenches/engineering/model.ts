// 工程台 · 需求面的示例数据与本地模拟（纯前端）。
// 需求文档 = 带结构的 Markdown，受 Git 管理；每一段是一个块（用户故事 / 验收标准 / 约束 / 开放问题）。
// 校验 = 把本次 diff 通过 MCP 交给本体论模型；这里用规则在本地模拟模型的回答。

export type BlockKind = 'story' | 'ac' | 'rule' | 'nfr' | 'open';
export type Block = { id: string; kind: BlockKind; text: string };
export type ReqDoc = { id: string; title: string; path: string; branch: string; blocks: Block[] };

export const SECTION: Record<BlockKind, { zh: string; en: string; label: (n: number) => string }> = {
  story: { zh: '用户故事', en: 'STORY', label: n => `S-${n}` },
  ac: { zh: '验收标准', en: 'ACCEPTANCE', label: n => `AC-${n}` },
  rule: { zh: '约束', en: 'CONSTRAINT', label: n => `R-${n}` },
  nfr: { zh: '非功能要求', en: 'NON-FUNCTIONAL', label: n => `N-${n}` },
  open: { zh: '开放问题', en: 'OPEN', label: n => `Q-${n}` },
};
export const ORDER: BlockKind[] = ['story', 'ac', 'rule', 'nfr', 'open'];

const doc = (id: string, title: string, dir: string, blocks: [BlockKind, string][], branch = 'develop'): ReqDoc => {
  const count: Partial<Record<BlockKind, number>> = {};
  return { id, title, path: `requirements/${dir}/${id}.md`, branch, blocks: blocks.map(([kind, text]) => { count[kind] = (count[kind] ?? 0) + 1; return { id: SECTION[kind].label(count[kind]!), kind, text }; }) };
};

/** develop 上的版本：校验时拿当前内容与它比较，得到 diff。 */
export const BASELINE: Record<string, ReqDoc> = Object.fromEntries([
  doc('REQ-010', '档案场与抽取', 'browse', [
    ['story', '作为研究者，我想在档案场里一眼看到属于这个工作台的档案，并能把其中一份抽出来查看。'],
    ['ac', 'Given 进入模块 Files · When 档案场显影完成 · Then 选中的档案盒抬升，档案号与标题出现在右侧说明里。'],
    ['ac', 'Given 选中某份档案 · When 点击 ACCESS FILE · Then 档案盒抬升到位后，档案小票从盒口提出，落在档案盒右边。'],
    ['ac', 'Given 档案小票已展示 · When 点击「继续工作」 · Then 小票放回盒内，档案盒打开，取出文档并展开为工作台。'],
    ['rule', '不使用 WebGL；档案场用 CSS 3D 绘制。'],
  ]),
  doc('REQ-012', '档案浏览器 · 键盘与窄屏', 'browse', [
    ['story', '作为研究者，我想只用键盘在档案场中前后、左右浏览并调阅档案，这样不必离开键盘就能切换工作。'],
    ['ac', 'Given 模块 Files 已打开 · When 按 ↓ · Then 选中下一份档案，档案号与标题同步更新。'],
    ['ac', 'Given 选中某份档案 · When 按 Enter · Then 抽出档案盒，并展示档案小票。'],
    ['ac', 'Given 视口宽度 < 900px · When 打开模块 Files · Then 列表竖排在说明下方。'],
    ['rule', '不使用 WebGL；动画只改 transform 与 opacity。'],
  ], 'req/REQ-012'),
  doc('REQ-013', '无限档案场', 'browse', [
    ['story', '作为研究者，我想让档案场在前后左右都没有尽头，浏览时永远不会撞到边缘。'],
    ['ac', 'Given 模块 Files 已打开 · When 按 → · Then 切到下一列，即下一个工作台的档案。'],
    ['ac', 'Given 已到本轮最后一份档案 · When 按 ↓ · Then 进入下一轮的第一份，档案场继续向前延伸。'],
    ['ac', 'Given 连续浏览 · When 远处的行与列离开窗口 · Then 它们沉入档案海，并在另一端重新浮起。'],
    ['rule', '同屏档案盒不超过 252 个，格位循环复用。'],
  ]),
  doc('REQ-020', '顶栏与面签', 'shell', [
    ['story', '作为使用者，我想在每个工作台顶部看到档案号、档案名和面签，知道自己在哪里。'],
    ['ac', 'Given 进入任一工作台 · When 页面加载完成 · Then 顶栏显示工作台标识、档案号与档案名。'],
  ]),
  doc('REQ-021', 'Agent 坞与动作表', 'shell', [
    ['story', '作为使用者，我想让每个档案都有一个常驻助手，它能做的事和按钮能做的事完全一样。'],
    ['ac', 'Given 工作台已展开 · When Agent 坞加载 · Then 助手先读取工作区说明，再给出建议动作。'],
    ['ac', 'Given 助手要执行写入类动作 · When 生成动作 · Then 先出审批卡，你批准后才执行。'],
    ['ac', 'Given 动作风险为 danger · When 你让助手执行 · Then 助手拒绝，只提示你自己点。'],
  ]),
  doc('REQ-030', 'OpenMAIC 交接', 'handoff', [
    ['story', '作为学习者，我想从课程档案直接进入 OpenMAIC 课堂，进度能接上。'],
    ['ac', 'Given 课程档案的小票已展示 · When 点击「进入课堂」 · Then 交接给 OpenMAIC，并带上上次的章节。'],
  ]),
].map(d => [d.id, d]));

/** 分支上的当前版本（REQ-012 在 req/REQ-012 上有改动：AC-3 改了，新增 AC-4、AC-5、N-1、Q-1）。 */
export function initialDocs(): Record<string, ReqDoc> {
  const docs: Record<string, ReqDoc> = JSON.parse(JSON.stringify(BASELINE));
  docs['REQ-012'].blocks = [
    ...docs['REQ-012'].blocks.slice(0, 3),
    { id: 'AC-3', kind: 'ac', text: 'Given 视口宽度 < 900px · When 打开模块 Files · Then 列表竖排在说明下方，页面不出现横向滚动。' },
    { id: 'AC-4', kind: 'ac', text: 'Given 按住 ↓ · When 连续浏览 · Then 浏览流畅。' },
    { id: 'AC-5', kind: 'ac', text: 'Given 已浏览到最后一份档案 · When 按 ↓ · Then 停在最后一份，不再移动。' },
    { id: 'AC-6', kind: 'ac', text: 'Given 选中某份档案 · When 按 Esc' },
    docs['REQ-012'].blocks[4],
    { id: 'N-1', kind: 'nfr', text: '选中格切换时，屏幕阅读器读出档案号与标题。' },
    { id: 'Q-1', kind: 'open', text: '窄屏下是否保留档案场背景，还是只保留列表？' },
  ];
  return docs;
}

export const DIRECTORY = [
  { id: 'browse', title: '档案浏览', docs: ['REQ-010', 'REQ-012', 'REQ-013'] },
  { id: 'shell', title: '工作台外壳', docs: ['REQ-020', 'REQ-021'] },
  { id: 'handoff', title: '课程交接', docs: ['REQ-030'] },
];

/** 本体概念：文中出现即加下划线。 */
export type Concept = { id: string; name: string; def: string; rel: string[]; rule?: string };
export const ONTOLOGY: Concept[] = [
  { id: 'C-FIELD', name: '档案场', def: '档案盒排成的阵列，是模块 Files 的主视图。', rel: ['包含 → 档案盒', '每列对应 → 工作台'], rule: '档案场在行、列两个方向上都没有边界。' },
  { id: 'C-CASSETTE', name: '档案盒', def: '档案在档案场中的实体，可抽出、开盖、取出文档。', rel: ['容纳 → 档案', '排列在 → 档案场'] },
  { id: 'C-SLIP', name: '档案小票', def: '竖放在档案盒里的窄长小票：名称、上次停在哪里、继续或返回。', rel: ['摘要 → 档案'] },
  { id: 'C-FILENO', name: '档案号', def: '形如 X—013 的编号，在一个工作台内唯一。', rel: ['标识 → 档案'] },
  { id: 'C-FILE', name: '档案', def: '一个工作区的最小单位，带唯一档案号，存放在档案盒里。', rel: ['属于 → 工作台', '收在 → 档案盒'] },
  { id: 'C-BENCH', name: '工作台', def: '七个工作台之一，每个工作台有自己的档案。', rel: ['拥有 → 档案'] },
  { id: 'C-AGENT', name: '助手', def: '每个档案的常驻 Agent，与按钮共用动作表。', rel: ['维护 → 档案'] },
];
const BY_LENGTH = [...ONTOLOGY].sort((a, b) => b.name.length - a.name.length);
export const conceptOf = (name: string) => ONTOLOGY.find(c => c.name === name);

/** 把一段文字拆成普通文字与本体术语。 */
export function terms(text: string): { text: string; concept?: Concept }[] {
  const out: { text: string; concept?: Concept }[] = [];
  let i = 0, buf = '';
  while (i < text.length) {
    const hit = BY_LENGTH.find(c => text.startsWith(c.name, i));
    if (hit) { if (buf) out.push({ text: buf }); buf = ''; out.push({ text: hit.name, concept: hit }); i += hit.name.length; }
    else { buf += text[i]; i++; }
  }
  if (buf) out.push({ text: buf });
  return out;
}

/** 写完了没有：验收标准要 Given / When / Then 齐全并以句号结尾；其他段落以句号或问号结尾。 */
export function isComplete(b: Block) {
  const t = b.text.trim();
  if (b.kind === 'ac') return /^Given\s+\S.*·\s*When\s+\S.*·\s*Then\s+\S.*[。.]$/.test(t);
  return t.length >= 8 && /[。？?.]$/.test(t);
}

/* ———— 实时补全（模拟模型）———— */
const CANDIDATES: string[] = [
  'Given 选中某份档案 · When 按 Esc · Then 档案小票放回档案盒，回到档案场。',
  'Given 选中某份档案 · When 按 Enter · Then 抽出档案盒，并展示档案小票。',
  'Given 模块 Files 已打开 · When 按 ↑ · Then 选中上一份档案，档案号与标题同步更新。',
  'Given 模块 Files 已打开 · When 按 → · Then 切到下一列，即下一个工作台的档案。',
  'Given 视口宽度 < 900px · When 设备旋转为横屏 · Then 列表在 200ms 内切回左右布局，选中的档案不变。',
  'Given 屏幕阅读器已开启 · When 选中的档案改变 · Then 读出档案号与标题。',
  'Given 档案小票已展示 · When 点击「继续工作」 · Then 小票放回盒内，档案盒打开，取出文档并展开为工作台。',
  '作为研究者，我想在不离开键盘的情况下完成从浏览到调阅的全过程。',
  '动画只改 transform 与 opacity，每帧不超过 16.7ms。',
];
/** 根据当前段落的文字给出补全（只补在末尾）。 */
export function suggest(text: string, kind: BlockKind): string {
  const t = text;
  if (!t.trim()) return kind === 'ac' ? 'Given ' : '';
  const full = CANDIDATES.find(c => c.startsWith(t) && c.length > t.length);
  if (full) return full.slice(t.length);
  // 术语补全：末尾的几个汉字是某个本体概念的开头
  for (let n = 3; n >= 1; n--) {
    const tail = t.slice(-n);
    if (!/^[一-龥]+$/.test(tail)) continue;
    const c = BY_LENGTH.find(x => x.name.startsWith(tail) && x.name.length > tail.length);
    if (c) return c.name.slice(tail.length);
  }
  if (kind === 'ac') {
    if (/Given\s+\S/.test(t) && !/When/.test(t) && /[\s·]$/.test(t)) return t.endsWith('·') || t.endsWith('· ') ? ' When ' : '· When ';
    if (/When\s+\S/.test(t) && !/Then/.test(t) && /[\s·]$/.test(t)) return t.endsWith('·') || t.endsWith('· ') ? ' Then ' : '· Then ';
    if (/When\s+按 Esc$/.test(t)) return ' · Then 档案小票放回档案盒，回到档案场。';
  }
  return '';
}

/* ———— 本体论模型的校验（模拟）———— */
export type NoteKind = 'conflict' | 'logic' | 'clarify' | 'term';
export type Option = { label: string; text: string };
export type Note = {
  key: string;            // 文档 · 块 · 规则：同一条问题在多轮之间的身份
  doc: string; block: string; kind: NoteKind;
  quote: string;          // 原文里要标注的片段
  title: string; detail: string; options: Option[];
  state: 'open' | 'fixed' | 'explained';
  thread: { who: 'model' | 'me'; text: string }[];
  round: number;
};
export const KIND_LABEL: Record<NoteKind, string> = { conflict: '本体冲突', logic: '逻辑问题', clarify: '待澄清', term: '新术语' };

/** 模型对一个块的检查。explained：本分支会话里你已经说明过的问题，模型记得，不再提出。 */
export function inspect(doc: string, b: Block, explained: Set<string>): Omit<Note, 'state' | 'thread' | 'round'>[] {
  const out: Omit<Note, 'state' | 'thread' | 'round'>[] = [];
  const add = (rule: string, n: Omit<Note, 'state' | 'thread' | 'round' | 'key' | 'doc' | 'block'>) => { const key = `${doc}·${b.id}·${rule}`; if (!explained.has(key)) out.push({ key, doc, block: b.id, ...n }); };
  const t = b.text;
  if (/最后一份/.test(t) && /停|不再/.test(t)) {
    const quote = t.match(/停[^，。]*[，。]?[^。]*/)?.[0]?.replace(/。$/, '') ?? '停在最后一份';
    add('field-edge', { kind: 'conflict', quote, title: '与本体约束「档案场没有边界」冲突', detail: '「停在最后一份」假设档案场有尽头；本体 C-FIELD 规定档案场在行、列两个方向上都没有边界，REQ-013 依赖这条约束。',
      options: [{ label: '改为进入下一轮', text: t.replace(/已浏览到最后一份档案/, '已浏览到本轮最后一份档案').replace(quote, '进入下一轮的第一份，档案场继续向前延伸') }, { label: '引用 REQ-013 并删去本条', text: '（见 REQ-013 AC-2：到本轮最后一份时进入下一轮。）' }] });
  }
  const vague = t.match(/流畅|快速|友好|尽量|适当|合理/);
  if (vague) add('vague', { kind: 'logic', quote: `浏览${vague[0]}`.includes(vague[0]) && t.includes(`浏览${vague[0]}`) ? `浏览${vague[0]}` : vague[0], title: `「${vague[0]}」不可测`, detail: '没有可验证的标准，测试面无法据此生成用例。',
    options: [{ label: '改为帧时间', text: t.replace(/连续浏览/, '连续浏览 30 份档案').replace(/浏览流畅|流畅/, '没有超过 34ms 的帧（1440×900 实测）') }, { label: '改为平均帧时间', text: t.replace(/浏览流畅|流畅/, '平均帧时间不超过 16.7ms') }] });
  if (b.kind === 'ac' && t.trim() && !/Then\s+\S/.test(t)) add('no-then', { kind: 'logic', quote: t.trim().slice(-8), title: '缺少 Then', detail: '这条验收标准只有前提与动作，没有可检查的结果。',
    options: [{ label: '补全结果', text: (suggest(t, 'ac') ? t + suggest(t, 'ac') : `${t.replace(/[。.]$/, '')} · Then 回到档案场，选中的档案不变。`) }] });
  if (/选中格/.test(t)) add('term-cell', { kind: 'term', quote: '选中格', title: '「选中格」不在本体里', detail: '本体里只有「档案」「档案盒」。是新概念，还是换成已有概念？',
    options: [{ label: '换成「选中的档案」', text: t.replace('选中格', '选中的档案') }, { label: '作为新概念加入本体', text: t }] });
  if (b.kind === 'open') add('open', { kind: 'clarify', quote: t.replace(/[？?]$/, ''), title: '开放问题需要一个决定', detail: '开放问题会让开发面无法拆分 issue。选一个，我把它改写成约束。',
    options: [{ label: '保留背景（降低到 30%）', text: '窄屏下保留档案场背景，透明度降到 30%，列表浮在其上。' }, { label: '只保留列表', text: '窄屏下不渲染档案场，只保留列表与说明。' }] });
  return out;
}

/** 你在标注里写下理由后，模型的回答（模拟）：说明充分就接受并记住，否则追问一次。 */
export function reply(note: Note, text: string): { accept: boolean; text: string } {
  const strong = text.length >= 10 || /因为|所以|故意|保留|不需要|产品|设计/.test(text);
  if (!strong) return { accept: false, text: '能多说一点原因吗？比如这条在什么场景下成立。我会把它记进这个分支的会话里。' };
  return { accept: true, text: note.kind === 'conflict' ? '理解。我把这条记为 REQ-012 对 C-FIELD 的有意例外，后续轮次不再提出，并在 MR 描述里注明。' : '收到，按你的写法保留。这个理由已记入 req/REQ-012 的会话，下一轮校验会带上。' };
}

/* ———— 「功能全流程」：助手回复里的交互卡片 ———— */
export type FlowStep = { doc: string; block: string; note: string };
export type Flow = { title: string; keywords: RegExp; steps: FlowStep[] };
export const FLOWS: Flow[] = [
  { title: '调阅档案', keywords: /调阅|抽取|抽出|打开档案|access|小票/i, steps: [
    { doc: 'REQ-010', block: 'AC-1', note: '进入模块 Files，选中的档案盒抬升' },
    { doc: 'REQ-012', block: 'AC-1', note: '用 ↑↓ 选中要调阅的档案' },
    { doc: 'REQ-012', block: 'AC-2', note: '按 Enter 抽出档案盒' },
    { doc: 'REQ-010', block: 'AC-2', note: '档案小票从盒口提出，落在右边' },
    { doc: 'REQ-010', block: 'AC-3', note: '「继续工作」：打开档案盒，取出文档' },
    { doc: 'REQ-021', block: 'AC-1', note: '工作台展开，助手读取工作区说明' },
  ] },
  { title: '键盘浏览档案场', keywords: /浏览|键盘|无限|翻阅|方向键/, steps: [
    { doc: 'REQ-012', block: 'S-1', note: '目标：只用键盘浏览与调阅' },
    { doc: 'REQ-012', block: 'AC-1', note: '↓ 选中下一份' },
    { doc: 'REQ-013', block: 'AC-1', note: '→ 切到下一列（下一个工作台）' },
    { doc: 'REQ-013', block: 'AC-2', note: '到本轮末尾，进入下一轮' },
    { doc: 'REQ-013', block: 'AC-3', note: '远处的行列沉入档案海、另一端浮起' },
  ] },
  { title: '助手执行动作', keywords: /助手|动作|审批|agent/i, steps: [
    { doc: 'REQ-021', block: 'S-1', note: '按钮与助手共用动作表' },
    { doc: 'REQ-021', block: 'AC-1', note: '先读工作区说明' },
    { doc: 'REQ-021', block: 'AC-2', note: '写入类：先审批' },
    { doc: 'REQ-021', block: 'AC-3', note: 'danger：只能你点' },
  ] },
];
