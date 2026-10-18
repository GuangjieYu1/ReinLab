import { useEffect, useRef, useState } from 'react';
import Logo from '../cinematic/WorkbenchLogo';
import { navigate } from '../../nav';
import { endTransit, subscribeTransit, type Transit } from './transitStore';
import { logoParts, type LogoPiece } from './logoParts';
import { fileBriefs } from './fileBriefs';
import './emblem-transit.css';

// 文档转场（Files ⇄ 工作台）
// 进入：打开档案盒（玻璃正面像柜门一样转开）→ 从盒内取出一张文档 → 文档移到中央（封面上的工作台标识动态绘制），纸面在身后升起
//      → 页内切换到工作台 → 标识按自身结构拆开：外圈落进顶栏，中央图形的各个部件分别飞向工作台的各个面板，
//        每个部件身后长出一张纸，铺成那块面板；黑色页眉成为顶栏。工作台不同，标识与面板不同，拆法也不同。
// 返回：同一条时间轴倒放，最后文档放回盒内、关上档案盒。

type R = { x: number; y: number; w: number; h: number };
const rectOf = (r: DOMRect): R => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixR = (a: R, b: R, t: number): R => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const ease = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const setPhase = (p: string | null) => { if (p) document.documentElement.dataset.transit = p; else delete document.documentElement.dataset.transit; };

// 文档的参考尺寸（CSS 中 .et-doc / .et-cover 的基础尺寸），运行时只做 transform。
// 文档与档案盒同比例（500 : 370），大小也与档案盒在画面里相当。
const DOC_W = 680, DOC_H = 503, HEAD = 64, EMBLEM = 250;
const docScale = () => Math.min(1, (window.innerWidth * .47) / DOC_W, (window.innerHeight * .74) / DOC_H);
const centreDoc = (): R => { const k = docScale(); return { x: window.innerWidth / 2 - DOC_W * k / 2, y: window.innerHeight / 2 - DOC_H * k / 2, w: DOC_W * k, h: DOC_H * k }; };
const headOf = (d: R): R => ({ x: d.x, y: d.y, w: d.w, h: HEAD * d.w / DOC_W });
const bodyOf = (d: R): R => { const hh = HEAD * d.w / DOC_W, m = 10 * d.w / DOC_W; return { x: d.x + m, y: d.y + hh + m, w: d.w - 2 * m, h: d.h - hh - 2 * m }; };
const emblemOf = (d: R): R => { const k = d.w / DOC_W; return { x: d.x + 56 * k, y: d.y + 160 * k, w: EMBLEM * k, h: EMBLEM * k }; };
/** 标识里的一个部件在屏幕上的位置：e 是标识（含 12% 留白的圆底）的矩形，部件坐标为 320×320 标识坐标。 */
const pieceIn = (e: R, p: LogoPiece): R => { const k = e.w * .76 / 320, ox = e.x + e.w * .12, oy = e.y + e.h * .12; return { x: ox + p.box.x * k, y: oy + p.box.y * k, w: p.box.w * k, h: p.box.h * k }; };
/** 部件落到面板中央时的大小：保持比例，约为面板短边的四成。 */
const landIn = (t: R, p: LogoPiece): R => { const k = Math.min(t.w, t.h) * .4 / Math.max(p.box.w, p.box.h); return { x: t.x + t.w / 2 - p.box.w * k / 2, y: t.y + t.h / 2 - p.box.h * k / 2, w: p.box.w * k, h: p.box.h * k }; };
/** 拆开的第一下：部件从标识中心向外散开一点。 */
const spread = (r: R, e: R, p: number): R => { const cx = e.x + e.w / 2, cy = e.y + e.h / 2, k = .28 * p; return { ...r, x: r.x + (r.x + r.w / 2 - cx) * k, y: r.y + (r.y + r.h / 2 - cy) * k }; };

/** 工作台上的面板（文档里的每一层纸各对应一块）。 */
function panels(): R[] {
  // 工作台可以用 data-wb-panel 标出自己的主要模块（例如工程台的目录 / 编辑区 / 助手），标识就按这些模块拆开。
  const marked = [...document.querySelectorAll('[data-wb-panel]')].map(e => rectOf(e.getBoundingClientRect())).filter(r => r.w > 40 && r.h > 30);
  if (marked.length) return marked.slice(0, 6);
  const body = document.querySelector('.wb-body');
  if (!body) return [];
  return [...body.querySelectorAll(':scope > * > *')].map(e => rectOf(e.getBoundingClientRect())).filter(r => r.w > 120 && r.h > 30).slice(0, 6);
}
type Slot = { box: R };
/** 档案盒（选中、已抽出的那一只）在屏幕上的范围；以盒内机芯为准，开门时它不随门转动。 */
function slot(): Slot | null {
  const el = document.querySelector('.cine-cassette.selected .cassette-mechanism') ?? document.querySelector('.cine-cassette.selected .cassette-front');
  const r = el?.getBoundingClientRect();
  return r && r.width > 8 ? { box: rectOf(r) } : null;
}
const fallbackSlot = (): Slot => ({ box: { x: window.innerWidth * .25, y: window.innerHeight * .2, w: 280, h: 520 } });
/** 盒内的文档：与档案盒同比例，几乎填满盒子。 */
function inBox(s: Slot): R {
  const w = Math.min(s.box.w * .94, s.box.h * .94 * DOC_W / DOC_H), h = w * DOC_H / DOC_W;
  return { x: s.box.x + s.box.w / 2 - w / 2, y: s.box.y + s.box.h / 2 - h / 2, w, h };
}
/** 刚从盒内取出、被提起的文档：向前（略放大）并向上、向右提起。 */
function lifted(s: Slot): R {
  const r = inBox(s), k = 1.06;
  return { x: r.x + r.w / 2 - r.w * k / 2 + r.w * .05, y: r.y - r.h * .08, w: r.w * k, h: r.h * k };
}
const setCassette = (open: boolean) => { if (open) document.documentElement.dataset.cassette = 'open'; else delete document.documentElement.dataset.cassette; };

export default function EmblemTransit() {
  const [transit, setTransit] = useState<Transit | null>(null);
  // 动画进行中不触发 React 渲染：阶段直接写到根元素属性上，纸层预先放好 6 层（用不到的保持隐藏）。
  const root = useRef<HTMLDivElement>(null);
  const setStage = (v: string) => { if (root.current) root.current.dataset.stage = v; };
  const veil = useRef<HTMLDivElement>(null), frameEl = useRef<HTMLDivElement>(null), cover = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null), emblem = useRef<HTMLDivElement>(null), sheets = useRef<(HTMLDivElement | null)[]>([]);
  const partsHost = useRef<HTMLDivElement>(null), docGroup = useRef<HTMLDivElement>(null), shadow = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeTransit(setTransit), []);

  useEffect(() => {
    if (!transit) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      navigate(transit.target); const id = window.setTimeout(endTransit, 60); return () => clearTimeout(id);
    }
    let frame = 0, cancelled = false;
    // 无文字的元素（文档底框、黑色页眉、层层纸）基础尺寸 100×100，非等比缩放到任意矩形；
    // 有文字的元素（封面、标识）按文档宽度等比缩放，文字不会被拉伸。
    // clipLeft：槽口左侧（盒内）的部分裁掉，按元素自身宽度的比例。
    const fit = (el: HTMLElement | null, r: R, opacity = 1, clipLeft = 0) => {
      if (!el) return;
      el.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.w / 100}, ${r.h / 100})`;
      el.style.opacity = String(opacity); el.style.clipPath = clipLeft > 0 ? `inset(0 0 0 ${clipLeft * 100}%)` : '';
    };
    // 预先设为目标尺寸的元素：按自身尺寸缩放（展开前就以真实大小栅格化，飞行中只缩放不重绘）。
    const sized = (el: HTMLElement | null, r: R, opacity = 1) => {
      if (!el) return;
      const bw = parseFloat(el.style.width) || 100, bh = parseFloat(el.style.height) || 100;
      el.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.w / bw}, ${r.h / bh})`;
      el.style.opacity = String(opacity);
    };
    const presize = (el: HTMLElement | null, r: R) => { if (el) { el.style.width = `${r.w}px`; el.style.height = `${r.h}px`; } };
    const uni = (el: HTMLElement | null, r: R, base: number, opacity = 1, clipLeft = 0) => {
      if (!el) return;
      el.style.transform = `translate(${r.x}px, ${r.y}px) scale(${r.w / base})`;
      el.style.opacity = String(opacity); el.style.clipPath = clipLeft > 0 ? `inset(0 0 0 ${clipLeft * 100}%)` : '';
    };
    const setVeil = (o: number) => { if (veil.current) veil.current.style.opacity = String(o); };
    // 拆开的标识：外圈 + 各组部件，命令式地放进 partsHost（不触发 React 渲染）。部件图像以标识坐标 1:1 的像素尺寸栅格化。
    let ring: LogoPiece | null = null, pieces: LogoPiece[] = [];
    let ringEl: HTMLImageElement | null = null, pieceEls: HTMLImageElement[] = [];
    const buildParts = (count: number) => {
      const host = partsHost.current, parts = logoParts(transit.workbench.logo, count);
      if (!host || !parts) return;
      const make = (p: LogoPiece) => { const img = new Image(); img.src = p.src; img.alt = ''; img.decoding = 'sync'; img.style.width = `${p.box.w}px`; img.style.height = `${p.box.h}px`; img.style.opacity = '0'; host.appendChild(img); return img; };
      ring = parts.ring; pieces = parts.pieces; ringEl = make(ring); pieceEls = pieces.map(make);
    };
    const placePiece = (el: HTMLElement | null, p: LogoPiece | null, r: R, opacity: number) => { if (el && p) uni(el, r, p.box.w, opacity); };
    // 部件在标识里的原位（拼成完整标识）。
    const placeParts = (e: R, opacity: number) => { placePiece(ringEl, ring, ring ? pieceIn(e, ring) : e, opacity); pieces.forEach((p, i) => placePiece(pieceEls[i], p, pieceIn(e, p), opacity)); };
    const setDisc = (o: number) => { const d = emblem.current?.firstElementChild as HTMLElement | null; if (d) d.style.setProperty('--disc', String(o)); };
    let showParts = false; // 返回时标识以拆开的部件出现，一路随文档移动
    // 整张文档（底框 + 页眉 + 封面 + 标识）摆到矩形 d。
    const placeDoc = (d: R, o: { cover?: number; frame?: number } = {}) => {
      const e = emblemOf(d), hd = headOf(d);
      fit(frameEl.current, d, o.frame ?? 1);
      fit(head.current, hd, o.frame ?? 1);
      uni(cover.current, d, DOC_W, o.cover ?? 1);
      uni(emblem.current, e, EMBLEM, o.cover ?? 1);
      if (showParts) placeParts(e, o.cover ?? 1);
    };
    // 取出 / 放回时整张文档绕下缘前倾（上缘朝观者），像被捏住上缘从盒里拉出来；身下有一片随之出现、淡去的阴影。
    const tilt = (d: R, k: number) => {
      const g = docGroup.current; if (!g) return;
      if (Math.abs(k) < .001) { g.style.transform = ''; return; }
      g.style.transformOrigin = `${d.x + d.w / 2}px ${d.y + d.h}px`;
      g.style.transform = `perspective(1400px) rotateX(${-13 * k}deg) rotateY(${5 * k}deg)`;
    };
    const shade = (d: R, o: number) => fit(shadow.current, { x: d.x - d.w * .05, y: d.y + d.h * .8, w: d.w * 1.1, h: d.h * .38 }, o);
    const stack = (body: R, i: number): R => ({ x: body.x + i * 3, y: body.y + i * 3, w: body.w - 6, h: body.h - 6 });
    const t0 = performance.now();

    if (transit.direction === 'enter') {
      const s0 = slot() ?? fallbackSlot(); // 开门前量好档案盒
      let navigated = false, unfoldAt = 0, prepared = false, targets: R[] = [], bar: R | null = null, crumb: R | null = null;
      const startDoc = centreDoc(), E = emblemOf(startDoc);
      setPhase('leaving'); setStage('open'); setCassette(true);
      sheets.current.forEach(s => s && (s.style.opacity = '0'));
      const tick = (now: number) => {
        if (cancelled) return;
        const t = now - t0;
        if (t < 520) {
          // 1. 开盒：玻璃正面像柜门一样以左边为轴转开（CSS 过渡），文档还在盒内，尚未出现。
          placeDoc(inBox(s0), { frame: 0, cover: 0 }); shade(inBox(s0), 0);
        } else if (t < 1300) {
          // 2. 取出：文档在盒内显现 → 上缘向前倾、被拉出盒子并提起，身下的阴影随之出现 → 离开盒子后放平。封面上的标识从这一刻开始绘制。
          const p = clamp((t - 520) / 780), bell = Math.sin(Math.PI * p), d = mixR(inBox(s0), lifted(s0), easeOut(p));
          placeDoc(d, { frame: clamp((t - 520) / 160), cover: clamp((t - 580) / 220) });
          tilt(d, bell); shade(d, .5 * bell * clamp((t - 520) / 200));
        } else if (t < 1860) {
          // 3. 移到中央并放大；纸面在身后升起盖住 Files。
          if (t - 1300 < 40) { tilt(startDoc, 0); shade(startDoc, 0); }
          placeDoc(mixR(lifted(s0), startDoc, ease((t - 1300) / 560)));
          setVeil(clamp((t - 1340) / 440));
        } else if (!unfoldAt) {
          // 4. 中央停留：标识画完；页内切换到工作台，等它的面板就位。
          if (!prepared) placeDoc(startDoc); setVeil(1);
          if (!navigated) { navigated = true; setStage('hold'); setPhase('hold'); setCassette(false); navigate(transit.target); }
          if (!prepared) {
            const found = panels(), barEl = document.querySelector('[data-wb-bar]');
            if (found.length && barEl) {
              // 工作台已在纸面下挂好：按面板数拆开标识；每层纸设为目标面板的真实尺寸，叠在文档底框下方（被遮住），趁画面静止时完成栅格化。
              targets = found; bar = rectOf(barEl.getBoundingClientRect());
              const c = document.querySelector('.wb-crumb-logo'); crumb = c ? rectOf(c.getBoundingClientRect()) : null;
              buildParts(targets.length);
              const body = bodyOf(startDoc);
              targets.forEach((to, i) => { presize(sheets.current[i], to); sized(sheets.current[i], stack(body, i), 0); });
              presize(head.current, bar); sized(head.current, headOf(startDoc), 1);
              placeParts(E, 0);
              prepared = true;
            }
          }
          if ((t > 2650 && prepared) || t > 4500) {
            if (!prepared) { targets = [{ x: 8, y: 52, w: window.innerWidth - 16, h: window.innerHeight - 60 }]; bar = { x: 0, y: 0, w: window.innerWidth, h: 44 }; }
            unfoldAt = now; setStage('unfold'); // 不改 <html> 的 data-transit：hold 与展开期对工作台的样式要求相同，避免整页样式重算
          }
        } else {
          // 5. 拆解：完整标识换成同位置的部件 → 部件向外散开 → 外圈落进顶栏，各组部件飞向各自的面板，
          //    纸从部件身后长出、铺满面板；部件落定后淡去，真实面板在原位显现。
          const u = now - unfoldAt, body = bodyOf(startDoc), fade = u > 1060 ? 1 - clamp((u - 1060) / 300) : 1;
          const burst = easeOut(clamp(u / 260));
          uni(cover.current, startDoc, DOC_W, 1 - clamp(u / 200));
          fit(frameEl.current, startDoc, 1 - clamp((u - 160) / 200));
          if (pieces.length) {
            uni(emblem.current, E, EMBLEM, 1); setDisc(1 - clamp(u / 160));
            emblem.current?.querySelector('img')?.style.setProperty('opacity', '0');
          }
          targets.forEach((to, i) => {
            const p = pieces[i], start = p ? spread(pieceIn(E, p), E, burst) : stack(body, i);
            const k = ease(clamp((u - 200 - i * 80) / 700));
            sized(sheets.current[i], mixR(start, to, k), (p ? clamp(k / .25) : 1) * fade);
            if (p) placePiece(pieceEls[i], p, mixR(start, landIn(to, p), k), 1 - clamp((k - .7) / .3));
          });
          if (bar) sized(head.current, mixR(headOf(startDoc), bar, ease(clamp((u - 80) / 640))), fade);
          if (ring && crumb) {
            const k = ease(clamp((u - 120) / 760));
            placePiece(ringEl, ring, mixR(pieceIn(E, ring), pieceIn({ x: crumb.x - crumb.w * .12 / .76, y: crumb.y - crumb.h * .12 / .76, w: crumb.w / .76, h: crumb.h / .76 }, ring), k), u > 880 ? 1 - clamp((u - 880) / 160) : 1);
          } else if (crumb) uni(emblem.current, mixR(E, crumb, ease(clamp((u - 60) / 720))), EMBLEM, u > 780 ? 1 - clamp((u - 780) / 160) : 1);
          if (u > 1060) { setPhase('settle'); setVeil(1 - clamp((u - 1060) / 300)); }
          if (u > 1380) { setPhase(null); endTransit(); return; }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    } else {
      // 返回：各面板收成标识的部件、飞回封面拼成标识，顶栏变回页眉 → 页内切回 Files → 文档放回打开的档案盒，关门。
      const from = panels(), barEl = document.querySelector('[data-wb-bar]'), crumbEl = document.querySelector('.wb-crumb-logo');
      const bar = barEl ? rectOf(barEl.getBoundingClientRect()) : { x: 0, y: 0, w: window.innerWidth, h: 44 };
      const crumb = crumbEl ? rectOf(crumbEl.getBoundingClientRect()) : null;
      const target = centreDoc(), body = bodyOf(target), E = emblemOf(target);
      buildParts(from.length);
      if (pieces.length) setDisc(0);
      setPhase('leaving'); setStage('fold');
      let navigated = false, carryAt = 0, s1: Slot | null = null;
      const n = from.length;
      const tick = (now: number) => {
        if (cancelled) return;
        const t = now - t0;
        if (t < 1150) {
          // 1. 收拢：面板在原位换成纸，依次缩成标识的部件，飞回封面拼合；外圈从顶栏回到标识；页眉归位，纸面升起。
          from.forEach((r, i) => {
            const p = pieces[i], home = p ? pieceIn(E, p) : stack(body, i);
            const k = ease(clamp((t - 120 - (n - 1 - i) * 70) / 700));
            fit(sheets.current[i], mixR(r, home, k), clamp(t / 140) * (p ? 1 - clamp((k - .7) / .3) : 1));
            if (p) placePiece(pieceEls[i], p, mixR(landIn(r, p), home, k), clamp((k - .05) / .3));
          });
          fit(head.current, mixR(bar, headOf(target), ease(clamp((t - 200) / 620))), clamp(t / 140));
          if (ring && crumb) placePiece(ringEl, ring, mixR(pieceIn({ x: crumb.x - crumb.w * .12 / .76, y: crumb.y - crumb.h * .12 / .76, w: crumb.w / .76, h: crumb.h / .76 }, ring), pieceIn(E, ring), ease(clamp((t - 160) / 760))), clamp(t / 120));
          else if (crumb) uni(emblem.current, mixR(crumb, E, ease(clamp((t - 160) / 660))), EMBLEM, 1);
          if (pieces.length) { uni(emblem.current, E, EMBLEM, 1); setDisc(clamp((t - 760) / 240)); }
          fit(frameEl.current, target, clamp((t - 720) / 240));
          uni(cover.current, target, DOC_W, clamp((t - 820) / 260));
          setVeil(clamp((t - 160) / 460));
        } else if (!carryAt) {
          showParts = pieces.length > 0;
          placeDoc(target); setVeil(1);
          sheets.current.forEach(s => s && (s.style.opacity = '0'));
          // 切回 Files 前先把档案盒设为「已打开」：Files 挂载时玻璃门就是开着的，等文档放回去再关上。
          if (!navigated) { navigated = true; setStage('hold'); setPhase('hold'); setCassette(true); navigate(transit.target); }
          s1 = slot();
          if ((t > 1450 && s1) || t > 3900) { carryAt = now; setStage('carry'); setPhase('arriving'); }
        } else {
          const u = now - carryAt, s = slot() ?? s1 ?? fallbackSlot();
          if (u < 620) {
            // 2. 文档回到打开的档案盒前（提起的位置），纸面退去露出 Files。
            placeDoc(mixR(target, lifted(s), ease(u / 620))); setVeil(1 - clamp(u / 500));
          } else if (u < 1160) {
            // 3. 放回盒内：向后、向下缩入，随之隐去。
            // 放回时同样前倾着送进盒子，阴影先出现再随文档没入盒中淡去。
            const p = ease(clamp((u - 620) / 540)), bell = Math.sin(Math.PI * p), d = mixR(lifted(s), inBox(s), p);
            placeDoc(d, { frame: 1 - clamp((p - .55) / .45), cover: 1 - clamp((p - .3) / .5) });
            tilt(d, bell); shade(d, .5 * bell * (1 - clamp((p - .6) / .4)));
            if (u > 1000) setCassette(false);
          } else if (u > 1760) {
            tilt(inBox(s), 0);
            // 4. 玻璃门关上之后，交还给 Files（小票从档案盒里抽出）。
            setPhase(null); endTransit(); return;
          } else { setCassette(false); }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }
    return () => { cancelled = true; cancelAnimationFrame(frame); setPhase(null); setCassette(false); partsHost.current?.replaceChildren(); };
  }, [transit]);

  if (!transit) return null;
  const { caption, workbench, direction } = transit;
  const last = fileBriefs[workbench.id]?.[workbench.files.indexOf(caption.name)]?.last;
  return (
    <div ref={root} className="et" data-stage="start" data-direction={direction} role="status" aria-live="polite" aria-label={`${direction === 'enter' ? '正在展开' : '正在归档'} ${caption.title} · ${caption.name}`}>
      <div ref={veil} className="et-veil" />
      {Array.from({ length: 6 }, (_, i) => <div key={i} ref={el => { sheets.current[i] = el; }} className="et-sheet" style={{ opacity: 0 }} />)}
      <div ref={shadow} className="et-shadow" style={{ opacity: 0 }} />
      <div ref={docGroup} className="et-doc">
      <div ref={frameEl} className="et-frame" />
      <div ref={head} className="et-head" />
      <div ref={cover} className="et-cover">
        <i className="et-crop" data-c="tl" /><i className="et-crop" data-c="tr" /><i className="et-crop" data-c="bl" /><i className="et-crop" data-c="br" />
        <div className="et-cover-head">
          <b>{caption.code}</b><span>FILE {caption.fileNo}</span>
          <em><i />RHINE LAB · INTERNAL DATABASE</em>
        </div>
        <div className="et-fig" aria-hidden="true">
          <span className="et-fig-label">FIG.01 — EMBLEM<small>{workbench.english}</small></span>
          <i className="et-fig-h" /><i className="et-fig-v" />
          <span className="et-fig-foot">Ø 250 · SECTION {workbench.code}</span>
        </div>
        <div className="et-cover-body">
          <span className="et-cover-eyebrow"><i />{workbench.fileKind} · {caption.title}</span>
          <span className="et-cover-title">{caption.name}</span>
          <span className="et-cover-file"><small>FILE</small>{caption.fileNo}</span>
          <dl className="et-cover-meta">
            <div><dt>SECTION</dt><dd>{caption.code}</dd></div>
            <div><dt>KIND</dt><dd>{workbench.fileKind}</dd></div>
            <div><dt>LAST</dt><dd>{last?.when ?? '—'}</dd></div>
          </dl>
          <div className="et-cover-last">
            <span>LAST SESSION</span><b>{last?.label ?? '尚未开始'}</b>
            {last && last.total > 0 && <span className="et-cover-rail">{Array.from({ length: last.total }, (_, k) => <i key={k} data-s={k < last.step ? 'done' : k === last.step ? 'now' : undefined} />)}</span>}
          </div>
        </div>
        <span className="et-stamp">{direction === 'enter' ? 'OPENING' : 'FILING'}<small>{caption.fileNo}</small></span>
        <div className="et-cover-foot">
          <i className="et-hazard" />
          <span>RHINE LAB · CONFIDENTIALITY: GENERAL BUSINESS USE</span>
          <i className="et-barcode" />
        </div>
      </div>
      <div ref={emblem} className="et-emblem"><div className="et-logo">{direction === 'enter' && <Logo key={transit.id} workbench={workbench} delay={480} startAt={.3} />}</div></div>
      <div ref={partsHost} className="et-parts" />
      </div>
    </div>
  );
}
