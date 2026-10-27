import { useEffect, useMemo, useRef, useState } from 'react';

// 精读 · 可交互的解释动画（Canvas 2D / SVG，不用 WebGL）。所有数值都在本地真实计算。

const TOKENS = ['我', '想', '读', '这', '篇', '论文'];
function gauss(seed: number) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 1) / 4294967297; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}
const MAXD = 512;
const VECS = (() => { const g = gauss(42); return TOKENS.map(() => Array.from({ length: MAXD }, g)); })();
const QS = (() => { const g = gauss(7); return TOKENS.map(() => Array.from({ length: MAXD }, g)); })();
const softmax = (xs: number[]) => { const m = Math.max(...xs), e = xs.map(x => Math.exp(x - m)), s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); };
const dot = (a: number[], b: number[], d: number) => { let s = 0; for (let i = 0; i < d; i++) s += a[i] * b[i]; return s; };

/** ① 为什么要除以 √d：拖维度，看 softmax 如何饱和、梯度如何消失。 */
export function ScaledAttention() {
  const [d, setD] = useState(64);
  const [scale, setScale] = useState(true);
  const [q, setQ] = useState(5);
  const raw = TOKENS.map((_, j) => dot(QS[q], VECS[j], d));
  const scores = raw.map(x => scale ? x / Math.sqrt(d) : x);
  const p = softmax(scores);
  const maxP = Math.max(...p), grad = p.reduce((s, x) => s + x * (1 - x), 0);
  const curve = useMemo(() => [4, 8, 16, 32, 64, 128, 256, 512].map(dd => {
    const avg = (sc: boolean) => TOKENS.reduce((acc, _, qi) => acc + Math.max(...softmax(TOKENS.map((__, j) => dot(QS[qi], VECS[j], dd) / (sc ? Math.sqrt(dd) : 1)))), 0) / TOKENS.length;
    return { dd, on: avg(true), off: avg(false) };
  }), []);
  const x = (dd: number) => (Math.log2(dd) - 2) / 7 * 100, y = (v: number) => 100 - v * 100;
  return <div className="an an-scaled">
    <div className="an-controls">
      <label className="an-slider"><span>维度 d<b>{d}</b></span><input type="range" min={2} max={9} step={1} value={Math.log2(d)} onChange={e => setD(2 ** Number(e.target.value))} /><small>4 · 8 · 16 · 32 · 64 · 128 · 256 · 512</small></label>
      <div className="an-toggle" role="group" aria-label="缩放"><button aria-pressed={scale} onClick={() => setScale(true)}>÷ √d</button><button aria-pressed={!scale} onClick={() => setScale(false)}>不缩放</button></div>
      <div className="an-readout"><span><small>最大权重</small><b data-bad={maxP > .95 || undefined}>{maxP.toFixed(3)}</b></span><span><small>梯度大小 Σp(1−p)</small><b data-bad={grad < .1 || undefined}>{grad.toFixed(3)}</b></span><span><small>点积标准差</small><b>{Math.sqrt(raw.reduce((s, v) => s + v * v, 0) / raw.length).toFixed(1)}</b></span></div>
    </div>
    <div className="an-stage">
      <div className="an-tokens"><small>查询（点一个字）</small>{TOKENS.map((t, i) => <button key={t} aria-pressed={i === q} onClick={() => setQ(i)}>{t}</button>)}</div>
      <div className="an-bars">{TOKENS.map((t, j) => <div key={t} className="an-bar"><em>{t}</em><span><i style={{ transform: `scaleX(${p[j]})` }} data-top={p[j] === maxP || undefined} /></span><b>{p[j].toFixed(3)}</b><small>{scores[j].toFixed(1)}</small></div>)}</div>
      <figure className="an-curve">
        <figcaption>平均最大权重 vs 维度</figcaption>
        <svg viewBox="-8 -6 116 116" preserveAspectRatio="none">
          <line x1="0" y1="100" x2="100" y2="100" className="an-axis" /><line x1="0" y1="0" x2="0" y2="100" className="an-axis" />
          <polyline points={curve.map(c => `${x(c.dd)},${y(c.off)}`).join(' ')} className="an-off" vectorEffect="non-scaling-stroke" />
          <polyline points={curve.map(c => `${x(c.dd)},${y(c.on)}`).join(' ')} className="an-on" vectorEffect="non-scaling-stroke" />
          <line x1={x(d)} x2={x(d)} y1="0" y2="100" className="an-now" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="an-legend"><i className="is-off" />不缩放 <i className="is-on" />÷ √d</span>
      </figure>
    </div>
    <p className="an-say">{!scale && d >= 128 ? '■ 看到了吗：不缩放时维度一大，几乎所有权重都压到一个字上，Σp(1−p) 接近 0——梯度消失，模型学不动。' : scale ? '除以 √d 之后，无论维度多大，点积的尺度都保持在 1 左右，注意力分布始终「有得选」。切到「不缩放」再把维度拖大试试。' : '维度还小时差别不明显。把维度拖到 256 或 512。'}</p>
  </div>;
}

/** ② 位置编码：正弦波热力图；点一行，看它和其他位置的相似度。 */
export function PositionalEncoding() {
  const N = 64, D = 64;
  const [pos, setPos] = useState(20);
  const [dim, setDim] = useState(6);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pe = useMemo(() => Array.from({ length: N }, (_, p) => Array.from({ length: D }, (_, i) => { const k = Math.floor(i / 2), f = 1 / Math.pow(10000, (2 * k) / D); return i % 2 ? Math.cos(p * f) : Math.sin(p * f); })), []);
  useEffect(() => {
    const c = canvas.current; if (!c) return;
    const ctx = c.getContext('2d')!, w = c.width, h = c.height, cw = w / D, ch = h / N;
    for (let p = 0; p < N; p++) for (let i = 0; i < D; i++) {
      const v = (pe[p][i] + 1) / 2, g = Math.round(20 + v * 220);
      ctx.fillStyle = `rgb(${g},${g - 2},${g - 1})`; ctx.fillRect(i * cw, p * ch, cw + .5, ch + .5);
    }
    ctx.strokeStyle = '#ff7a1a'; ctx.lineWidth = 2; ctx.strokeRect(1, pos * ch, w - 2, ch);
    ctx.strokeRect(dim * cw, 1, cw, h - 2);
  }, [pe, pos, dim]);
  const sim = pe.map(r => r.reduce((s, v, i) => s + v * pe[pos][i], 0) / D);
  const wave = pe.map(r => r[dim]);
  return <div className="an an-pe">
    <div className="an-controls">
      <label className="an-slider"><span>位置 pos<b>{pos}</b></span><input type="range" min={0} max={N - 1} value={pos} onChange={e => setPos(Number(e.target.value))} /></label>
      <label className="an-slider"><span>维度 i<b>{dim}</b></span><input type="range" min={0} max={D - 1} value={dim} onChange={e => setDim(Number(e.target.value))} /><small>越靠前频率越高</small></label>
    </div>
    <div className="an-stage an-pe-stage">
      <figure className="an-heat"><figcaption>PE[pos, i] · 64 个位置 × 64 维（点击选择）</figcaption>
        <canvas ref={canvas} width={384} height={384} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setPos(Math.min(N - 1, Math.floor((e.clientY - r.top) / r.height * N))); setDim(Math.min(D - 1, Math.floor((e.clientX - r.left) / r.width * D))); }} />
        <span className="an-axis-y">位置 →</span><span className="an-axis-x">维度 →</span>
      </figure>
      <div className="an-pe-side">
        <figure className="an-line"><figcaption>第 {dim} 维随位置的波形</figcaption>
          <svg viewBox="0 -1.2 63 2.4" preserveAspectRatio="none"><line x1="0" x2="63" y1="0" y2="0" className="an-axis" /><polyline points={wave.map((v, p) => `${p},${-v}`).join(' ')} className="an-on" vectorEffect="non-scaling-stroke" /><line x1={pos} x2={pos} y1="-1.2" y2="1.2" className="an-now" vectorEffect="non-scaling-stroke" /></svg></figure>
        <figure className="an-line"><figcaption>位置 {pos} 与其他位置的相似度</figcaption>
          <svg viewBox="0 -0.2 63 1.25" preserveAspectRatio="none"><polyline points={sim.map((v, p) => `${p},${1 - v}`).join(' ')} className="an-on" vectorEffect="non-scaling-stroke" /><line x1={pos} x2={pos} y1="-0.2" y2="1.05" className="an-now" vectorEffect="non-scaling-stroke" /></svg></figure>
      </div>
    </div>
    <p className="an-say">每个位置得到一段独一无二的「指纹」：低维变化快，像秒针；高维变化慢，像时针。相似度在自己处最高、随距离平滑下降——所以模型能从编码里读出「离我有多远」。</p>
  </div>;
}

/** ③ 多头注意力：每个头关注一种关系，拼起来覆盖更多关系。 */
const HEADS: { name: string; desc: string; f: (i: number, j: number) => number }[] = [
  { name: '头 1 · 前一个字', desc: '关注紧挨着的前一个字，像在读词组', f: (i, j) => j === i - 1 ? 4 : j === i ? 1 : 0 },
  { name: '头 2 · 自己', desc: '主要看自己，保留原有信息', f: (i, j) => i === j ? 4 : 0 },
  { name: '头 3 · 句子主干', desc: '大家都去看「读」和「论文」这两个关键字', f: (_i, j) => j === 2 ? 2.6 : j === 5 ? 3 : 0 },
  { name: '头 4 · 后一个字', desc: '往后看一个字，预判接下来是什么', f: (i, j) => j === i + 1 ? 4 : j === i ? 1 : 0 },
];
export function MultiHead() {
  const [on, setOn] = useState([true, true, true, true]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const mats = HEADS.map(h => TOKENS.map((_, i) => softmax(TOKENS.map((__, j) => h.f(i, j)))));
  const active = mats.filter((_, k) => on[k]);
  const merged = TOKENS.map((_, i) => TOKENS.map((__, j) => active.length ? active.reduce((s, m) => s + m[i][j], 0) / active.length : 0));
  const Grid = ({ m, label, k }: { m: number[][]; label: string; k?: number }) => <figure className="an-grid" data-off={k !== undefined && !on[k] || undefined}>
    <figcaption>{label}</figcaption>
    <div className="an-cells">{m.map((row, i) => row.map((v, j) => <i key={`${i}-${j}`} style={{ opacity: .08 + v * .92 }} data-hl={hover && hover[0] === i && hover[1] === j || undefined} onMouseEnter={() => setHover([i, j])} onMouseLeave={() => setHover(null)} />))}</div>
  </figure>;
  return <div className="an an-heads">
    <div className="an-controls">{HEADS.map((h, k) => <button key={h.name} className="an-head" aria-pressed={on[k]} onClick={() => setOn(o => o.map((v, x) => x === k ? !v : v))}><b>{h.name}</b><small>{h.desc}</small></button>)}</div>
    <div className="an-stage an-heads-stage">
      <div className="an-heads-row">{mats.map((m, k) => <Grid key={k} m={m} label={HEADS[k].name} k={k} />)}</div>
      <div className="an-merged"><Grid m={merged} label={`合并 · ${active.length} 个头`} />
        <div className="an-axis-tokens">{TOKENS.map(t => <span key={t}>{t}</span>)}</div>
        <p>{hover ? <>「{TOKENS[hover[0]]}」看「{TOKENS[hover[1]]}」的权重：<b>{merged[hover[0]][hover[1]].toFixed(2)}</b></> : '悬停任意格子看「谁在看谁」。行是查询，列是被看的字。'}</p></div>
    </div>
    <p className="an-say">单个头只能学一种关系。多个头并行，再拼起来，模型就能同时理解「词组」「主干」「上下文」。关掉几个头，看合并后的图少了什么。</p>
  </div>;
}
