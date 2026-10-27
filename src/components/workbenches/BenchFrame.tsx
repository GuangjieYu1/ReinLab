import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BenchChrome } from './WorkbenchStudio';
import { isDemoBench } from '../../backendMode';
import '../../styles/rhine.css';
import './engineering/engineering.css';
import './engineering/motion.css';

// 各工作台共用的外壳（莱茵生命）：面签行（返回 · 身份黑块 + 标识 + 档案切换 · 编号面签 · 微标注带 · 右侧工具）
// · 切面快门 · 状态条（心跳与时钟）。工作台只提供面的列表、内容和状态条上的字段。

export type FrameFace = { id: string; label: string; en: string; badge?: number; locked?: boolean };

export default function BenchFrame({ code, section, faces, face, onFace, chrome, reduced, file, strip, tools, status, shutterLines, children }: {
  code: string; section: string; faces: FrameFace[]; face: string; onFace: (id: string) => void; chrome: BenchChrome; reduced: boolean; file: number;
  strip?: ReactNode; tools?: ReactNode; status: ReactNode; shutterLines?: (face: FrameFace) => string[]; children: ReactNode;
}) {
  const current = faces.find(f => f.id === face)!;
  const demo = isDemoBench(code);
  // 切面快门：face 每变一次挂一块新的快门（首次进入不放，进入工作台的转场已经覆盖）。
  const [shutter, setShutter] = useState(0);
  const first = useRef(face);
  useEffect(() => { if (face !== first.current) { first.current = face; setShutter(n => n + 1); } }, [face]);
  // 面签下的指示条：滑到当前面。
  const tabs = useRef<HTMLDivElement>(null), bar = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const on = tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]'), el = bar.current;
    if (!on || !el) return;
    el.style.width = `${on.offsetWidth}px`; el.style.transform = `translateX(${on.offsetLeft}px)`;
  }, [face]);
  return <div className="en rh rh-grain" data-bench={code} data-demo={demo || undefined} data-motion={reduced ? 'reduce' : undefined} data-file={file}>
    <div className="en-faces" data-wb-bar>
      {chrome.back}
      <div className="en-id">{chrome.logo}<div><b>{code}</b><small>SECTION {section} · {current.en}</small></div>{chrome.file}<i /></div>
      {demo && <span className="en-demo" title="这个工作台还没接真实后端：里面的回复、运行和结果都是示例，不代表真实执行">演示数据</span>}
      <div className="en-tabs" role="tablist" aria-label="工作台的面" ref={tabs}>
        <span className="en-tabs-bar" ref={bar} aria-hidden="true" />
        {faces.map((f, i) => <button key={f.id} role="tab" aria-selected={f.id === face} data-locked={f.locked || undefined} onClick={() => onFace(f.id)}>
          <b>{String(i + 1).padStart(2, '0')}</b><span>{f.label}<small>{f.en}</small></span>{f.locked ? <em className="en-lock">锁</em> : f.badge ? <em>{String(f.badge).padStart(2, '0')}</em> : null}
        </button>)}
      </div>
      {strip && <span className="en-strip rh-micro">{strip}</span>}
      {tools && <div className="en-branch">{tools}</div>}
    </div>
    <div className="en-stage">
      {shutter > 0 && <Shutter key={shutter} code={code} section={section} index={faces.indexOf(current)} face={current} lines={shutterLines?.(current)} />}
      <div className="en-face" key={face} data-shuttered={shutter > 0 || undefined}>{children}</div>
    </div>
    <footer className="en-statusbar">{demo && <span className="en-demo-s">演示数据 · 未接真实后端，结果不代表真实执行</span>}{status}<Pulse /><b>POWERED BY RHINE LAB</b></footer>
  </div>;
}

/** 切面快门：橙色细边 + 墨色闸板从左扫入，停一拍显示面编号与日志，再向右退出。 */
function Shutter({ code, section, index, face, lines }: { code: string; section: string; index: number; face: FrameFace; lines?: string[] }) {
  const log = lines ?? [`> mount face ${String(index + 1).padStart(2, '0')} · ${face.en.toLowerCase()}`, '> restore session', '> ready'];
  return <div className="en-shutter" aria-hidden="true">
    <i className="en-shutter-edge" />
    <div className="en-shutter-panel">
      <b>{String(index + 1).padStart(2, '0')}</b>
      <div><strong>{face.en}</strong><span>{face.label} · SECTION {section} · {code}</span><ol>{log.map((l, i) => <li key={i} style={{ animationDelay: `${120 + i * 55}ms` }}>{l}</li>)}</ol></div>
      <i className="en-shutter-ticks" />
    </div>
  </div>;
}

/** 状态条右侧的心跳：实时时钟 + 持续跳动的信号线。 */
function Pulse() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  return <span className="en-pulse"><i className="en-pulse-dot" />SYS · NOMINAL
    <svg viewBox="0 0 120 16" aria-hidden="true"><path className="en-pulse-base" d="M0 8 H34 L38 3 L42 13 L46 8 H62 L65 1 L69 15 L72 8 H120" /><path className="en-pulse-line" d="M0 8 H34 L38 3 L42 13 L46 8 H62 L65 1 L69 15 L72 8 H120" /></svg>
    <time>{t}</time></span>;
}
