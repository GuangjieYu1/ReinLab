import { useRef } from 'react';
import { Check, ChevronRight, Undo2 } from 'lucide-react';
import { transformPoint, type Point } from '../learningState';
import type { SceneProps } from './types';

const chapters = [
  { title: '先看动作，\n再谈运算。', name: '对称操作', lead: '把正方形的对称操作当成研究对象。外形恢复重合，并不意味着每一个顶点都回到了原位。', question: '什么信息能区分两个看似相同的结果？', equation: '对象：操作，而不只是图形', detail: '为四个顶点保留标签。比较操作时，检查每一个顶点的去向，而不是只看轮廓。', takeaway: '对称操作保持图形整体，但可能交换顶点的位置。' },
  { title: '连续两次，\n就是一次组合。', name: '组合与顺序', lead: '记 R 为逆时针旋转，F 为沿竖直轴反射。先做 R，再做 F，得到的仍是一个对称操作。', question: '改变执行顺序，结果会发生什么？', equation: '先 R 后 F ＝ F ∘ R', detail: '复合记号从右向左读。右侧按钮使用“先……后……”的自然顺序，避免把写法与执行顺序混淆。', takeaway: '90° 时，两种顺序的结果不同。这是“不交换”的一个反例。' },
  { title: '从一个例子，\n抽象出共同规则。', name: '群的定义', lead: '非空集合 G 配上二元运算 G × G → G；运算在集合内封闭，并满足结合律、单位元和逆元条件。', question: '哪些性质属于定义？哪一条不必满足？', equation: '(a · b) · c = a · (b · c)', detail: '结合律改变括号，不改变 a、b、c 的顺序。交换律则要求 a·b=b·a；它不是群的必要条件。', takeaway: '不要用“不交换”否定一个群。先逐项检查定义。' },
  { title: '只保留旋转，\n看看结构如何闭合。', name: '四阶循环群', lead: '只取正方形的四种旋转：不动、90°、180°、270°。连续旋转相当于把角度相加，再模 360°。', question: '任意两个元素的乘积，会离开这个集合吗？', equation: 'C₄ = { e, R, R², R³ }', detail: '这里 R 固定为 90° 旋转，R⁴=e。R 的逆元是 R³；R² 是自己的逆元。这个子群恰好也满足交换律。', takeaway: '一个群可以交换，也可以不交换。定义比某一个例子更广。' },
  { title: '同一个乘积，\n两条定义的用法。', name: '单位元唯一性', lead: '假设 e 与 e′ 都是同一个群的单位元。目标是证明它们其实相同。只需研究一个表达式 e · e′。', question: '分别把 e 和 e′ 当作单位元，会得到什么？', equation: '已知两个单位元　→　证明 e = e′', detail: '不要从目标倒推并假装它已经成立。每一步都应指出使用了谁的单位元性质。', takeaway: '证明不是重复结论，而是给结论补齐可靠的依赖。' },
  { title: '离开示范，\n确认自己的理解。', name: '局部核验', lead: '这两个判断只检查本节的一小部分目标，不等于你已经掌握群论。先独立作答，再查看解释。', question: '你能区分“定义要求”和“例子特点”吗？', equation: '观察 → 定义 → 解释 → 迁移', detail: '回看讲义不会清空你的笔记。核验记录会写明题目与答案，不用阅读时长替代理解。', takeaway: '下一步可以研究置换、子群和同态；本轮不虚构完整课程完成度。' },
];
export const mathChapterNames = chapters.map(chapter => chapter.name);
const labels = ['A', 'B', 'C', 'D'];
const corners: Point[] = [[-1, 1], [1, 1], [1, -1], [-1, -1]];

function Square({ angle, order, active }: { angle: 90 | 180; order: 'RF' | 'FR'; active: boolean }) {
  return <svg viewBox="0 0 230 230" role="img" aria-label={`${order === 'RF' ? '先旋转后反射' : '先反射后旋转'}的四个顶点位置`}>
    <path d="M35 115H195M115 35V195" stroke="var(--rl-line)" />
    <rect x="59" y="59" width="112" height="112" rx="3" fill="var(--rl-soft)" stroke="var(--rl-green)" strokeWidth={active ? 2 : 1} />
    {corners.map((p, i) => {
      const [x, y] = transformPoint(p, angle, order);
      return <g key={i} className="math-vertex" transform={`translate(${115 + x * 56} ${115 - y * 56})`}>
        <circle r={i === 0 ? 8 : 4} fill={i === 0 ? 'var(--rl-green)' : 'var(--rl-muted)'} />
        <text x={x * 17} y={y > 0 ? -14 : 25} textAnchor="middle">{labels[i]}</text>
      </g>;
    })}
    <text x="115" y="220" textAnchor="middle">{order === 'RF' ? '先旋转 → 后反射' : '先反射 → 后旋转'}</text>
  </svg>;
}
export default function MathLesson({ scene: s, change, record }: SceneProps) {
  const drag = useRef<{ index: number; x: number; y: number; start: Point } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const page = chapters[s.page];
  if (s.stage === 1) return <div className="rl-split">
    <article className="rl-lecture"><span className="rl-label">AI CANVAS / 对象式绘图</span><h3>让解释成为<br />可修改的对象。</h3><p>“画出正方形的四种旋转，连接相邻状态，再标明如何回到起点。”</p><ol className="math-steps"><li>生成可编辑节点</li><li>关联有方向的关系</li><li>补充数学约束</li></ol><blockquote>移动节点，连接关系跟随。不是把一张生成图片贴进课堂。</blockquote><div className="rl-reading-source">借鉴 tldraw Agent 的对象操作方式。当前为固定流程预演，没有连接模型，也未集成 tldraw SDK。</div></article>
    <div className="rl-live-object">
      <div className="rl-ai-canvas" ref={canvas} onPointerMove={e => {
        const d = drag.current; if (!d) return;
        const r = e.currentTarget.getBoundingClientRect();
        const nodes = s.nodes.map(p => [...p] as Point);
        nodes[d.index] = [Math.max(12, Math.min(88, d.start[0] + (e.clientX - d.x) / r.width * 100)), Math.max(14, Math.min(80, d.start[1] + (e.clientY - d.y) / r.height * 100))];
        change({ nodes });
      }} onPointerUp={() => { if (drag.current) record(); drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        {s.canvasLayer === 0 ? <div className="rl-canvas-empty"><strong>一块等待解释的画布</strong><span>点击下方，预演对象生成。</span></div> : <>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="learning-node-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 1L9 5L0 9" fill="none" stroke="var(--rl-green)" /></marker></defs>
            {s.canvasLayer >= 2 && s.nodes.map((p, i) => { const q = s.nodes[(i + 1) % 4], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1; return <path key={i} d={`M${p[0] + dx / len * 7} ${p[1] + dy / len * 9}L${q[0] - dx / len * 9} ${q[1] - dy / len * 11}`} stroke="var(--rl-green)" strokeWidth=".5" fill="none" markerEnd="url(#learning-node-arrow)" />; })}
          </svg>
          {s.nodes.map((p, i) => <button key={i} className="rl-node" style={{ left: `${p[0]}%`, top: `${p[1]}%` }} aria-label={`画布节点 ${['e', 'R', 'R²', 'R³'][i]}`} aria-pressed={s.selectedNode === i} onClick={() => change({ selectedNode: i })} onPointerDown={e => {
            drag.current = { index: i, x: e.clientX, y: e.clientY, start: [...p] }; canvas.current?.setPointerCapture(e.pointerId);
          }} onKeyDown={e => {
            const delta: Record<string, Point> = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] };
            if (!delta[e.key]) return; e.preventDefault();
            const nodes = s.nodes.map(p => [...p] as Point); nodes[i] = [Math.max(12, Math.min(88, p[0] + delta[e.key][0])), Math.max(14, Math.min(80, p[1] + delta[e.key][1]))]; change({ nodes, selectedNode: i }, true);
          }}>{['e', 'R', 'R²', 'R³'][i]}</button>)}
          {s.canvasLayer === 3 && <div className="rl-ai-label">每条边表示再旋转 90° · R⁴ = e</div>}
        </>}
      </div>
      <div className="rl-controls"><button disabled={s.canvasLayer === 3} onClick={() => change({ canvasLayer: s.canvasLayer + 1 }, true)}>{['生成对象（演示）', '补画关系', '补上说明', '绘图完成'][s.canvasLayer]}</button><button disabled={!s.canvasLayer} onClick={() => change({ canvasLayer: s.canvasLayer - 1 }, true)}><Undo2 size={13} />撤回一层</button></div><p className="rl-result">支持拖动与方向键微调 · 固定脚本，不伪装真实 AI 绘图</p>
    </div>
  </div>;
  return <div className="rl-split math-split">
    <article className="rl-lecture math-lecture">
      <div className="math-page-meta"><span>LECTURE 01 · 对称与群</span><b>{String(s.page + 1).padStart(2, '0')} / 06</b></div>
      <h3>{page.title.split('\n').map((line, i) => <span key={line}>{i > 0 && <br />}{line}</span>)}</h3>
      <p className="math-lead">{page.lead}</p>
      <div className="math-anchor"><span>核心表达</span><div>{page.equation}</div></div>
      <div className="rl-mini-title">读图时，留意这一点</div><p>{page.detail}</p>
      <blockquote>{page.takeaway}</blockquote>
      <details className="math-outline"><summary>讲义目录与参考</summary><nav aria-label="数学讲义目录">{chapters.map((c, i) => <button key={c.name} aria-current={s.page === i ? 'page' : undefined} onClick={() => change({ page: i })}>{String(i + 1).padStart(2, '0')}　{c.name}</button>)}</nav><a href="https://ocw.mit.edu/courses/es-268-the-mathematics-in-toys-and-games-spring-2010/resources/mites_268s10_ses6_slides/" target="_blank" rel="noreferrer">参考 MIT ES.268 群论课件 ↗</a><p>本页为原创教学改写，不是 MIT 原课件，也不代表完整群论课程。</p></details>
    </article>
    <section className="rl-live-object math-object" aria-label={`讲义配套活动：${page.name}`}>
      <div className="math-object-heading"><span>与你正在读的这一页对应</span><h4>{page.question}</h4></div>
      {s.page < 2 && <><div className="math-squares"><Square angle={s.angle} order="RF" active={s.operation === 'RF'} /><Square angle={s.angle} order="FR" active={s.operation === 'FR'} /></div><div className="rl-controls"><button aria-pressed={s.angle === 90} onClick={() => change({ angle: 90 }, true)}>R = 90°</button><button aria-pressed={s.angle === 180} onClick={() => change({ angle: 180 }, true)}>R = 180°</button><button aria-pressed={s.operation === 'RF'} onClick={() => change({ operation: 'RF' })}>追踪左侧</button><button aria-pressed={s.operation === 'FR'} onClick={() => change({ operation: 'FR' })}>追踪右侧</button></div><p className="math-observation" role="status">{s.angle === 90 ? 'A 的落点不同，已足以证明这两个操作不相同。' : '四个顶点的对应均相同；180° 旋转与此反射可以交换。'}</p><p className="rl-result">复合按右到左解释：左图 F∘R，右图 R∘F。</p></>}
      {s.page === 2 && <div className="math-axioms">{[
        ['封闭', '两个对称操作连续执行，仍然得到一个对称操作。'],
        ['结合', '操作复合满足结合律；分组不改变执行顺序。'],
        ['单位元', '恒等操作 e：不移动任何顶点。'],
        ['逆元', '每个旋转都能反向撤销；一次反射再做一次会回到原位。'],
      ].map(([a, b]) => <div key={a}><Check size={14} /><section><h4>{a}</h4><p>{b}</p></section></div>)}<div className="math-caution">不是必要条件：交换律。<br />正方形的全部对称操作构成群，但它不是交换群。</div></div>}
      {s.page === 3 && <><table className="math-cayley"><caption>C₄ 的运算表 · 行元素与列元素相乘</caption><thead><tr><th scope="col">·</th>{['e', 'R', 'R²', 'R³'].map(x => <th scope="col" key={x}>{x}</th>)}</tr></thead><tbody>{[0, 1, 2, 3].map(a => <tr key={a}><th scope="row">{['e', 'R', 'R²', 'R³'][a]}</th>{[0, 1, 2, 3].map(b => <td key={b}><button aria-label={`${['e', 'R', 'R²', 'R³'][a]} 乘 ${['e', 'R', 'R²', 'R³'][b]}`} aria-pressed={s.answer === `${a},${b}`} onClick={() => change({ answer: `${a},${b}` }, true)}>{['e', 'R', 'R²', 'R³'][(a + b) % 4]}</button></td>)}</tr>)}</tbody></table><div className="math-observation" role="status">{/^[0-3],[0-3]$/.test(s.answer) ? (() => { const [a, b] = s.answer.split(',').map(Number); return `${a * 90}° + ${b * 90}° ≡ ${((a + b) % 4) * 90}°（mod 360°）。结果仍在 C₄ 中。`; })() : '点击任意一格，查看旋转角度如何组合。'}</div></>}
      {s.page === 4 && <><div className="rl-proof-line"><span>已知</span><div><div className="rl-formula">e、e′ 都是单位元。</div><p className="rl-reason">还没有假定 e=e′。</p></div></div>{[
        ['e · e′ = e′', '因为 e 是左单位元。'],
        ['e · e′ = e', '因为 e′ 是右单位元。'],
        ['e = e′', '同一个表达式的两个值相等，单位元唯一。'],
      ].slice(0, s.proof).map(([eq, reason], i) => <div className="rl-proof-line" key={eq}><span>0{i + 1}</span><div><div className="rl-formula">{eq}</div><p className="rl-reason">{reason}</p></div></div>)}<div className="rl-controls"><button disabled={s.proof === 3} onClick={() => change({ proof: s.proof + 1 }, true)}>展开下一步<ChevronRight size={14} /></button><button disabled={!s.proof} onClick={() => change({ proof: 0 })}>收起证明</button></div><p className="rl-result">展开的是示范，不记录为独立证明通过。</p></>}
      {s.page === 5 && <div className="math-quiz"><span className="rl-label">判断题 / 固定题目的局部反馈</span><h4>R 与 F 不交换，是否足以否定它们所在的对称群？</h4><button aria-pressed={s.answer === 'wrong'} onClick={() => change({ answer: 'wrong' }, true)}>足以否定：所有群都必须交换。</button><button aria-pressed={s.answer === 'correct'} onClick={() => change({ answer: 'correct' }, true)}>不能否定：交换律不是群的必要条件。</button><p role="status">{s.answer === 'correct' ? '这一个判断正确。接下来，请用自己的话解释结合律与交换律的区别。' : s.answer === 'wrong' ? '回到第 3 页：结合律改变括号，交换律改变顺序。群必须满足前者，但不一定满足后者。' : '先独立判断；反馈只针对这一个问题。'}</p></div>}
    </section>
  </div>;
}
