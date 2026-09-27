import { forwardRef, memo, useImperativeHandle, useRef } from 'react';
import { bootMotion } from './reference/boot-motion';

const contour = 'M295 73C295 41 273 15 240 15C221 15 207 23 192 38C186 43 181 47 176 52C127 96 103 128 70 128C38 128 15 101 15 70C15 39 37 15 70 15C103 15 127 48 156 75C182 99 208 128 240 128C273 128 295 105 295 73Z';
const round = (v: number) => Math.round(v * 1000) / 1000;
function arc(r: number, start: number, sweep: number, x = 960, y = 540) {
  const point = (a: number) => `${round(x + Math.cos(a) * r)},${round(y + Math.sin(a) * r)}`;
  if (sweep >= Math.PI * 1.999) return `M${point(start)}A${round(r)},${round(r)} 0 1 1 ${point(start + Math.PI)}A${round(r)},${round(r)} 0 1 1 ${point(start + Math.PI * 2)}`;
  return `M${point(start)}A${round(r)},${round(r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(start + sweep)}`;
}

export function RhineMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 310 185" fill="none" aria-hidden="true">
    <path pathLength={1} d="M156 75C127 48 103 15 70 15C37 15 15 39 15 70S38 128 70 128C103 128 127 96 176 52M155 75C182 99 208 128 240 128C273 128 295 105 295 73S273 15 240 15C221 15 207 23 192 38" stroke="currentColor" strokeWidth="26" />
    <path d="M44 70h50M69 45v50M219 70h44" stroke="currentColor" strokeWidth="15" />
    <text x="21" y="174" fill="currentColor" fontSize="16" fontWeight="600" letterSpacing="21">RHINE·LAB</text>
  </svg>;
}

export function CinematicBrand() {
  return <div className="cine-brand" aria-label="Rhine Lab Synthesize Information Analysis OS">
    <div data-brand-line="0">RHINE LAB</div><div data-brand-line="1">SYNTHESIZE INFORMATION</div>
    <div data-brand-line="2"><span>ANALYSIS</span><b>OS</b></div>
  </div>;
}

export type BootStageHandle = { update: (time: number, softFlashes: boolean, identity?: string) => void };

/** Stable DOM: continuous tracks sample every display frame; typing retains its reference cadence. */
const BootStage = memo(forwardRef<BootStageHandle>(function BootStage(_, ref) {
  const root = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement | SVGElement>());
  const last = useRef(new Map<string, string>());
  useImperativeHandle(ref, () => ({
    update(time, softFlashes, identity = 'LOCAL RESEARCHER') {
      if (!root.current) return;
      const get = (key: string) => {
        let node = nodes.current.get(key);
        if (!node) {
          const found = root.current!.querySelector<HTMLElement | SVGElement>(key);
          if (found) { node = found; nodes.current.set(key, node); }
        }
        return node;
      };
      const style = (key: string, prop: string, value: string | number) => {
        const id = `${key}:${prop}`, v = String(value);
        if (last.current.get(id) === v) return;
        get(key)?.style.setProperty(prop, v); last.current.set(id, v);
      };
      const attr = (key: string, name: string, value: string | number) => {
        const id = `${key}@${name}`, v = String(value);
        if (last.current.get(id) === v) return;
        get(key)?.setAttribute(name, v); last.current.set(id, v);
      };
      const text = (key: string, value: string) => {
        if (last.current.get(`${key}:text`) === value) return;
        const node = get(key); if (node) node.textContent = value;
        last.current.set(`${key}:text`, value);
      };
      const s = bootMotion(time, identity), scan = s.scan;
      if (root.current.dataset.phase !== s.step) root.current.dataset.phase = s.step;
      root.current.style.visibility = 'visible';
      text('.cine-access', s.access); style('.cine-access', 'opacity', s.accessOpacity);
      style('.cine-boot-background', 'opacity', s.backgroundOpacity);
      style('.cine-boot-background > svg', 'transform', `translate3d(${round(Math.sin(s.t * .16) * 18)}px,${round(-(s.t - 6) * 5)}px,0) scale(1.08)`);
      style('.cine-whiteout', 'opacity', round(s.white));
      s.brand.forEach((line, i) => {
        style(`[data-brand-line="${i}"]`, 'opacity', round(line.opacity));
        style(`[data-brand-line="${i}"]`, 'transform', `translate3d(${round(line.x)}px,0,0)`);
      });
      style('.cine-drawing-logo', 'opacity', s.logoOpacity);
      if (s.logoOpacity) {
        style('.cine-drawing-logo', 'transform', `translate3d(${round(s.logo.offsetX)}px,1px,0)`);
        attr('[data-part="contour"]', 'stroke-width', round(s.logo.strokeWidth));
        attr('[data-part="contour"]', 'stroke-dasharray', `${s.logo.length} ${1 - s.logo.length}`);
        attr('[data-part="contour"]', 'stroke-dashoffset', -s.logo.start);
        attr('[data-part="plus"]', 'transform', `translate(${s.logo.plusX} 70) rotate(${s.logo.plusAngle}) scale(${s.logo.symbolScale}) translate(-69 -70)`);
        attr('[data-part="minus"]', 'd', `M${-s.logo.minusWidth / 2} 0h${s.logo.minusWidth}`);
        attr('[data-part="minus"]', 'transform', `translate(${s.logo.minusX} 70) scale(${s.logo.symbolScale})`);
        text('[data-part="letters"]', s.logoLetters);
      }
      style('.cine-auth', 'opacity', s.authOpacity); text('[data-part="auth"]', s.auth);
      style('.cine-scan', 'display', s.scanVisible ? 'block' : 'none');
      if (s.scanVisible) {
        const ringScale = softFlashes && s.ringScale > 1 ? 1.1 : s.ringScale;
        attr('.cine-scan-group', 'transform', `translate(960 540) scale(${ringScale}) translate(-960 -540)`);
        attr('.cine-scan-group', 'opacity', softFlashes ? Math.max(.8, s.ringOpacity) : s.ringOpacity);
        const paths = [arc(scan.radius, scan.outerStart, scan.outerSweep), arc(scan.whiteRadius, scan.whiteStart, scan.whiteSweep), arc(scan.innerRadius, scan.innerStart, scan.innerSweep), arc(scan.innerRadius, scan.innerStart + Math.PI, scan.innerSweep), ...s.scanOrbit.sides.map(side => arc(side.radius, side.start, side.sweep, side.x, side.y))];
        paths.forEach((d, i) => attr(`[data-arc="${i}"]`, 'd', d));
        [4, 5].forEach(i => attr(`[data-arc="${i}"]`, 'opacity', s.scanOrbit.sideVisible ? 1 : 0));
        s.scanOrbit.satellites.forEach((p, i) => {
          attr(`[data-satellite="${i}"]`, 'cx', round(p.x)); attr(`[data-satellite="${i}"]`, 'cy', round(p.y)); attr(`[data-satellite="${i}"]`, 'r', round(p.radius));
        });
        [0, 1].forEach(i => {
          attr(`[data-orbit="${i}"]`, 'cx', round(960 + Math.cos(scan.orbit + i * Math.PI) * scan.orbitRadius));
          attr(`[data-orbit="${i}"]`, 'cy', round(540 + Math.sin(scan.orbit + i * Math.PI) * scan.orbitRadius));
          attr(`[data-orbit="${i}"]`, 'r', round(scan.dotRadius));
        });
        attr('[data-part="core"]', 'r', softFlashes ? Math.min(13, s.coreRadius) : s.coreRadius);
        attr('[data-part="core"]', 'opacity', s.ornament ? 1 : 0);
        const capAngles = [scan.outerStart + scan.outerSweep, scan.whiteStart];
        [scan.radius, scan.whiteRadius].forEach((radius, i) => {
          attr(`[data-cap="${i}"]`, 'cx', round(960 + Math.cos(capAngles[i]) * radius)); attr(`[data-cap="${i}"]`, 'cy', round(540 + Math.sin(capAngles[i]) * radius)); attr(`[data-cap="${i}"]`, 'r', i ? scan.whiteCap : scan.blackCap);
        });
        style('.cine-scan > span', 'opacity', s.permissionOpacity); style('.cine-scan > span', 'letter-spacing', `${round(s.scanTracking)}px`);
      }
      style('.cine-welcome', 'display', s.welcomeVisible ? 'block' : 'none');
      if (s.welcomeVisible) {
        style('.cine-welcome', 'opacity', round(s.welcomeOpacity)); style('.cine-welcome', 'transform', `scale(${s.welcomeScale})`);
        style('.cine-welcome', 'filter', s.exitBlur > .01 ? `blur(${round(s.exitBlur)}px)` : 'none');
        style('.cine-welcome-panel', 'opacity', softFlashes ? s.welcomePanel * .14 : s.welcomePanel);
        style('.cine-welcome-heading', 'color', softFlashes ? '#161914' : `rgb(${255 * (1 - s.welcomeInk)} ${255 * (1 - s.welcomeInk)} ${255 * (1 - s.welcomeInk)})`);
        style('.cine-company', 'opacity', s.companyVisible ? s.companyMask && !softFlashes ? .65 : 1 : 0);
        style('.cine-company-highlight', 'clip-path', `inset(0 ${round(100 * (1 - s.highlight))}% 0 0)`);
        style('.cine-database', 'opacity', s.databaseOpacity);
      }
      style('.cine-powered', 'opacity', s.poweredLetters > 0 ? 1 : 0);
      style('.cine-powered', 'clip-path', `inset(0 ${100 * (1 - s.poweredLetters / 19)}% 0 0)`);
    },
  }), []);
  return <div className="cine-boot-layer" ref={root} style={{ visibility: 'hidden' }} aria-hidden="true">
    <div className="cine-boot-background"><svg viewBox="0 0 1920 1080"><g fill="none" stroke="#fff" strokeWidth="3"><path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113" /><path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1692 666 1559 787S1329 886 1498 1130" /><circle cx="1450" cy="648" r="346" /><circle cx="1450" cy="648" r="348" /></g></svg><div className="cine-whiteout" /></div>
    <CinematicBrand /><div className="cine-access" />
    <div className="cine-drawing-logo"><svg viewBox="0 0 310 185" fill="none">
      <path data-part="contour" d={contour} pathLength={1} stroke="currentColor" /><path data-part="plus" d="M44 70h50M69 45v50" stroke="currentColor" strokeWidth="15" /><path data-part="minus" stroke="currentColor" strokeWidth="15" /><text data-part="letters" x="20" y="174" fill="currentColor" fontSize="16" fontWeight="600" letterSpacing="21" />
    </svg></div>
    <div className="cine-auth"><span>▪</span><span data-part="auth" /></div>
    <div className="cine-scan"><svg viewBox="0 0 1920 1080"><g className="cine-scan-group" fill="none" stroke="#080a08" strokeWidth="2" strokeLinecap="round">
      {Array.from({ length: 6 }, (_, i) => <path key={i} data-arc={i} stroke={i === 1 ? '#fff' : undefined} strokeWidth={i === 0 ? 2.4 : i === 1 ? 4 : 2} />)}
      {Array.from({ length: 6 }, (_, i) => <circle key={i} data-satellite={i} fill="#080a08" stroke="none" />)}
      {[0, 1].map(i => <circle key={i} data-orbit={i} fill="#d69c53" stroke="none" />)}
      <circle data-part="core" cx="959.5" cy="539.5" fill="#080a08" stroke="none" />
      {[0, 1].map(i => <circle key={i} data-cap={i} fill={i ? '#fff' : '#080a08'} stroke="none" />)}
    </g></svg><span>PERMISSION AUTHORIZED</span></div>
    <div className="cine-welcome"><div className="cine-welcome-panel" /><div className="cine-welcome-heading">WELCOME TO</div><div className="cine-company"><strong>RHINE LAB.LLC.</strong><strong className="cine-company-highlight">RHINE LAB.LLC.</strong></div><div className="cine-database">INTERNAL DATABASE</div><RhineMark className="cine-welcome-logo" /></div>
    <div className="cine-powered">POWERED BY <b>RHINE LAB</b><i /></div>
  </div>;
}));
export default BootStage;
