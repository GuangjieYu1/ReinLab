import { useEffect, useLayoutEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { EntryWorkbench } from '../cinematic/entryWorkbenches';
import { fileBriefs } from './fileBriefs';
import type { DossierSummary } from '../dossier/adapter';
import { when } from '../dossier/store';
import './file-preview.css';

type Props = {
  workbench: EntryWorkbench; index: number; fileNo: string; code: string;
  /** 真实档案的摘要；null = 空槽（进去后新建）；undefined = 没有档案数据（旧的演示入口）。 */
  summary?: DossierSummary | null;
  closing: boolean; note: string | null; instant?: boolean;
  origin?: SlipAnchor | null; // 档案盒里那张小票的位置与盒口高度：从盒口取出，关闭时放回
  onContinue: () => void; onBack: () => void;
};

/** 档案盒里那张小票此刻在屏幕上的位置（slip），以及档案盒上缘的高度（lip，盒口）。 */
export type SlipAnchor = { slip: DOMRect; lip: number };

type Brief = { name: string; last: { step: number; total: number; label: string; when: string; where: string } };
const WORK_AT: Record<DossierSummary['work']['state'], string> = { idle: '—', running: '运行中', waiting: '等你处理', failed: '上次失败' };
function briefOf(workbench: EntryWorkbench, index: number, summary?: DossierSummary | null): Brief {
  // 示例档案（mock-）沿用原来的示例简报；真实档案用真实的最近活动和进展；空槽说明进去后新建。
  if (summary === null) return { name: '＋ 新建档案', last: { step: 0, total: 0, label: '空档案槽 · 继续工作就新建一份', when: '—', where: '—' } };
  if (summary && !summary.id.startsWith('mock-')) return { name: summary.title, last: { step: 0, total: 0, label: summary.progress ?? (summary.intent ?? '尚未开始'), when: when(summary.lastActivityAt), where: summary.pending ? `${summary.pending} 件待处理` : WORK_AT[summary.work.state] } };
  const brief = fileBriefs[workbench.id]?.[index];
  return { name: workbench.files[index], last: brief?.last ?? { step: 0, total: 0, label: '尚未开始', when: '—', where: '—' } };
}

/** 小票的票面：页眉、档案名、上次停在哪里、进度。 */
function Ticket({ workbench, fileNo, code, b }: { workbench: EntryWorkbench; fileNo: string; code: string; b: Brief }) {
  const { last } = b;
  return <>
    <header className="fp-head"><b aria-label={code}>{code}</b><span>FILE {fileNo}</span></header>
    <div className="fp-body">
      <span className="fp-eyebrow"><i />{workbench.fileKind}</span>
      <h2>{b.name}</h2>
      <dl className="fp-meta">
        <div><dt>STUDIO</dt><dd>{workbench.title}</dd></div>
        <div><dt>LAST</dt><dd>{last.when}</dd></div>
        <div><dt>AT</dt><dd>{last.where}</dd></div>
      </dl>
      <section className="fp-last" aria-label="上次进度">
        <span className="fp-last-head">LAST SESSION · 上次停在</span>
        <strong>{last.label}</strong>
        {last.total > 0 && <div className="fp-rail" aria-label={`${last.step} / ${last.total}`}>{Array.from({ length: last.total }, (_, i) => <i key={i} className={i < last.step ? 'done' : i === last.step ? 'now' : ''} />)}<em>{last.step}/{last.total}</em></div>}
      </section>
    </div>
  </>;
}

// 档案小票：竖着放在档案盒里（隔着玻璃隐约可见）。抽取档案、档案盒到位后，小票被捏住上缘、从盒口竖直提出，
// 越过盒口后沿弧线落到档案盒右边，略带倾斜、轻轻摆正；放回时原路提起、越过盒口、竖直落回盒里。
// 只动 transform 与 opacity；盒口上沿有一道橙色的光，小票经过时亮起。
export default function FilePreview({ workbench, index, summary, fileNo, code, closing, note, instant = false, origin = null, onContinue, onBack }: Props) {
  const card = useRef<HTMLElement>(null), lipLight = useRef<HTMLElement>(null);
  const grown = !!origin && !instant;
  // 以落点为基准的几何：盒里的位置 G、刚越过盒口的位置 U、落点 F。transform-origin 为中心。
  const path = () => {
    const el = card.current; if (!el || !origin) return null;
    const F = el.getBoundingClientRect(), G = origin.slip;
    const fx = F.left + F.width / 2, fy = F.top + F.height / 2;
    const pose = (cx: number, cy: number, sx: number, sy: number, rot: number, opacity: number) =>
      ({ transform: `translate(${cx - fx}px, ${cy - fy}px) rotate(${rot}deg) scale(${sx}, ${sy})`, opacity });
    const gx = G.left + G.width / 2, gy = G.top + G.height / 2, ks = G.width / F.width, kh = G.height / F.height;
    // 越过盒口：上缘提到盒口以上；档案盒靠近屏幕上缘时提不了那么高，就改为同时放大（朝观者拿出来），上缘不出屏幕。
    const lifted = 1.16, clearY = Math.max(origin.lip - G.height * lifted / 2 - 12, G.height * lifted / 2 + 14);
    if (lipLight.current) Object.assign(lipLight.current.style, { left: `${G.left - F.left - 6}px`, top: `${origin.lip - F.top - 1}px`, width: `${G.width + 12}px` });
    return {
      inBox: pose(gx, gy, ks, kh, 0, .3),
      grabbed: pose(gx, gy - G.height * .16, ks, kh, 0, .55),
      cleared: pose(gx, clearY, ks * lifted, kh * lifted, -1.5, 1),
      over: pose(fx, fy - 12, 1.015, 1.015, 1.2, 1),
      rest: pose(fx, fy, 1, 1, 0, 1),
    };
  };
  useLayoutEffect(() => {
    if (!grown) return;
    const p = path(); if (!p || !card.current) return;
    // 取出：捏住上缘（提起一点）→ 竖直提出盒口 → 沿弧线落到右边、略过一点 → 摆正。
    const a = card.current.animate([
      { ...p.inBox, easing: 'cubic-bezier(.3,.7,.4,1)' },
      { ...p.grabbed, offset: .16, easing: 'cubic-bezier(.5,0,.3,1)' },
      { ...p.cleared, offset: .42, easing: 'cubic-bezier(.45,0,.2,1)' },
      { ...p.over, offset: .84, easing: 'cubic-bezier(.4,0,.3,1)' },
      { ...p.rest, offset: 1 },
    ], { duration: 1100, fill: 'both' });
    const b = lipLight.current?.animate([{ opacity: 0, transform: 'scaleX(.2)' }, { opacity: 1, transform: 'scaleX(1)', offset: .14 }, { opacity: 1, offset: .38 }, { opacity: 0 }], { duration: 1100, easing: 'ease-out', fill: 'both' });
    return () => { a.cancel(); b?.cancel(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 抽出后把焦点交给「继续工作」：原来的 ACCESS FILE 按钮已卸下，焦点不落回 body，Esc 与回车都能直接用。
  useEffect(() => { card.current?.querySelector<HTMLButtonElement>('.fp-go')?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!closing || !card.current) return;
    // 放回：提起 → 沿弧线回到盒口上方 → 竖直落进盒里、淡成盒中那张。没有档案盒位置时向右淡出。
    const p = path();
    const a = p
      ? card.current.animate([{ ...p.rest, easing: 'cubic-bezier(.45,0,.25,1)' }, { ...p.cleared, offset: .5, easing: 'cubic-bezier(.5,0,.75,0)' }, { ...p.inBox, offset: 1 }], { duration: 580, fill: 'both' })
      : card.current.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(24px)', opacity: 0 }], { duration: 320, easing: 'cubic-bezier(.7,0,.84,0)', fill: 'both' });
    const b = p ? lipLight.current?.animate([{ opacity: 0 }, { opacity: 0, offset: .4 }, { opacity: 1, offset: .62 }, { opacity: 0 }], { duration: 580, fill: 'both' }) : undefined;
    return () => { a.cancel(); b?.cancel(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);
  const b = briefOf(workbench, index, summary);
  return (
    <div className="fp-pin">
      <i ref={lipLight} className="fp-lip" aria-hidden="true" />
      <article ref={card} className="fp" data-closing={closing} data-instant={instant || undefined} data-grown={grown || undefined} aria-label={`档案小票：${b.name}`}>
        <Ticket workbench={workbench} fileNo={fileNo} code={code} b={b} />
        <button className="fp-close" onClick={onBack} aria-label="关闭档案小票">×</button>
        {note && <p className="fp-note" role="status">{note}</p>}
        <div className="fp-actions">
          <button className="fp-go" onClick={onContinue}><span>{workbench.id === 'curriculum' ? '进入课程台' : '继续工作'}</span><ArrowRight size={14} /></button>
          <button className="fp-back" onClick={onBack} aria-label="返回 Files（Esc）"><ArrowLeft size={13} />放回 · ESC</button>
        </div>
        <i className="fp-barcode" aria-hidden="true" />
      </article>
    </div>
  );
}
