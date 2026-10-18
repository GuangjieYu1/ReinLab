// 数据台示例数据与「概念派生」（纯前端模拟）。交互沿用 Data Formulator：在编码槽里打一个数据里没有的字段名，
// 或者在概念栏用一句话描述新概念，AI 生成一段 pandas 代码派生出新列 / 过滤 / 聚合，结果成为数据线程里的一个新节点。

export type Val = string | number | boolean;
export type Row = Record<string, Val>;
export type Table = { name: string; cols: string[]; rows: Row[]; derived: string[] };
export type FieldType = 'quantitative' | 'temporal' | 'nominal';
export const typeOf = (t: Table, c: string): FieldType => {
  const vs = t.rows.map(r => r[c]).filter(v => v !== undefined && v !== '');
  if (vs.every(v => typeof v === 'number')) return 'quantitative';
  if (vs.every(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$|^第 \d+ 周$/.test(v))) return 'temporal';
  return 'nominal';
};

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const CATS = ['结构', '优化器', '调度', '数据', '正则'];
const day = (d: number, m = 10) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** 档案 0：实验运行记录（研究台 autoresearch 的 results.tsv）。 */
function runs(): Table {
  const r = rng(7), rows: Row[] = []; let best = 1.0212;
  for (let i = 1; i <= 48; i++) {
    const cat = CATS[Math.floor(r() * CATS.length)], eff = (cat === '调度' ? -.0022 : cat === '结构' ? -.0016 : cat === '数据' ? -.0006 : cat === '正则' ? -.0009 : .0004) * (.4 + r() * 1.4) * Math.exp(-i / 40);
    const v = +(best + eff + (r() - .5) * .0016).toFixed(4), kept = v < best - .0004; if (kept) best = v;
    rows.push({ 实验: i, 类别: cat, val_bpb: v, 保留: kept ? '保留' : '回滚', GPU分钟: +(4.6 + r() * .9).toFixed(1), 日期: day(1 + Math.floor((i - 1) / 8)) });
  }
  return { name: 'results.tsv', cols: ['实验', '类别', 'val_bpb', '保留', 'GPU分钟', '日期'], rows, derived: [] };
}
/** 档案 1：工作台使用分析。 */
function usage(): Table {
  const r = rng(11), rows: Row[] = [], benches = ['研究', '工程', '创作', '数据', '课程'];
  for (let d = 1; d <= 14; d++) benches.forEach((b, k) => { const wk = new Date(2026, 9, d).getDay(); const base = [42, 55, 28, 18, 35][k] * (wk === 0 || wk === 6 ? .45 : 1); rows.push({ 日期: day(d), 工作台: b, 会话数: Math.round(base * (.7 + r() * .6)), 使用分钟: Math.round(base * 6 * (.6 + r() * .8)) }); });
  return { name: 'usage.csv', cols: ['日期', '工作台', '会话数', '使用分钟'], rows, derived: [] };
}
/** 档案 2：京都秋季天气。 */
function weather(): Table {
  const r = rng(23), rows: Row[] = [];
  for (let d = 0; d < 61; d++) { const t = d / 60, m = d < 31 ? 10 : 11, dd = d < 31 ? d + 1 : d - 30; const hi = Math.round((25 - t * 11 + (r() - .5) * 4) * 10) / 10, lo = Math.round((hi - 7 - r() * 4) * 10) / 10; rows.push({ 日期: day(dd, m), 最高温: hi, 最低温: lo, 降水mm: r() < .25 ? Math.round(r() * 220) / 10 : 0, 红叶指数: Math.max(0, Math.min(100, Math.round((t - .35) * 160 + (r() - .5) * 12))) }); }
  return { name: 'kyoto_autumn.csv', cols: ['日期', '最高温', '最低温', '降水mm', '红叶指数'], rows, derived: [] };
}
/** 档案 3：课程学习进度。 */
function course(): Table {
  const r = rng(31), rows: Row[] = [], cs = ['群论', '线性代数', '振动与波', 'CSAPP'];
  for (let w = 1; w <= 10; w++) cs.forEach((c, k) => rows.push({ 周次: `第 ${w} 周`, 课程: c, 完成节数: Math.min(12, Math.round(w * (1 + k * .15) * (.8 + r() * .4))), 测验分: Math.round(58 + w * 3 + (r() - .5) * 18 - k * 2) }));
  return { name: 'progress.csv', cols: ['周次', '课程', '完成节数', '测验分'], rows, derived: [] };
}
export const DATASETS = [runs, usage, weather, course];
export type Enc = { mark: 'bar' | 'line' | 'point'; x?: string; y?: string; color?: string; agg: 'mean' | 'sum' | 'count' };
export const START_ENC: Enc[] = [
  { mark: 'point', x: '实验', y: 'val_bpb', color: '保留', agg: 'mean' },
  { mark: 'line', x: '日期', y: '会话数', color: '工作台', agg: 'sum' },
  { mark: 'line', x: '日期', y: '最高温', agg: 'mean' },
  { mark: 'bar', x: '课程', y: '测验分', agg: 'mean' },
];

/* ———— 概念派生 ———— */
export type Derive = { name: string; kind: 'column' | 'filter' | 'group'; code: string; apply: (t: Table) => Table; enc?: Partial<Enc>; say: string };
const col = (t: Table, name: string, f: (r: Row, i: number, rows: Row[]) => Val, after?: string): Table => {
  const rows = t.rows.map((r, i) => ({ ...r, [name]: f(r, i, t.rows) }));
  const cols = t.cols.includes(name) ? t.cols : (after ? [...t.cols.slice(0, t.cols.indexOf(after) + 1), name, ...t.cols.slice(t.cols.indexOf(after) + 1)] : [...t.cols, name]);
  return { ...t, rows, cols, derived: [...new Set([...t.derived, name])] };
};
export function derive(text: string, t: Table): Derive | null {
  const q = text.trim();
  const has = (c: string) => t.cols.includes(c);
  if (has('val_bpb')) {
    if (/累计最优|最优|前沿|best/.test(q)) return { name: '累计最优', kind: 'column', say: '对 val_bpb 取累计最小值，就是研究台里那条最优前沿。', enc: { mark: 'line', x: '实验', y: '累计最优', color: undefined },
      code: "df['累计最优'] = df['val_bpb'].cummin()", apply: t => col(t, '累计最优', (_r, i, rows) => Math.min(...rows.slice(0, i + 1).map(x => x.val_bpb as number)), 'val_bpb') };
    if (/改进|提升|差值|Δ|delta/.test(q)) return { name: '改进幅度', kind: 'column', say: '每次实验相对此前最优的差值，负数表示变好。', enc: { mark: 'bar', x: '实验', y: '改进幅度', color: '保留' },
      code: "best = df['val_bpb'].cummin().shift(fill_value=1.0212)\ndf['改进幅度'] = df['val_bpb'] - best", apply: t => col(t, '改进幅度', (r, i, rows) => +((r.val_bpb as number) - Math.min(1.0212, ...rows.slice(0, i).map(x => x.val_bpb as number))).toFixed(4), 'val_bpb') };
    if (/只看保留|保留的|kept/.test(q)) return { name: '只看保留', kind: 'filter', say: '过滤掉回滚的实验。', code: "df = df[df['保留'] == '保留']", apply: t => ({ ...t, rows: t.rows.filter(r => r.保留 === '保留') }) };
    if (/类别|平均|每类|命中/.test(q)) return { name: '按类别', kind: 'group', say: '按类别汇总：试了几次、保留率多少。', enc: { mark: 'bar', x: '类别', y: '保留率', color: undefined, agg: 'mean' },
      code: "g = df.groupby('类别')\nout = g.agg(次数=('实验', 'count'), 保留率=('保留', lambda s: (s == '保留').mean()))", apply: t => { const cats = [...new Set(t.rows.map(r => r.类别 as string))]; return { name: 'by_category', cols: ['类别', '次数', '保留率'], derived: ['次数', '保留率'], rows: cats.map(c => { const rs = t.rows.filter(r => r.类别 === c); return { 类别: c, 次数: rs.length, 保留率: +(rs.filter(r => r.保留 === '保留').length / rs.length).toFixed(2) }; }) }; } };
  }
  if (has('最高温')) {
    if (/温差/.test(q)) return { name: '温差', kind: 'column', say: '每天的最高温减最低温。', enc: { mark: 'bar', x: '日期', y: '温差' }, code: "df['温差'] = df['最高温'] - df['最低温']", apply: t => col(t, '温差', r => +((r.最高温 as number) - (r.最低温 as number)).toFixed(1), '最低温') };
    if (/红叶|观赏|赏枫/.test(q)) return { name: '赏枫日', kind: 'column', say: '红叶指数 ≥ 60 且不下雨的日子，标为「适合」。', enc: { mark: 'point', x: '日期', y: '红叶指数', color: '赏枫日' }, code: "df['赏枫日'] = np.where((df['红叶指数'] >= 60) & (df['降水mm'] == 0), '适合', '一般')", apply: t => col(t, '赏枫日', r => (r.红叶指数 as number) >= 60 && r.降水mm === 0 ? '适合' : '一般') };
    if (/下雨|雨天/.test(q)) return { name: '只看雨天', kind: 'filter', say: '只保留有降水的日子。', code: "df = df[df['降水mm'] > 0]", apply: t => ({ ...t, rows: t.rows.filter(r => (r.降水mm as number) > 0) }) };
  }
  if (has('会话数')) {
    if (/周末/.test(q)) return { name: '周末', kind: 'column', say: '按日期标出工作日和周末。', enc: { mark: 'bar', x: '工作台', y: '会话数', color: '周末', agg: 'mean' }, code: "df['周末'] = np.where(pd.to_datetime(df['日期']).dt.weekday >= 5, '周末', '工作日')", apply: t => col(t, '周末', r => { const d = new Date(r.日期 as string).getDay(); return d === 0 || d === 6 ? '周末' : '工作日'; }) };
    if (/人均|每次|平均时长/.test(q)) return { name: '每次分钟', kind: 'column', say: '使用分钟 ÷ 会话数。', enc: { mark: 'bar', x: '工作台', y: '每次分钟', agg: 'mean' }, code: "df['每次分钟'] = df['使用分钟'] / df['会话数']", apply: t => col(t, '每次分钟', r => +((r.使用分钟 as number) / Math.max(1, r.会话数 as number)).toFixed(1)) };
  }
  if (has('测验分')) {
    if (/及格|通过/.test(q)) return { name: '及格', kind: 'column', say: '测验分 ≥ 60 记为及格。', enc: { mark: 'bar', x: '课程', y: '测验分', color: '及格' }, code: "df['及格'] = np.where(df['测验分'] >= 60, '及格', '未及格')", apply: t => col(t, '及格', r => (r.测验分 as number) >= 60 ? '及格' : '未及格') };
    if (/完成率|进度/.test(q)) return { name: '完成率', kind: 'column', say: '完成节数 ÷ 12 节。', enc: { mark: 'line', x: '周次', y: '完成率', color: '课程' }, code: "df['完成率'] = df['完成节数'] / 12", apply: t => col(t, '完成率', r => +((r.完成节数 as number) / 12).toFixed(2)) };
  }
  return null;
}
export const HINTS: string[][] = [['累计最优', '改进幅度', '只看保留的实验', '按类别看保留率'], ['周末', '每次会话的平均分钟'], ['温差', '赏枫日', '只看雨天'], ['及格', '完成率']];
