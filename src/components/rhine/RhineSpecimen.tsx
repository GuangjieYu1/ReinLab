import { useEffect, useState } from 'react';
import '../../styles/rhine.css';
import './rhine-specimen.css';
import { RhineMark, Mobius } from './RhineMark';
import { Callout, Ghost, IndexTabs, PanelHeader, SignalDot } from './primitives';

const SWATCHES: [string, string][] = [
  ['white', '#fbfbf9'], ['paper', '#f0eeea'], ['paper-2', '#e6e4df'], ['paper-3', '#d9d7d1'], ['line', '#c9c6c0'],
  ['ink-4', '#9a9792'], ['ink-3', '#6b6865'], ['ink-2', '#3a3837'], ['ink', '#141213'],
];
const SIGNALS: [string, string, string][] = [
  ['accent', '#ff7a1a', '焦点 · AI 改动 · 待决定'], ['signal', '#c2f63a', '只做信号灯'], ['danger', '#d6402b', '失败 · 冲突'],
];
const STAGES = ['假设', '改码', '训练', '评估', '取舍'];
const EVENTS = [
  { k: 'user', l: '人', t: '把 REQ-012 的验收标准补全，再跑一次 WhatIf。', m: '#01 22:51' },
  { k: 'read', l: 'R', t: 'requirements/REQ-012.md', m: '#02 22:51' },
  { k: 'agent', l: 'AI', t: '补了 AC-3、AC-4。WhatIf 发现 1 处本体冲突：「档案」与「文件」的从属关系相反。', m: '#03 22:52' },
];
const TIMELINE = ['user', 'read', 'agent', 'edit', 'read', 'edit', 'agent', 'ask'];
const FOCUS_ITEMS = ['browser.css', 'useKeys.ts', 'ArchiveList.tsx'];
const SECTIONS = [
  { id: 'color', label: '色彩' }, { id: 'type', label: '字体' }, { id: 'vocab', label: '词汇' }, { id: 'parts', label: '构件' },
  { id: 'agent', label: '助手' }, { id: 'motion', label: '动效' }, { id: 'dont', label: '反例' },
];

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  return now;
}

export default function RhineSpecimen() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [motion, setMotion] = useState<'full' | 'reduce'>('full');
  const [face, setFace] = useState('req');
  const [running, setRunning] = useState(true);
  const [stage, setStage] = useState(1);
  const [focus, setFocus] = useState({ i: 0, n: 0 });
  const [scan, setScan] = useState(0);
  const [flash, setFlash] = useState(0);
  const [cursor, setCursor] = useState(2);
  const [section, setSection] = useState('color');
  const now = useClock();

  useEffect(() => { document.title = '工作台设计模板 — ReinLab'; }, []);
  function jump(id: string) {
    setSection(id);
    document.getElementById(`rs-${id}`)?.scrollIntoView({ behavior: motion === 'reduce' ? 'auto' : 'smooth', block: 'start' });
  }

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setStage(s => (s + 1) % STAGES.length), 2400);
    return () => clearInterval(id);
  }, [running]);

  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');

  return (
    <div className="rh rh-grain rs" data-theme={theme} data-motion={motion}>
      <header className="rs-top">
        <div className="rs-brand"><RhineMark size={22} /><div><strong className="rh-display">Rhine Lab</strong><span className="rh-micro">Synthesize information · Analysis OS</span></div></div>
        <IndexTabs label="模板目录" value={section} onChange={jump} tabs={SECTIONS} />
        <div className="rs-top-right">
          <span className="rh-inverse rh-mono">X—013</span>
          <button className="rh-btn is-ghost" onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '暗色' : '亮色'}</button>
          <button className="rh-btn is-ghost" aria-pressed={motion === 'reduce'} onClick={() => setMotion(m => m === 'full' ? 'reduce' : 'full')}>{motion === 'full' ? '减少动态效果' : '恢复动态效果'}</button>
        </div>
      </header>

      <section className="rs-hero">
        <Ghost text="Archive" size={260} style={{ right: -40, top: -30 }} />
        <div className="rs-hero-copy">
          <span className="rh-micro">Workbench template · design language v0.2 · 2026-10-15</span>
          <h1 className="rh-display">Workbench<br />Template</h1>
          <p><b className="rs-cn-title">工作台设计模板</b>所有工作台共用的色彩、字体、构件与动效。瑞士版式、单色纸墨、一个强调色，再叠一层科幻档案感。</p>
        </div>
        <div className="rs-clock">
          <span className="rs-clock-time">{hh}:{mm}</span>
          <span className="rh-micro">{now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</span>
          <span className="rh-strip rh-micro"><span><SignalDot state="on" /> Terminal online</span><span>Sample data</span></span>
        </div>
      </section>

      <main className="rs-grid">
        {/* 01 色彩 */}
        <section id="rs-color" className="rh-panel rs-span-7">
          <PanelHeader no="01" title="纸与墨" micro="Color · monochrome + one accent" />
          <div className="rs-body">
            <div className="rs-swatches">
              {SWATCHES.map(([n, v]) => <div key={n}><i style={{ background: v }} /><span className="rh-micro">{n}</span><span className="rh-mono rs-hex">{v}</span></div>)}
            </div>
            <div className="rs-signals">
              {SIGNALS.map(([n, v, use]) => <div key={n}><i style={{ background: v }} /><div><strong>{n}</strong><span className="rh-mono rs-hex">{v}</span><span className="rh-micro">{use}</span></div></div>)}
            </div>
            <p className="rs-rule rh-sq">一屏里强调色超过三处，就是用错了。</p>
          </div>
        </section>

        {/* 02 字体 */}
        <section id="rs-type" className="rh-panel rs-span-5">
          <PanelHeader no="02" title="三种声音" micro="Type · display / ui / mono / read" />
          <div className="rs-body rs-type">
            <div className="rh-display rs-type-xl">X—013</div>
            <div className="rh-micro">Section 003 · Terminal node · feat/ISS-34-keyboard-nav</div>
            <div className="rs-type-ui">档案浏览器 · 键盘与窄屏</div>
            <p className="rh-read">验收标准 AC-3：当容器宽度小于 700px 时，档案列表改为上下排布，键盘上下键仍可选择。</p>
          </div>
        </section>

        {/* 03 视觉词汇 */}
        <section id="rs-vocab" className="rh-panel rs-span-12">
          <PanelHeader no="03" title="视觉词汇" micro="Vocabulary · what makes it Rhine" />
          <div className="rs-body rs-vocab">
            <div className="rh-block rs-section-card">
              <span className="rh-micro" style={{ color: 'var(--rh-ink-4)' }}>Section</span>
              <div className="rh-display rs-section-name">CMPT<br />CTRL</div>
              <span className="rh-micro" style={{ color: 'var(--rh-ink-4)' }}>Components control section</span>
            </div>
            <div className="rs-stack">
              {['REQ-010', 'REQ-012', 'REQ-013'].map((r, i) => (
                <article key={r} className="rh-specimen" style={{ zIndex: i + 1, marginTop: i ? -50 : 0, marginLeft: i * 18 }}>
                  <div className="rs-spec-row"><span className="rh-inverse rh-mono">{r}</span><SignalDot state={i === 1 ? 'wait' : 'on'} /></div>
                  <strong>{['档案阵列与抽取', '键盘与窄屏', '解密转场'][i]}</strong>
                  <div className="rh-strip rh-micro"><span>AC 4</span><span>Issue 2</span><span>{i === 1 ? '冲突 1' : '无冲突'}</span></div>
                </article>
              ))}
              <Callout x={300} y={34} dx={44} dy={-26} run={130} code="Section 003 · Specimen" label="标本盒：档案即文件" />
            </div>
            <ul className="rs-legend">
              <li><span className="rh-inverse">反白标签</span> 当前标题、档案名</li>
              <li><span className="rh-boxed rh-mono">描边框</span> 次级标签、分支名</li>
              <li className="rh-sq">橙色方块：这里需要你</li>
              <li><SignalDot state="on" /> 通过 · <SignalDot state="wait" /> 待处理 · <SignalDot state="bad" /> 失败 · <SignalDot /> 离线</li>
              <li className="rh-micro">微标注带 · PCM 32/48 · 25 tracks · 1:20:04</li>
            </ul>
          </div>
        </section>

        {/* 04 构件 */}
        <section id="rs-parts" className="rh-panel rs-span-8">
          <PanelHeader no="04" title="构件" micro="Components · 示例取自工程台的面签" onExpand={() => {}}
            actions={<IndexTabs label="面" value={face} onChange={setFace} tabs={[{ id: 'req', label: '需求', count: 2 }, { id: 'dev', label: '开发', count: 5 }, { id: 'test', label: '测试' }, { id: 'onto', label: '本体' }]} />} />
          <div className="rs-body rs-components">
            <div>
              <div className="rh-micro" style={{ marginBottom: 6 }}>Plan · 4 / 6</div>
              <div className="rh-rail" style={{ marginBottom: 10 }}>{[1, 1, 1, 1, 2, 0].map((s, i) => <i key={i} className={s === 1 ? 'is-done' : s === 2 ? 'is-now' : ''} />)}</div>
              <ol className="rs-todo">
                {['读懂现有浏览器组件', '抽出 useKeys 键盘钩子', '列表加上 option 语义', '窄屏改为上下排布', '补键盘与窄屏测试', '真实页面截图检查'].map((t, i) => (
                  <li key={t} className={i < 4 ? 'is-done' : i === 4 ? 'rh-sq' : ''}><span className="rh-mono">{String(i + 1).padStart(2, '0')}</span>{t}</li>
                ))}
              </ol>
              <div className="rh-micro" style={{ margin: '14px 0 6px' }}>Budget · GPU h</div>
              <div className="rh-gauge"><span style={{ width: '62%' }} /><i style={{ left: '50%' }} /><i style={{ left: '80%' }} /></div>
              <div className="rh-strip rh-micro" style={{ marginTop: 6 }}><span>6.2 / 10 h</span><span>审批线 50% · 80%</span></div>
            </div>
            <div>
              {EVENTS.map(e => (
                <div key={e.m} className="rh-ev rh-enter" data-kind={e.k}>
                  <span className="rh-ev-k">{e.l}</span>
                  <div><div className="rh-micro">{e.m}</div><div className={e.k === 'read' ? 'rh-mono' : ''}>{e.t}</div></div>
                </div>
              ))}
              <div className={`rh-approval${flash ? ' rh-flash' : ''}`} key={flash}>
                <strong>待审批 · 提交 MR</strong>
                <div className="rh-mono rs-hex" style={{ margin: '4px 0 10px' }}>requirements/REQ-012.md · +14 −3 · write</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="rh-btn is-solid" onClick={() => setFlash(f => f + 1)}>批准</button>
                  <button className="rh-btn">驳回</button>
                </div>
              </div>
              <div className="rs-timeline-row">
                <div className="rh-timeline">{TIMELINE.map((k, i) => <button key={i} data-kind={k} aria-label={`记录 ${i + 1}`} aria-current={i === cursor} onClick={() => setCursor(i)} />)}</div>
                <span className="rh-micro">8 events · #0{cursor + 1}</span>
              </div>
            </div>
          </div>
        </section>

        {/* 05 Agent 坞 */}
        <section id="rs-agent" className="rh-panel rs-span-4">
          <PanelHeader no="05" title="开发助手" micro="Agent · ISS-34 · keyboard-nav" />
          <div className="rs-body rs-dock">
            <div className="rs-dock-head"><span className="rh-inverse rh-mono">AGENT</span><span className="rh-mono">feat/ISS-34-keyboard-nav</span><SignalDot state="on" label="在线" /></div>
            <div className="rs-suggest">
              {['ToSpec', 'ToTDD', '跑测试', '标记待测试'].map(s => <button key={s} className="rh-btn is-ghost">{s}</button>)}
            </div>
            <div className="rs-msg rs-msg-user">帮我跑一下自动测试</div>
            <div className="rs-msg"><span className="rh-micro">▸ run_tests · read · 自动执行</span><br />窄屏用例 3/4 通过，CASE-118 失败：390 宽下列表仍是横排。</div>
            <div className="rs-composer"><span>@ 引用对象，/ 调用动作</span><button className="rh-btn is-solid" aria-label="发送">↑</button></div>
            <div className="rh-micro">权限：只读自动 · 写入需审批 · 危险操作仅限人工</div>
          </div>
        </section>

        {/* 06 动效 */}
        <section id="rs-motion" className="rh-panel rs-span-12">
          <PanelHeader no="06" title="两种标志动效" micro="Motion · aperture / möbius / scan / flash" />
          <div className="rs-body rs-motion">
            <div>
              <div className="rh-micro">Aperture · 看这里</div>
              <div className="rs-focus-list">
                {FOCUS_ITEMS.map((f, i) => <span key={`${f}-${focus.i === i ? focus.n : 0}`} className={`rh-card rh-mono${focus.i === i ? ' rh-aperture' : ''}`}>{f}</span>)}
              </div>
              <button className="rh-btn" onClick={() => setFocus(p => ({ i: (p.i + 1) % FOCUS_ITEMS.length, n: p.n + 1 }))}>定位下一个</button>
            </div>
            <div>
              <div className="rh-micro">Möbius · 循环运行中</div>
              <Mobius stages={STAGES} current={stage} running={running} />
              <button className="rh-btn" onClick={() => setRunning(r => !r)}>{running ? '暂停循环' : '继续循环'}</button>
            </div>
            <div>
              <div className="rh-micro">Scan · 打开档案</div>
              <div className="rh-scan rs-scan-box" key={scan} style={{ ['--rh-scan-h' as string]: '120px' }}>
                <div><span className="rh-inverse rh-mono">X—013</span><strong className="rh-display" style={{ display: 'block', fontSize: 28, marginTop: 8 }}>Unlocked</strong><span className="rh-micro">Session seal · verified</span></div>
              </div>
              <button className="rh-btn" onClick={() => setScan(s => s + 1)}>重新扫描</button>
            </div>
            <div>
              <div className="rh-micro">Working · AI 正在处理</div>
              <div className="rh-card rh-mono rh-working" style={{ margin: '14px 4px 18px' }}>browser.css</div>
              <p className="rs-note">流动虚线框表示 AI 正在操作这个对象；完成后橙框闪烁（点构件区的「批准」查看）。</p>
            </div>
          </div>
        </section>

        {/* 07 反面 */}
        <section id="rs-dont" className="rh-panel rs-span-12 rs-dont">
          <PanelHeader no="07" title="不要这样" micro="Anti-pattern · specimen B" />
          <div className="rs-body rs-dont-body">
            <div className="rs-dont-mock" aria-hidden="true"><div><b>Workspace locked</b><i /><i className="btn" /></div></div>
            <ul>
              <li className="rh-sq">居中圆角 SaaS 卡片 + 通用输入框：像任何一个后台登录页</li>
              <li className="rh-sq">与信息无关的装饰插画占据半屏</li>
              <li className="rh-sq">所有文字同一个重量，没有超大字与微标注的尺度反差</li>
              <li className="rh-sq">大面积空白却没有网格和标注撑住</li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="rs-status">
        <span className="rh-strip rh-micro"><span><SignalDot state="on" /> Local preview</span><span>develop @ a1f3c9</span><span>Sample data · 不连接模型</span></span>
        <span className="rh-micro">Powered by <b style={{ color: 'var(--rh-ink)' }}>Rhine Lab</b> —</span>
      </footer>
    </div>
  );
}
