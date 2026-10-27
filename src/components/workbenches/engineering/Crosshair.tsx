import { useEffect, useRef } from 'react';

// 十字准星：鼠标在网格画布上移动时，一对跟随的细线与坐标读数（只改 transform，不触发重排）。
export default function Crosshair({ unit = 'px' }: { unit?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current, host = el?.parentElement; if (!el || !host) return;
    const h = el.querySelector<HTMLElement>('.xh-h')!, v = el.querySelector<HTMLElement>('.xh-v')!, tag = el.querySelector<HTMLElement>('.xh-tag')!;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = host.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        h.style.transform = `translateY(${y}px)`; v.style.transform = `translateX(${x}px)`;
        tag.style.transform = `translate(${x + 10}px, ${y + 10}px)`;
        tag.textContent = `X ${String(Math.round(x)).padStart(4, '0')} · Y ${String(Math.round(y)).padStart(4, '0')} ${unit}`;
        el.dataset.on = '';
      });
    };
    const leave = () => { delete el.dataset.on; };
    host.addEventListener('pointermove', move); host.addEventListener('pointerleave', leave);
    return () => { cancelAnimationFrame(raf); host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave); };
  }, [unit]);
  return <div className="xh" ref={root} aria-hidden="true"><i className="xh-h" /><i className="xh-v" /><span className="xh-tag" /></div>;
}
