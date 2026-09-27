import { useEffect, useRef, useState } from 'react';
import { Pause, Play, StepBack, StepForward } from 'lucide-react';
import { period, trace, type Evidence } from '../learningState';
import type { SceneProps } from './types';

export function PhysicsLesson({ scene: s, change, record, evidence }: SceneProps & { evidence: Evidence[] }) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(s.time);
  const timeRef = useRef(time); timeRef.current = time;
  const latest = useRef({ change, scene: s }); latest.current = { change, scene: s };
  const autoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recordRef = useRef(record); recordRef.current = record;
  useEffect(() => { setTime(s.time); }, [s.time]);
  useEffect(() => { setPlaying(false); }, [s.mass, s.stiffness, s.stage]);
  useEffect(() => () => {
    clearTimeout(autoTimer.current);
    latest.current.change({ time: timeRef.current });
  }, []);
  useEffect(() => {
    if (!playing) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      const t = Math.min(8, timeRef.current + (now - last) / 1000); last = now; timeRef.current = t; setTime(t);
      if (t < 8) frame = requestAnimationFrame(tick);
      else { setPlaying(false); latest.current.change({ time: 8 }); }
    };
    frame = requestAnimationFrame(tick);
    const hidden = () => { if (document.hidden) { setPlaying(false); latest.current.change({ time: timeRef.current }); } };
    document.addEventListener('visibilitychange', hidden);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', hidden); };
  }, [playing]);
  const w = Math.sqrt(s.stiffness / s.mass);
  const points = Array.from({ length: 241 }, (_, i) => `${50 + i / 240 * 440},${172 - 34 * Math.cos(w * i / 30)}`).join('L');
  const x = 285 + 75 * Math.cos(w * time);
  let spring = 'M40 65L55 65';
  for (let i = 0; i <= 18; i++) spring += `L${55 + (x - 65) * i / 18} ${i === 0 || i === 18 ? 65 : i % 2 ? 55 : 75}`;
  spring += `L${x} 65`;
  function parameter(patch: Parameters<typeof change>[0]) {
    change({ ...patch, time: 0 }); setTime(0); timeRef.current = 0;
    clearTimeout(autoTimer.current); autoTimer.current = setTimeout(() => recordRef.current(), 500);
  }
  if (s.stage) {
    const trials = [...new Map(evidence.filter(e => e.kind === 'snapshot').map(e => [`${e.scene.mass}:${e.scene.stiffness}`, e])).values()];
    return <div className="physics-comparison"><span className="rl-label">对照记录 / 同一模型，不同条件</span><h3>改变一个变量，让比较有依据。</h3>
      {trials.length ? <table className="rl-evidence-table"><thead><tr><th>质量 m / kg</th><th>劲度 k / N·m⁻¹</th><th>模型周期 T / s</th></tr></thead><tbody>{trials.slice(-8).map(e => <tr key={e.id}><td>{e.scene.mass}</td><td>{e.scene.stiffness}</td><td>{period(e.scene.mass, e.scene.stiffness).toFixed(2)}</td></tr>)}</tbody></table> : <p>回到实验页，改变参数或保存一组快照，这里会自动整理对照。</p>}
      <blockquote>相同参数合并展示。结果来自同一个理想模型，不是独立的实验验证，也不包含仪器误差。</blockquote></div>;
  }
  return <div className="rl-split"><article className="rl-lecture"><span className="rl-label">实验讲义 / 理想弹簧振子</span><h3>质量改变了，<br />周期如何响应？</h3><p>保持劲度系数不变，再改变质量。这里忽略阻尼，振幅固定为 0.20 m。</p><div className="rl-formula">T = 2π√(m/k)</div><p>把质量从 0.5 kg 增加到 2 kg：质量变成四倍，周期会变成几倍？先把预测记在右侧。</p><blockquote>播放只演示时间变化；改变参数后，会保存模型条件，不会自动给你打分。</blockquote></article>
      <div className="rl-live-object"><div className="rl-object"><svg className="physics-diagram" viewBox="0 0 540 245" role="img" aria-label={`弹簧振子：周期 ${period(s.mass, s.stiffness).toFixed(2)} 秒，时间 ${time.toFixed(1)} 秒`}>
        <path d="M40 42V90H500" stroke="var(--rl-line)" fill="none" /><path d={spring} fill="none" stroke="var(--rl-green)" strokeWidth="2" /><rect x={x} y="47" width="40" height="38" rx="5" fill="var(--rl-green)" />
        <path d="M50 132V211H490M50 172H490" fill="none" stroke="var(--rl-line)" /><path d={`M${points}`} fill="none" stroke="var(--rl-green)" strokeWidth="1.7" /><circle cx={50 + time / 8 * 440} cy={172 - 34 * Math.cos(w * time)} r="4" fill="var(--rl-ink)" />
        <text x="54" y="125">x (m)</text><text x="40" y="143" textAnchor="end">0.2</text><text x="40" y="177" textAnchor="end">0</text><text x="40" y="209" textAnchor="end">−.2</text><text x="48" y="233">0</text><text x="267" y="233">4</text><text x="482" y="233">8</text><text x="530" y="124" textAnchor="end">t (s) →</text>
      </svg></div><div className="rl-controls"><label>质量 m<input type="range" aria-label="质量 m" min=".5" max="2" step=".5" value={s.mass} onChange={e => parameter({ mass: Number(e.target.value) })} /><span>{s.mass} kg</span></label><label>劲度 k<input aria-label="劲度 k" type="range" min="10" max="40" step="10" value={s.stiffness} onChange={e => parameter({ stiffness: Number(e.target.value) })} /><span>{s.stiffness} N/m</span></label><button onClick={() => {
        if (playing) { setPlaying(false); change({ time }); }
        else { if (time >= 8) { timeRef.current = 0; setTime(0); change({ time: 0 }); } setPlaying(true); }
      }}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? '暂停演示' : '演示 8 秒'}</button><button onClick={() => { change({ time }); record(); }}>保存这组条件</button></div><p className="rl-result">T = {period(s.mass, s.stiffness).toFixed(2)} s · t = {time.toFixed(1)} s</p></div>
    </div>;
}

export function SystemsLesson({ scene: s, change }: SceneProps) {
  const t = trace[s.step];
  const code = ['int a[3] = {2, 3, 5};', 'int sum = 0;', 'for (int i=0; i<3; i++) {', '  sum += a[i];', '}', 'return sum;'];
  const simulation = <section className="rl-live-object" aria-label="C 程序执行状态"><span className="rl-label">固定执行轨迹 / 高亮表示下一条待执行语句</span><div className="rl-code-area"><div className="rl-code">{code.map((l, i) => <div className={`rl-code-line ${t.line === i + 1 ? 'is-current' : ''}`} key={i}><small>{i + 1}</small><code>{l}</code></div>)}</div><div className="rl-register"><div><span>i</span><span>{t.i}</span></div><div><span>sum</span><span>{t.sum}</span></div><div><span>步数</span><span>{s.step} / 10</span></div></div></div>
    <div className="rl-memory">{[2, 3, 5].map((v, i) => <span className={t.read === i ? 'is-current' : ''} key={i}><small>a[{i}]</small>{s.step ? v : '—'}<small>偏移 {i * 4} B</small></span>)}</div><div className="rl-controls"><button disabled={!s.step} onClick={() => change({ step: s.step - 1 })}><StepBack size={14} />上一步</button><button disabled={s.step === 10} onClick={() => change({ step: s.step + 1 }, [4, 6, 8, 10].includes(s.step + 1))}><StepForward size={14} />单步执行</button></div><p className="rl-result" role="status">{t.note}。示例假定 int 为 4 字节。</p>
  </section>;
  if (!s.stage) return simulation;
  return <div className="rl-split"><article className="rl-lecture"><span className="rl-label">课程讲义 / 数组与循环</span><h3>理解循环，<br />观察状态。</h3><p>每次循环读取一个数组元素，并更新 sum。执行控制条件与累加语句，是不同的时刻。</p><div className="rl-formula">sum = 已累加元素之和</div><div className="rl-mini-title">当前位置</div><p>{t.note}。</p><ul><li>高亮一行执行后，哪个值会改变？</li><li>如果把 a[1] 改为 7，第一次影响 sum 是哪一步？</li><li>函数退出循环后，i 还在作用域内吗？</li></ul><blockquote>左侧跟随执行位置，右侧轨迹不会因切换阅读方式被清空。</blockquote><div className="rl-reading-source">本地固定轨迹演示，不执行任意代码，不模拟真实编译器或测试服务。</div></article>{simulation}</div>;
}
