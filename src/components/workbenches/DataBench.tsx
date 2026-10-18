import { useMemo, useState } from 'react';
import Chat, { msgId, now, type Msg } from './Chat';
import type { BenchProps } from './WorkbenchStudio';
import './bench-data.css';

/* ── Datasets (generated locally; numbers are examples, not observations) ── */
type FType = 'quant' | 'nominal' | 'temporal';
type Row = Record<string, string | number>;
interface Dataset { name: string; source: string; fields: [string, FType, string][]; rows: Row[]; asks: Ask[] }
type Agg = 'mean' | 'sum' | 'count' | 'none';
type Mark = 'bar' | 'point' | 'line';
interface Enc { mark: Mark; x: string; y: string; agg: Agg; color: string }
interface Ask { q: string; enc: Enc; filter?: [string, string]; keys: string[] }
interface Step { id: string; q: string; enc: Enc; filter?: [string, string]; parent: string | null }

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const day = (d: number, base = '2026-09-01') => { const t = new Date(base + 'T00:00:00'); t.setDate(t.getDate() + d); return t.toISOString().slice(0, 10); };
function makeData(): Dataset[] {
  const r = rng(41);
  const runs: Row[] = Array.from({ length: 72 }, (_, i) => {
    const arch = 'ABC'[i % 3], optimizer = ['AdamW', 'SGD', 'Lion'][Math.floor(i / 3) % 3], schedule = ['cosine', 'wsd', 'const'][Math.floor(i / 9) % 3];
    const lr = [1e-4, 3e-4, 6e-4, 1e-3][Math.floor(r() * 4)];
    const base = { A: .998, B: .991, C: 1.004 }[arch]! + { AdamW: 0, SGD: .021, Lion: .006 }[optimizer]! + { cosine: 0, wsd: -.006, const: .011 }[schedule]! + Math.abs(Math.log10(lr) + 3.5) * .01;
    return { exp: `EXP-${String(i + 1).padStart(3, '0')}`, date: day(Math.floor(i / 3)), arch, optimizer, schedule, lr, val_bpb: +(base + (r() - .5) * .008).toFixed(4), gpu_hours: +(.08 + r() * .03).toFixed(3) };
  });
  const benches = ['CURR', 'RSCH', 'ENGR', 'CRTV', 'AUTO', 'EXPL'];
  const usage: Row[] = []; for (let d = 0; d < 21; d++) benches.forEach((b, k) => usage.push({ date: day(d, '2026-09-15'), bench: b, minutes: Math.round([55, 70, 95, 40, 12, 25][k] * (.5 + r()) * (d % 7 > 4 ? .5 : 1)), sessions: 1 + Math.floor(r() * 4), weekday: ['一', '二', '三', '四', '五', '六', '日'][(d + 1) % 7] }));
  const weather: Row[] = Array.from({ length: 45 }, (_, d) => { const hi = +(26 - d * .28 + (r() - .5) * 4).toFixed(1); return { date: day(d, '2026-10-01'), temp_hi: hi, temp_lo: +(hi - 8 - r() * 3).toFixed(1), rain_mm: r() < .28 ? +(r() * 22).toFixed(1) : 0, sunshine_h: +(Math.max(0, 9 - d * .05 - r() * 6)).toFixed(1), week: `W${Math.floor(d / 7) + 1}` }; });
  const courses = ['群论', '线性代数', '振动与波', 'CSAPP']; const progress: Row[] = [];
  courses.forEach((c, k) => { for (let u = 1; u <= 6; u++) progress.push({ course: c, unit: `U${u}`, minutes: Math.round(30 + r() * 60 + k * 6), quiz: Math.round(55 + r() * 40 + u * 1.5 - k * 3), week: `W${Math.ceil(u / 2)}` }); });
  return [
    { name: 'runs', source: 'reinlab_dev · PostgreSQL', fields: [['exp', 'nominal', '实验编号'], ['date', 'temporal', '日期'], ['arch', 'nominal', '结构'], ['optimizer', 'nominal', '优化器'], ['schedule', 'nominal', '调度'], ['lr', 'quant', '学习率'], ['val_bpb', 'quant', '验证 bpb'], ['gpu_hours', 'quant', 'GPU 时']], rows: runs,
      asks: [{ q: '各优化器的平均 val_bpb', enc: { mark: 'bar', x: 'optimizer', y: 'val_bpb', agg: 'mean', color: '' }, keys: ['优化器', 'optimizer', '平均'] }, { q: '按结构拆开看优化器', enc: { mark: 'bar', x: 'optimizer', y: 'val_bpb', agg: 'mean', color: 'arch' }, keys: ['结构', 'arch', '拆'] }, { q: '学习率和损失的关系', enc: { mark: 'point', x: 'lr', y: 'val_bpb', agg: 'none', color: 'optimizer' }, keys: ['学习率', 'lr', '关系'] }, { q: '只看结构 B 的调度对比', enc: { mark: 'bar', x: 'schedule', y: 'val_bpb', agg: 'mean', color: '' }, filter: ['arch', 'B'], keys: ['结构 b', '调度', 'schedule'] }, { q: '每天的 GPU 用量', enc: { mark: 'line', x: 'date', y: 'gpu_hours', agg: 'sum', color: '' }, keys: ['gpu', '用量', '每天'] }] },
    { name: 'workbench_sessions', source: 'reinlab_dev · PostgreSQL', fields: [['date', 'temporal', '日期'], ['bench', 'nominal', '工作台'], ['minutes', 'quant', '使用分钟'], ['sessions', 'quant', '会话数'], ['weekday', 'nominal', '星期']], rows: usage,
      asks: [{ q: '每个工作台的总使用时长', enc: { mark: 'bar', x: 'bench', y: 'minutes', agg: 'sum', color: '' }, keys: ['总', '工作台', '时长'] }, { q: '每天使用时长趋势', enc: { mark: 'line', x: 'date', y: 'minutes', agg: 'sum', color: '' }, keys: ['趋势', '每天'] }, { q: '星期几最常用', enc: { mark: 'bar', x: 'weekday', y: 'minutes', agg: 'mean', color: '' }, keys: ['星期', 'weekday'] }] },
    { name: 'kyoto_autumn.csv', source: '本地文件 · CSV（示例数据，非真实观测）', fields: [['date', 'temporal', '日期'], ['temp_hi', 'quant', '最高温'], ['temp_lo', 'quant', '最低温'], ['rain_mm', 'quant', '降水'], ['sunshine_h', 'quant', '日照'], ['week', 'nominal', '周']], rows: weather,
      asks: [{ q: '最高温的变化', enc: { mark: 'line', x: 'date', y: 'temp_hi', agg: 'none', color: '' }, keys: ['温', '变化'] }, { q: '每周降水总量', enc: { mark: 'bar', x: 'week', y: 'rain_mm', agg: 'sum', color: '' }, keys: ['降水', '雨'] }, { q: '日照与最高温', enc: { mark: 'point', x: 'sunshine_h', y: 'temp_hi', agg: 'none', color: 'week' }, keys: ['日照'] }] },
    { name: 'course_progress', source: 'course-cache · SQLite', fields: [['course', 'nominal', '课程'], ['unit', 'nominal', '单元'], ['minutes', 'quant', '学习分钟'], ['quiz', 'quant', '测验分'], ['week', 'nominal', '周']], rows: progress,
      asks: [{ q: '各课程平均测验分', enc: { mark: 'bar', x: 'course', y: 'quiz', agg: 'mean', color: '' }, keys: ['测验', '平均', '课程'] }, { q: '学习时长与测验分', enc: { mark: 'point', x: 'minutes', y: 'quiz', agg: 'none', color: 'course' }, keys: ['时长', '关系'] }, { q: '各单元的分数走势', enc: { mark: 'line', x: 'unit', y: 'quiz', agg: 'mean', color: 'course' }, keys: ['单元', '走势'] }] },
  ];
}
const PALETTE = ['#1d211a', '#a68b58', '#6f8f72', '#8a4b2c', '#9aa38f', '#c9b48a'];
const AGG_ZH: Record<Agg, string> = { mean: '平均', sum: '合计', count: '计数', none: '原值' };

function derive(ds: Dataset, enc: Enc, filter?: [string, string]) {
  let rows = ds.rows; if (filter) rows = rows.filter(r => String(r[filter[0]]) === filter[1]);
  if (enc.agg === 'none') return rows.map(r => ({ x: r[enc.x], y: Number(r[enc.y]), c: enc.color ? String(r[enc.color]) : '' }));
  const groups = new Map<string, number[]>();
  rows.forEach(r => { const k = `${r[enc.x]}\u0000${enc.color ? r[enc.color] : ''}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(Number(r[enc.y])); });
  const out = [...groups].map(([k, v]) => { const [x, c] = k.split('\u0000'); const y = enc.agg === 'count' ? v.length : enc.agg === 'sum' ? v.reduce((a, b) => a + b, 0) : v.reduce((a, b) => a + b, 0) / v.length; return { x: isNaN(+x) || x === '' ? x : +x, y: +y.toFixed(4), c }; });
  return out.sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
}

function Chart({ data, enc, ds }: { data: { x: string | number; y: number; c: string }[]; enc: Enc; ds: Dataset }) {
  const W = 720, H = 360, P = { l: 58, r: 120, t: 18, b: 44 };
  const xType = ds.fields.find(f => f[0] === enc.x)?.[1];
  const cats = [...new Set(data.map(d => String(d.x)))];
  const colors = [...new Set(data.map(d => d.c))].filter(Boolean);
  const ys = data.map(d => d.y); const yMin = enc.mark === 'bar' ? Math.min(0, ...ys) : Math.min(...ys), yMax = Math.max(...ys);
  const pad = (yMax - yMin) * .08 || 1; const lo = enc.mark === 'bar' && yMin >= 0 ? 0 : yMin - pad, hi = yMax + pad;
  const quantX = xType === 'quant' && enc.mark !== 'bar';
  const xs = data.map(d => Number(d.x)); const xLo = Math.min(...xs), xHi = Math.max(...xs);
  const logX = quantX && xLo > 0 && xHi / xLo > 50;
  const sx = (v: string | number) => quantX ? P.l + ((logX ? Math.log10(+v) - Math.log10(xLo) : +v - xLo) / ((logX ? Math.log10(xHi) - Math.log10(xLo) : xHi - xLo) || 1)) * (W - P.l - P.r) : P.l + (cats.indexOf(String(v)) + .5) / cats.length * (W - P.l - P.r);
  const sy = (v: number) => P.t + (hi - v) / (hi - lo) * (H - P.t - P.b);
  const col = (c: string) => c ? PALETTE[colors.indexOf(c) % PALETTE.length] : PALETTE[0];
  const band = (W - P.l - P.r) / Math.max(1, cats.length);
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + (hi - lo) * i / 4);
  const labelEvery = Math.ceil(cats.length / 10);
  return <svg className="da-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${AGG_ZH[enc.agg]} ${enc.y} 按 ${enc.x}`}>
    {yTicks.map(t => <g key={t}><line x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} className="g" /><text x={P.l - 8} y={sy(t) + 3} textAnchor="end">{Math.abs(t) < 10 ? t.toFixed(3) : Math.round(t)}</text></g>)}
    <line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} className="axis" />
    {quantX ? [0, .25, .5, .75, 1].map(f => { const v = logX ? 10 ** (Math.log10(xLo) + f * (Math.log10(xHi) - Math.log10(xLo))) : xLo + f * (xHi - xLo); return <text key={f} x={sx(v)} y={H - P.b + 16} textAnchor="middle">{v < .01 ? v.toExponential(0) : +v.toFixed(2)}</text>; })
      : cats.map((c, i) => i % labelEvery === 0 && <text key={c} x={sx(c)} y={H - P.b + 16} textAnchor="middle">{c.length > 8 ? c.slice(5) : c}</text>)}
    <text x={(P.l + W - P.r) / 2} y={H - 6} textAnchor="middle" className="t">{ds.fields.find(f => f[0] === enc.x)?.[2]} · {enc.x}{logX ? '（对数）' : ''}</text>
    <text x={14} y={P.t + (H - P.t - P.b) / 2} textAnchor="middle" className="t" transform={`rotate(-90 14 ${P.t + (H - P.t - P.b) / 2})`}>{AGG_ZH[enc.agg]} {enc.y}</text>
    {enc.mark === 'bar' && data.map((d, i) => { const k = colors.length ? colors.indexOf(d.c) : 0, n = Math.max(1, colors.length), w = band * .7 / n; const x = sx(d.x) - band * .35 + k * w; return <rect key={i} x={x} width={Math.max(1, w - 2)} y={Math.min(sy(d.y), sy(Math.max(0, lo)))} height={Math.abs(sy(Math.max(0, lo)) - sy(d.y))} fill={col(d.c)}><title>{`${d.x}${d.c ? ' · ' + d.c : ''}: ${d.y}`}</title></rect>; })}
    {enc.mark === 'point' && data.map((d, i) => <circle key={i} cx={sx(d.x)} cy={sy(d.y)} r="4" fill={col(d.c)} fillOpacity=".75" stroke="#f7f5ee" strokeWidth=".8"><title>{`${d.x}, ${d.y}${d.c ? ' · ' + d.c : ''}`}</title></circle>)}
    {enc.mark === 'line' && (colors.length ? colors : ['']).map(c => { const pts = data.filter(d => d.c === c); return <g key={c}><path d={pts.map((d, i) => `${i ? 'L' : 'M'}${sx(d.x)} ${sy(d.y)}`).join(' ')} fill="none" stroke={col(c)} strokeWidth="1.8" />{pts.map((d, i) => <circle key={i} cx={sx(d.x)} cy={sy(d.y)} r="2.4" fill={col(c)}><title>{`${d.x}: ${d.y}`}</title></circle>)}</g>; })}
    {colors.length > 0 && <g transform={`translate(${W - P.r + 18} ${P.t + 6})`}><text className="t" y="0">{enc.color}</text>{colors.map((c, i) => <g key={c} transform={`translate(0 ${16 + i * 16})`}><rect width="10" height="10" y="-9" fill={col(c)} /><text x="16">{c}</text></g>)}</g>}
  </svg>;
}

function sql(ds: Dataset, enc: Enc, filter?: [string, string]) {
  const where = filter ? `\nWHERE ${filter[0]} = '${filter[1]}'` : '';
  if (enc.agg === 'none') return `SELECT ${enc.x}, ${enc.y}${enc.color ? ', ' + enc.color : ''}\nFROM ${ds.name}${where};`;
  const g = [enc.x, enc.color].filter(Boolean).join(', ');
  return `SELECT ${g}, ${enc.agg === 'count' ? 'COUNT(*)' : `${enc.agg.toUpperCase() === 'MEAN' ? 'AVG' : 'SUM'}(${enc.y})`} AS ${enc.agg}_${enc.y}\nFROM ${ds.name}${where}\nGROUP BY ${g}\nORDER BY ${enc.x};`;
}
function pandas(ds: Dataset, enc: Enc, filter?: [string, string]) {
  const f = filter ? `\ndf = df[df["${filter[0]}"] == "${filter[1]}"]` : '';
  const g = [enc.x, enc.color].filter(Boolean).map(v => `"${v}"`).join(', ');
  return `import pandas as pd\ndf = pd.read_sql("${ds.name}", conn)${f}\n` + (enc.agg === 'none' ? `out = df[["${enc.x}", "${enc.y}"${enc.color ? `, "${enc.color}"` : ''}]]` : `out = (df.groupby([${g}])["${enc.y}"]\n         .${enc.agg === 'count' ? 'count' : enc.agg}()\n         .reset_index())`);
}

export default function DataBench({ file, reduced }: BenchProps) {
  const all = useMemo(makeData, []);
  const ds = all[file];
  const first: Step = { id: 'T1', q: ds.asks[0].q, enc: ds.asks[0].enc, filter: ds.asks[0].filter, parent: null };
  const [steps, setSteps] = useState<Step[]>([first]);
  const [cur, setCur] = useState('T1');
  const [view, setView] = useState<'table' | 'sql' | 'py' | 'raw'>('table');
  const [busy, setBusy] = useState(false);
  const step = steps.find(s => s.id === cur)!;
  const data = useMemo(() => derive(ds, step.enc, step.filter), [ds, step]);
  const [messages, setMessages] = useState<Msg[]>(() => [
    { id: msgId(), who: 'ai', at: '10:20', tools: [{ kind: 'query', label: `DESCRIBE ${ds.name}`, detail: `${ds.rows.length} 行 · ${ds.fields.length} 列` }], text: <p>已连接 <b>{ds.name}</b>（{ds.source}）。我先按“{ds.asks[0].q}”画了第一张图。你可以直接问，也可以在中间改编码；每一步都会留在左侧的数据线程里，可以从任意一步分出新的方向。</p> },
  ]);

  function setEnc(patch: Partial<Enc>) { setSteps(list => list.map(s => s.id === cur ? { ...s, enc: { ...s.enc, ...patch } } : s)); }
  function summary(ask: { enc: Enc; filter?: [string, string] }) {
    const d = derive(ds, ask.enc, ask.filter);
    if (ask.enc.agg === 'none') { const n = d.length; const xs = d.map(p => +p.x), ys = d.map(p => p.y); const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0), vx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), vy = ys.reduce((a, y) => a + (y - my) ** 2, 0); const rho = cov / Math.sqrt(vx * vy || 1); return `共 ${n} 个点，${ask.enc.x} 与 ${ask.enc.y} 的相关系数约为 ${isNaN(rho) ? '—' : rho.toFixed(2)}。`; }
    const sorted = [...d].sort((a, b) => b.y - a.y); const top = sorted[0], low = sorted[sorted.length - 1];
    return `最高是 ${top.x}${top.c ? '·' + top.c : ''}（${top.y}），最低是 ${low.x}${low.c ? '·' + low.c : ''}（${low.y}），共 ${d.length} 组。`;
  }
  function ask(text: string) {
    setMessages(m => [...m, { id: msgId(), who: 'me', text }]);
    const lower = text.toLowerCase();
    const hit = ds.asks.find(a => a.q === text) ?? ds.asks.find(a => a.keys.some(k => lower.includes(k.toLowerCase())));
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      if (!hit) { setMessages(m => [...m, { id: msgId(), who: 'ai', at: now(), text: <p>本地预演只认得几类问题（见下方建议），没法理解这句话。接入 DataAgent 后可以自由提问；现在你也可以直接在中间的编码栏里改 X、Y 和颜色。</p> }]); return; }
      const id = `T${steps.length + 1}`;
      setSteps(list => [...list, { id, q: hit.q, enc: hit.enc, filter: hit.filter, parent: cur }]); setCur(id);
      setMessages(m => [...m, { id: msgId(), who: 'ai', at: now(), tools: [{ kind: 'query', label: sql(ds, hit.enc, hit.filter).split('\n')[0] + ' …', detail: '本地计算' }], text: <p>{hit.q}：{summary(hit)}<br /><span className="da-muted">从 {cur} 分出 {id}。数字由页面里的示例数据实时算出。</span></p> }]);
    }, reduced ? 0 : 650);
  }
  // Thread layout: depth = distance from root along parents.
  const depth = (s: Step): number => s.parent ? depth(steps.find(p => p.id === s.parent)!) + 1 : 0;
  const order = (() => { const out: Step[] = []; const walk = (pid: string | null) => steps.filter(s => s.parent === pid).forEach(s => { out.push(s); walk(s.id); }); walk(null); return out; })();
  const fieldOf = (f: string) => ds.fields.find(x => x[0] === f);
  const quantFields = ds.fields.filter(f => f[1] === 'quant');

  return <div className="da">
    <aside className="p da-src">
      <header className="p-h"><b>数据源</b><span>SOURCES</span></header>
      <div className="p-body scroll-thin">
        {[['reinlab_dev', 'PostgreSQL', 'localhost:5432', [all[0], all[1]]], ['course-cache', 'SQLite', '.cache/courses.db', [all[3]]], ['本地文件', 'CSV · DuckDB', '~/Data', [all[2]]]].map(([name, kind, where, list]) => <div key={name as string} className="da-conn"><span className="da-conn-h"><i className="dot ok" /><b>{name as string}</b><small>{kind as string}</small></span><small className="mono">{where as string}</small>
          {(list as Dataset[]).map(t => <div key={t.name} className="da-table" data-on={t === ds || undefined}><span className="mono">▦ {t.name}<small>{t.rows.length}</small></span>
            {t === ds && <ul>{t.fields.map(([f, ty, zh]) => <li key={f}><i data-t={ty}>{ty === 'quant' ? '#' : ty === 'temporal' ? '◷' : 'Aa'}</i><span className="mono">{f}</span><small>{zh}</small>
              <span className="da-assign"><button onClick={() => setEnc({ x: f })} title="设为 X">X</button>{ty === 'quant' && <button onClick={() => setEnc({ y: f })} title="设为 Y">Y</button>}{ty !== 'quant' && <button onClick={() => setEnc({ color: f })} title="设为颜色">色</button>}</span></li>)}</ul>}
          </div>)}</div>)}
        <p className="da-note">{ds.source.includes('示例') ? '天气表为生成的示例数据，不是真实观测。' : '表格内容为示例数据。'}</p>
      </div>
    </aside>

    <aside className="p da-thread">
      <header className="p-h"><b>数据线程</b><span>{steps.length} 步</span></header>
      <ol className="p-body scroll-thin">{order.map(s => <li key={s.id} style={{ marginLeft: Math.min(4, depth(s)) * 10 }} data-branch={s.parent && steps.filter(x => x.parent === s.parent).length > 1 || undefined}>
        <button aria-current={s.id === cur || undefined} onClick={() => setCur(s.id)}><span className="mono">{s.id}{s.parent && ` ← ${s.parent}`}</span><b>{s.q}</b><small>{({ bar: '柱', point: '散点', line: '折线' })[s.enc.mark]} · {AGG_ZH[s.enc.agg]} {s.enc.y}{s.filter && ` · ${s.filter[0]}=${s.filter[1]}`}</small></button>
      </li>)}</ol>
      <p className="da-thread-tip">在任意一步上继续提问，就会从那一步分出新的分支。</p>
    </aside>

    <section className="p da-main">
      <div className="da-shelf">
        <label>图形<span className="seg">{([['bar', '柱'], ['point', '散点'], ['line', '折线']] as const).map(([m, n]) => <button key={m} aria-pressed={step.enc.mark === m} onClick={() => setEnc({ mark: m, agg: m === 'point' ? 'none' : step.enc.agg === 'none' ? 'mean' : step.enc.agg })}>{n}</button>)}</span></label>
        <label>X<select value={step.enc.x} onChange={e => setEnc({ x: e.target.value })}>{ds.fields.map(([f, , zh]) => <option key={f} value={f}>{f} · {zh}</option>)}</select></label>
        <label>Y<select value={step.enc.y} onChange={e => setEnc({ y: e.target.value })}>{quantFields.map(([f, , zh]) => <option key={f} value={f}>{f} · {zh}</option>)}</select></label>
        <label>聚合<select value={step.enc.agg} onChange={e => setEnc({ agg: e.target.value as Agg })}>{(['mean', 'sum', 'count', 'none'] as Agg[]).map(a => <option key={a} value={a}>{AGG_ZH[a]}</option>)}</select></label>
        <label>颜色<select value={step.enc.color} onChange={e => setEnc({ color: e.target.value })}><option value="">无</option>{ds.fields.filter(f => f[1] !== 'quant' && f[0] !== step.enc.x).map(([f, , zh]) => <option key={f} value={f}>{f} · {zh}</option>)}</select></label>
        {step.filter && <span className="chip gold">筛选 {step.filter[0]} = {step.filter[1]}</span>}
      </div>
      <div className="da-chart-wrap"><div className="da-chart-title"><em className="mono">{step.id}</em><b>{step.q}</b><small>{fieldOf(step.enc.y)?.[2]} · {data.length} {step.enc.agg === 'none' ? '个点' : '组'}</small></div><Chart data={data} enc={step.enc} ds={ds} /></div>
      <div className="da-bottom">
        <div className="tabs" role="tablist">{([['table', '结果表'], ['raw', '原始表'], ['sql', 'SQL'], ['py', 'Python']] as const).map(([k, n]) => <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>{n}</button>)}<span className="da-tabs-note">代码由当前编码生成</span></div>
        <div className="da-bottom-body scroll-thin">
          {view === 'table' && <table><thead><tr><th>{step.enc.x}</th>{step.enc.color && <th>{step.enc.color}</th>}<th>{AGG_ZH[step.enc.agg]} {step.enc.y}</th></tr></thead><tbody>{data.slice(0, 60).map((d, i) => <tr key={i}><td>{String(d.x)}</td>{step.enc.color && <td>{d.c}</td>}<td className="num">{d.y}</td></tr>)}</tbody></table>}
          {view === 'raw' && <table><thead><tr>{ds.fields.map(f => <th key={f[0]}>{f[0]}</th>)}</tr></thead><tbody>{ds.rows.slice(0, 40).map((r, i) => <tr key={i}>{ds.fields.map(f => <td key={f[0]} className={f[1] === 'quant' ? 'num' : ''}>{String(r[f[0]])}</td>)}</tr>)}</tbody></table>}
          {view === 'sql' && <pre className="mono">{sql(ds, step.enc, step.filter)}</pre>}
          {view === 'py' && <pre className="mono">{pandas(ds, step.enc, step.filter)}</pre>}
        </div>
      </div>
    </section>

    <Chat className="da-chat" title="DataAgent" agent="DATA AGENT" messages={messages} onSend={ask} busy={busy} suggestions={ds.asks.slice(1).map(a => a.q)} placeholder={`问 ${ds.name} 一个问题`} note="本地预演 · 计算是真的，理解问题靠预设规则" />
  </div>;
}
