// 常驻自动化 · 示例数据与模拟数据流（design/AUTOMATION_LIVE.md）。
// 一个常驻自动化 = 脚本 + 参数（旋钮）+ 声明式面板 + 维护 Agent，用一份 automation.yaml 描述。
// 这里每「一拍」代表一分钟（第一版分钟级），数据由按种子确定的随机游走生成，不连接任何外部来源。

export type Risk = 'low' | 'medium' | 'high';
export type ParamKind = 'number' | 'enum' | 'multi' | 'tags';
export type Param = {
  key: string; label: string; kind: ParamKind; value: number | string | string[]; risk: Risk;
  min?: number; max?: number; step?: number; unit?: string; options?: string[]; hint?: string;
};
export type Widget =
  | { kind: 'line'; title: string; series: string[]; threshold?: string; band?: [number, number]; fmt?: 'pct' | 'num' | 'px'; span: number; rows?: number }
  | { kind: 'stat'; title: string; stat: string; span: number }
  | { kind: 'table'; title: string; cols: [string, string][]; span: number }
  | { kind: 'bars'; title: string; span: number }
  | { kind: 'depth'; title: string; span: number }
  | { kind: 'sim'; title: string; span: number; rows?: number };
export type UnitState = 'ok' | 'alert' | 'fail' | 'paused' | 'trial';
export type SourceType = 'github' | 'research' | 'idea' | 'api';
export type Unit = {
  id: string; title: string; kind: 'live' | 'simulation'; cadence: string; state: UnitState;
  source: { type: SourceType; label: string }; runtime: string; network: string[];
  params: Param[]; streams: Record<string, string>; panel: Widget[]; alerts: string[];
  versions: { v: string; at: string; note: string }[]; observeOnly: true; note?: string;
  template?: string; samples?: string[];
};
export type Row = Record<string, string | number>;
export type LiveData = {
  minute: number;
  series: Record<string, number[]>;
  stats: Record<string, { v: string; sub?: string; alert?: boolean }>;
  rows: Row[];
  bars?: [string, number][];
  depth?: { bids: [number, number][]; asks: [number, number][]; mid: number };
  sim?: { step: number; steps: number; running: boolean; curves: { name: string; pts: number[]; now?: boolean }[] };
  alert: string | null;
};

export const SOURCE_LABEL: Record<SourceType, string> = { github: 'GitHub 项目', research: '研究台成果', idea: '一句话想法', api: '外部 API' };
export const STATE_TEXT: Record<UnitState, string> = { ok: '运行中', alert: '告警', fail: '失败', paused: '已暂停', trial: '沙盒试跑' };
export const RISK_TEXT: Record<Risk, string> = { low: '低 · 直接生效', medium: '中 · 需批准', high: '高 · 需批准' };
export const WINDOW = 120;          // 面板保留最近 120 分钟
export const NOW0 = 9 * 60 + 36;   // 示例里「现在」是 09:36，与例程时间表一致
export const hm = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`;

export function rng(seed: number) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const pv = (u: Unit, key: string) => u.params.find(p => p.key === key)?.value;

export const UNITS: Unit[] = [
  {
    id: 'LV-01', title: '新能源车舆情', kind: 'live', cadence: '1m', state: 'ok', observeOnly: true,
    source: { type: 'idea', label: '「盯一下新能源车的口碑变化」' }, runtime: 'python 3.11 · 0.25 CPU · 256 MB',
    network: ['rss.example-news.cn', 'forum.example-auto.cn', 'api.example-news.com'],
    params: [
      { key: 'keywords', label: '关键词', kind: 'tags', value: ['新能源', '智驾', '续航'], risk: 'low', hint: '命中任一即计入' },
      { key: 'sources', label: '来源', kind: 'multi', value: ['新闻', '论坛', 'RSS'], options: ['新闻', '论坛', 'RSS', '短视频'], risk: 'medium', hint: '新增来源会访问新的域名' },
      { key: 'threshold', label: '告警阈值', kind: 'number', value: -0.3, min: -1, max: 0, step: 0.05, risk: 'low', hint: '任一来源情感分连续 15 分钟低于它就告警' },
    ],
    streams: { 新闻: 'sentiment.news', 论坛: 'sentiment.forum', RSS: 'sentiment.rss', 声量: 'volume' },
    panel: [
      { kind: 'line', title: '情感分 · 按来源', series: ['新闻', '论坛', 'RSS', '短视频'], threshold: 'threshold', band: [-1, 1], span: 8, rows: 2 },
      { kind: 'stat', title: '近 1 小时声量', stat: 'volume', span: 4 },
      { kind: 'stat', title: '最低来源', stat: 'low', span: 4 },
      { kind: 'table', title: '最新提及', cols: [['t', '时间'], ['src', '来源'], ['title', '标题'], ['score', '情感']], span: 12 },
    ],
    alerts: ['任一来源情感分 < 告警阈值，持续 15 分钟 → 收件箱'],
    versions: [{ v: 'v1.2', at: '昨天', note: '加上 RSS 来源' }, { v: 'v1.1', at: '10-12', note: '阈值 -0.4 → -0.3' }, { v: 'v1.0', at: '10-09', note: '一句话创建' }],
  },
  {
    id: 'LV-02', title: 'BTC 盘口波动', kind: 'live', cadence: '1m', state: 'ok', observeOnly: true,
    source: { type: 'api', label: '交易所公开行情接口（只读）' }, runtime: 'python 3.11 · 0.25 CPU · 256 MB',
    network: ['stream.example-exchange.com'],
    params: [
      { key: 'pair', label: '交易对', kind: 'enum', value: 'BTC/USDT', options: ['BTC/USDT', 'ETH/USDT'], risk: 'medium', hint: '换交易对会重新订阅行情' },
      { key: 'window', label: '波动窗口', kind: 'enum', value: '15 分钟', options: ['5 分钟', '15 分钟', '60 分钟'], risk: 'low' },
      { key: 'vol', label: '波动阈值', kind: 'number', value: 0.9, min: 0.1, max: 3, step: 0.1, unit: '%', risk: 'low', hint: '窗口内振幅超过它就告警' },
    ],
    streams: { 中间价: 'price.mid', 价差: 'spread', 振幅: 'range' },
    panel: [
      { kind: 'line', title: '中间价', series: ['中间价'], fmt: 'px', span: 8 },
      { kind: 'depth', title: '盘口深度（快照）', span: 4 },
      { kind: 'stat', title: '最新价', stat: 'last', span: 4 },
      { kind: 'stat', title: '价差', stat: 'spread', span: 4 },
      { kind: 'stat', title: '窗口振幅', stat: 'range', span: 4 },
      { kind: 'line', title: '窗口振幅 %', series: ['振幅'], threshold: 'vol', fmt: 'pct', span: 12 },
    ],
    alerts: ['窗口振幅 > 波动阈值 → 收件箱（只告警，不下单）'],
    versions: [{ v: 'v2.0', at: '10-15', note: '数据接口换成 rl.emit，为高频后端预留' }, { v: 'v1.0', at: '10-02', note: '接入公开行情' }],
    note: '只看 · 不下单。第一版按分钟聚合；脚本只经 rl.emit 交数据，以后换高频后端不用改脚本。',
  },
  {
    id: 'LV-03', title: '舆情扩散模拟', kind: 'simulation', cadence: '按需', state: 'ok', observeOnly: true,
    source: { type: 'github', label: 'camel-ai/oasis · Apache-2.0' }, runtime: 'python 3.11 · 1 CPU · 1 GB · 每次运行',
    network: ['（模拟不联网）'],
    params: [
      { key: 'agents', label: '智能体数量', kind: 'number', value: 10000, min: 1000, max: 100000, step: 1000, risk: 'medium', hint: '越多越准，费用随之增加' },
      { key: 'seed', label: '初始传播比例', kind: 'number', value: 2, min: 0.5, max: 10, step: 0.5, unit: '%', risk: 'low' },
      { key: 'plan', label: '干预方案', kind: 'enum', value: '辟谣', options: ['不干预', '辟谣', '限流', '辟谣 + 限流'], risk: 'low' },
    ],
    streams: { 覆盖率: 'reach' },
    panel: [
      { kind: 'sim', title: '覆盖率随时间 · 三种方案对照', span: 8, rows: 2 },
      { kind: 'stat', title: '峰值覆盖', stat: 'peak', span: 4 },
      { kind: 'stat', title: '九成覆盖用时', stat: 'tpeak', span: 4 },
      { kind: 'table', title: '方案对照', cols: [['name', '方案'], ['peak', '峰值覆盖'], ['tpeak', '九成用时'], ['final', '最终覆盖']], span: 12 },
    ],
    alerts: [],
    versions: [{ v: 'v1.0', at: '10-17', note: '从 GitHub 接入 OASIS，适配成模拟' }],
    note: '每次模拟都是一次可回放的运行；参数扫描结果并排比较。',
  },
  {
    id: 'LV-04', title: 'arXiv 新论文雷达', kind: 'live', cadence: '5m', state: 'ok', observeOnly: true,
    source: { type: 'research', label: '研究台 R—014 的检索式' }, runtime: 'python 3.11 · 0.1 CPU · 128 MB',
    network: ['export.arxiv.org'],
    params: [
      { key: 'cats', label: '分类', kind: 'multi', value: ['cs.LG', 'cs.CL', 'cs.AI'], options: ['cs.LG', 'cs.CL', 'cs.AI', 'cs.CV', 'q-bio.NC'], risk: 'low' },
      { key: 'min', label: '相关度下限', kind: 'number', value: 0.7, min: 0.3, max: 0.95, step: 0.05, risk: 'low' },
    ],
    streams: { 新论文: 'papers.count' },
    panel: [
      { kind: 'line', title: '每 5 分钟新增', series: ['新论文'], fmt: 'num', span: 6 },
      { kind: 'bars', title: '今日按分类', span: 6 },
      { kind: 'table', title: '命中检索式的新论文', cols: [['t', '时间'], ['cat', '分类'], ['title', '标题'], ['score', '相关度']], span: 12 },
    ],
    alerts: ['相关度 ≥ 0.9 的新论文 → 写入研究档案前先问你'],
    versions: [{ v: 'v1.1', at: '10-16', note: '加 cs.AI' }, { v: 'v1.0', at: '10-11', note: '研究台委托：把检索式变成常驻雷达' }],
  },
];

/* ———— 数据流生成 ———— */
const MENTIONS: [string, string, number][] = [
  ['论坛', '冬季续航实测：掉电比宣传快不少', -0.62], ['新闻', '多地充电桩建设提速，排队时间下降', 0.48], ['RSS', '某品牌智驾版本推送，新增城区领航', 0.35],
  ['论坛', '车机卡顿问题仍未修复，车主不满', -0.55], ['新闻', '新能源车下乡补贴细则公布', 0.41], ['论坛', '二手新能源保值率讨论', -0.18],
  ['RSS', '电池回收新规征求意见', 0.12], ['新闻', '智驾事故调查进展', -0.47], ['短视频', '露营场景实拍：外放电很好用', 0.52], ['论坛', '保险费上涨引发吐槽', -0.38],
];
const PAPERS: [string, string, number][] = [
  ['cs.LG', 'Scaling Laws for Sparse Mixture Routing', 0.91], ['cs.CL', 'Long-Context Retrieval without Re-ranking', 0.83], ['cs.AI', 'Agents that Ask: Clarification in Tool Use', 0.88],
  ['cs.LG', 'A Note on Grokking in Modular Arithmetic', 0.74], ['cs.CV', 'Video Tokenizers at 4K', 0.71], ['cs.CL', 'Citations that Check Themselves', 0.93],
  ['q-bio.NC', 'Place Cells as Successor Features', 0.77], ['cs.AI', 'Budgeted Multi-Agent Debate', 0.86],
];
const SRC_BASE: Record<string, number> = { 新闻: 0.12, 论坛: -0.12, RSS: 0.05, 短视频: 0.2 };

function simCurve(agents: number, seed: number, plan: string, steps = 48) {
  // 简化的 SIR 式扩散：辟谣降低传播率，限流降低接触率
  const beta = 0.42 * (plan.includes('限流') ? 0.62 : 1), gamma = 0.08 + (plan.includes('辟谣') ? 0.09 : 0);
  let s = 1 - seed / 100, i = seed / 100, r = 0; const pts: number[] = [];
  const k = 1 + Math.log10(agents / 1000) * 0.04;
  for (let t = 0; t < steps; t++) { const ni = beta * k * s * i, nr = gamma * i; s -= ni; i += ni - nr; r += nr; pts.push(clamp((i + r) * 100, 0, 100)); }
  return pts;
}
// 「九成用时」：覆盖率第一次达到最终值 90% 的小时数，比「斜率最大」更好读
const peakOf = (pts: number[]) => { const final = pts.at(-1)!; return { tpeak: Math.max(1, pts.findIndex(v => v >= final * 0.9)), final }; };

export function initData(u: Unit, seed = 7): LiveData {
  const d: LiveData = { minute: NOW0 - WINDOW, series: {}, stats: {}, rows: [], alert: null };
  if (u.kind === 'simulation') return step(u, d, rng(seed), true);
  let r = rng(seed + u.id.charCodeAt(4));
  for (let k = 0; k < WINDOW; k++) { const n = step(u, d, r, false); Object.assign(d, n); r = rng(seed * 31 + k + u.id.charCodeAt(4)); }
  return d;
}

/** 推进一拍（一分钟）。返回新对象，不改原数据。 */
export function step(u: Unit, prev: LiveData, r: () => number, simReset = false): LiveData {
  const d: LiveData = { ...prev, minute: prev.minute + 1, series: { ...prev.series }, stats: { ...prev.stats }, rows: prev.rows, alert: null };
  const push = (k: string, v: number) => { d.series[k] = [...(d.series[k] ?? []), v].slice(-WINDOW); };
  const t = hm(d.minute);
  if (u.id === 'LV-01') {
    const srcs = pv(u, 'sources') as string[]; const th = pv(u, 'threshold') as number;
    // 09:20 前后论坛有一波负面讨论，用来演示告警
    const dip = u.id === 'LV-01' ? Math.exp(-(((d.minute - (NOW0 + 14)) / 22) ** 2)) * -0.55 : 0;
    for (const s of ['新闻', '论坛', 'RSS', '短视频']) {
      if (!srcs.includes(s)) { delete d.series[s]; continue; }
      const last = d.series[s]?.at(-1) ?? SRC_BASE[s];
      const target = SRC_BASE[s] + (s === '论坛' ? dip : 0);
      push(s, clamp(last + (target - last) * 0.25 + (r() - 0.5) * 0.12, -1, 1));
    }
    push('声量', Math.round(18 + r() * 14 + (dip < -0.2 ? 30 : 0)));
    const vol = (d.series['声量'] ?? []).slice(-60).reduce((a, b) => a + b, 0);
    const low = srcs.map(s => [s, d.series[s]?.at(-1) ?? 0] as const).sort((a, b) => a[1] - b[1])[0];
    const breach = srcs.find(s => (d.series[s] ?? []).slice(-15).length >= 15 && d.series[s].slice(-15).every(v => v < th));
    d.stats.volume = { v: vol.toLocaleString('zh-CN'), sub: '条提及' };
    d.stats.low = { v: low ? low[1].toFixed(2) : '—', sub: low ? low[0] : '', alert: !!breach };
    if (breach) d.alert = `${breach}情感分连续 15 分钟低于 ${th}`;
    if (r() < 0.35) { const m = MENTIONS[Math.floor(r() * MENTIONS.length)]; if (srcs.includes(m[0])) d.rows = [{ t, src: m[0], title: m[1], score: m[2] }, ...prev.rows].slice(0, 8); }
  } else if (u.id === 'LV-02') {
    const eth = pv(u, 'pair') === 'ETH/USDT'; const base = eth ? 3420 : 68250;
    const last = d.series['中间价']?.at(-1) ?? base;
    const shock = Math.exp(-(((d.minute - (NOW0 + 3)) / 4) ** 2)) * (eth ? 38 : 520);
    const mid = Math.max(1, last + (base - last) * 0.04 + (r() - 0.5) * base * 0.0016 + shock * (r() - 0.35));
    push('中间价', +mid.toFixed(eth ? 2 : 1));
    const w = ({ '5 分钟': 5, '15 分钟': 15, '60 分钟': 60 } as Record<string, number>)[pv(u, 'window') as string] ?? 15;
    const win = d.series['中间价'].slice(-w); const range = (Math.max(...win) - Math.min(...win)) / mid * 100;
    push('振幅', +range.toFixed(3));
    const spread = +(base * (0.00002 + r() * 0.00004)).toFixed(eth ? 2 : 1);
    const th = pv(u, 'vol') as number;
    d.stats.last = { v: mid.toLocaleString('en-US', { maximumFractionDigits: eth ? 2 : 1 }), sub: pv(u, 'pair') as string };
    d.stats.spread = { v: String(spread), sub: 'USDT' };
    d.stats.range = { v: `${range.toFixed(2)}%`, sub: `${w} 分钟窗口`, alert: range > th };
    if (range > th) d.alert = `${w} 分钟振幅 ${range.toFixed(2)}% 超过 ${th}%`;
    const lv = (side: number) => Array.from({ length: 14 }, (_, i) => { const p = mid + side * (spread / 2 + i * base * 0.00012); return [+p.toFixed(1), +(0.4 + r() * 2.2 + i * 0.35).toFixed(2)] as [number, number]; });
    d.depth = { bids: lv(-1), asks: lv(1), mid };
  } else if (u.id === 'LV-03') {
    const agents = pv(u, 'agents') as number, seed = pv(u, 'seed') as number, plan = pv(u, 'plan') as string;
    const names = ['不干预', plan === '不干预' ? '辟谣' : plan, plan === '辟谣 + 限流' ? '限流' : '辟谣 + 限流'];
    const curves = [...new Set(names)].map(n => ({ name: n, pts: simCurve(agents, seed, n), now: n === plan }));
    const sim = simReset || !prev.sim ? { step: simReset ? 48 : 0, steps: 48, running: false, curves } : { ...prev.sim, curves, step: prev.sim.running ? Math.min(48, prev.sim.step + 6) : prev.sim.step };
    if (sim.running && sim.step >= 48) sim.running = false;
    d.sim = sim;
    const cur = curves.find(c => c.now)!; const pk = peakOf(cur.pts);
    d.stats.peak = { v: `${Math.max(...cur.pts.slice(0, sim.step || 1)).toFixed(1)}%`, sub: plan };
    d.stats.tpeak = { v: `第 ${pk.tpeak} 小时`, sub: `${agents.toLocaleString('zh-CN')} 个智能体` };
    d.rows = curves.map(c => { const p = peakOf(c.pts); return { name: c.name + (c.now ? '（当前）' : ''), peak: `${Math.max(...c.pts).toFixed(1)}%`, tpeak: `第 ${p.tpeak} 小时`, final: `${p.final.toFixed(1)}%` }; });
  } else if (u.id === 'LV-04') {
    const cats = pv(u, 'cats') as string[], min = pv(u, 'min') as number;
    const n = d.minute % 5 === 0 ? Math.round(r() * 6 * cats.length / 3) : 0;
    if (d.minute % 5 === 0) push('新论文', n);
    const prevBars = Object.fromEntries(prev.bars ?? []);
    d.bars = cats.map(c => [c, (prevBars[c] ?? Math.round(8 + r() * 20)) + (n && r() < 0.5 ? 1 : 0)]);
    if (n && r() < 0.6) { const p = PAPERS[Math.floor(r() * PAPERS.length)]; if (cats.includes(p[0]) && p[2] >= min) d.rows = [{ t, cat: p[0], title: p[1], score: p[2] }, ...prev.rows].slice(0, 8); }
  } else {
    // 接入流程生成的新单元（热榜追踪 / 一句话想法）：一条主曲线 + 两个统计 + 最新条目
    const last = d.series['主指标']?.at(-1) ?? 50;
    push('主指标', +clamp(last + (r() - 0.48) * 6, 0, 100).toFixed(1));
    d.stats.cur = { v: String(d.series['主指标'].at(-1)), sub: '当前' };
    d.stats.chg = { v: `${(d.series['主指标'].at(-1)! - (d.series['主指标'].at(-60) ?? d.series['主指标'][0])).toFixed(1)}`, sub: '近 1 小时变化' };
    if (r() < 0.3) d.rows = [{ t, item: (u.samples ?? ['新条目'])[Math.floor(r() * (u.samples?.length ?? 1))], v: d.series['主指标'].at(-1)! }, ...prev.rows].slice(0, 8);
  }
  return d;
}

/* ———— 接入：从 GitHub 项目 / 一句话想法生成四件套 ———— */
export type Onboard = {
  id: string; from: SourceType; input: string; stage: 0 | 1 | 2 | 3 | 4; // 0 侦查 1 适配 2 试跑 3 等批准 4 已上线 / 驳回
  scout: [string, string, 'ok' | 'warn'][]; yaml: string; unit: Unit; typed: number; trialTicks: number; result?: 'live' | 'rejected';
};

export function makeOnboard(text: string, n: number): Onboard {
  const gh = text.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
  const id = `LV-${String(4 + n).padStart(2, '0')}`;
  const from: SourceType = gh ? 'github' : /api|接口|数据源/i.test(text) ? 'api' : 'idea';
  const title = gh ? '热榜聚合追踪' : (text.replace(/^(帮我|请)?(盯一下|盯着|盯|监测|关注|看一下|每\s*\d+\s*分钟看一下)/, '').replace(/[。.！!]$/, '').trim().slice(0, 16) || '新的常驻自动化');
  const unit: Unit = {
    id, title, kind: 'live', cadence: gh ? '5m' : '1m', state: 'trial', observeOnly: true, template: 'generic',
    source: { type: from, label: gh ? `${gh[1]} · MIT` : `「${text.slice(0, 24)}」` },
    runtime: 'python 3.11 · 0.1 CPU · 128 MB', network: gh ? ['hot.example-news.cn', 'trend.example-forum.cn'] : ['api.example-data.com'],
    params: [
      { key: 'top', label: '只看前 N 条', kind: 'number', value: 20, min: 5, max: 50, step: 5, risk: 'low' },
      { key: 'threshold', label: '变化告警', kind: 'number', value: 15, min: 5, max: 50, step: 5, risk: 'low', hint: '一小时内主指标变化超过它就告警' },
    ],
    streams: { 主指标: 'main' }, samples: gh ? ['城市更新试点名单公布', '某手机新品首发评测', '高校招生政策调整', '暴雨预警升级'] : ['数据点更新', '新报价', '状态变化'],
    panel: [
      { kind: 'line', title: gh ? '热度指数' : '主指标', series: ['主指标'], fmt: 'num', span: 8, rows: 2 },
      { kind: 'stat', title: '当前', stat: 'cur', span: 4 }, { kind: 'stat', title: '近 1 小时', stat: 'chg', span: 4 },
      { kind: 'table', title: '最新条目', cols: [['t', '时间'], ['item', '条目'], ['v', '指数']], span: 12 },
    ],
    alerts: ['一小时内主指标变化超过「变化告警」→ 收件箱'], versions: [{ v: 'v1.0', at: '刚才', note: gh ? `从 ${gh[1]} 接入` : '一句话创建' }],
  };
  const scout: Onboard['scout'] = gh ? [
    ['许可证', 'MIT · 可以改写和内部使用', 'ok'], ['语言与依赖', 'Python 3.11 · httpx / selectolax / pydantic / apscheduler（4 个）', 'ok'],
    ['能不能跑', '有入口 main.py 和示例配置；测试 12 个，沙盒里 12 / 12 通过', 'ok'], ['要访问的网络', `${unit.network.join('、')}（只读抓取公开榜单）`, 'ok'],
    ['写操作', '没有。原项目会写本地 SQLite，适配时改为 rl.emit', 'ok'], ['注意', '只能抓公开页面，需遵守来源站点的使用条款；频率限制为 5 分钟一次', 'warn'],
  ] : [
    ['理解', `要持续观察：${title}`, 'ok'], ['数据来源', `找到 1 个公开接口（${unit.network[0]}），只读`, 'ok'],
    ['脚本', '从零写 1 个文件，约 60 行', 'ok'], ['写操作', '没有，只观察和告警', 'ok'], ['注意', '接口有频率限制，按 1 分钟一次', 'warn'],
  ];
  const yaml = [
    `id: ${id}`, `title: ${title}`, 'kind: live', `runtime: { lang: python, entry: main.py, cpu: 0.1, memory_mb: 128 }`, `cadence: ${unit.cadence}`,
    'network:', `  allow: [${unit.network.join(', ')}]`, 'params:', '  top: { type: integer, default: 20, risk: low }', '  threshold: { type: number, default: 15, risk: low }',
    'streams:', '  main: { time: ts, fields: { value: number, item: string } }', 'panel:',
    '  - { kind: line,  stream: main, x: ts, y: value, span: 8, rows: 2 }', '  - { kind: stat,  stream: main, field: value, span: 4 }', '  - { kind: table, stream: main, sort: -ts, limit: 20, span: 12 }',
    'alerts:', '  - { when: "abs(delta(main.value, 1h)) > params.threshold", notify: inbox }', 'maintainer: automation.maintainer', 'actions: none   # 只观察；对外动作一律走审批卡',
  ].join('\n');
  return { id, from, input: text, stage: 0, scout, yaml, unit, typed: 0, trialTicks: 0 };
}

/** 一份单元的 automation.yaml（展示用，按当前参数生成）。 */
export function yamlOf(u: Unit) {
  const val = (p: Param) => Array.isArray(p.value) ? `[${p.value.join(', ')}]` : p.value;
  return [
    `id: ${u.id}`, `title: ${u.title}`, `kind: ${u.kind}`, `runtime: "${u.runtime}"`, `cadence: ${u.cadence}`,
    'network:', `  allow: [${u.network.join(', ')}]`, 'params:', ...u.params.map(p => `  ${p.key}: { value: ${val(p)}, risk: ${p.risk} }   # ${p.label}`),
    'streams:', ...Object.entries(u.streams).map(([k, v]) => `  ${v}: { label: ${k} }`),
    'panel:', ...u.panel.map(w => `  - { kind: ${w.kind}, title: ${w.title}, span: ${w.span} }`),
    'alerts:', ...(u.alerts.length ? u.alerts.map(a => `  - "${a}"`) : ['  []']), 'maintainer: automation.maintainer', 'actions: none   # 只观察；对外动作一律走审批卡',
  ].join('\n');
}
