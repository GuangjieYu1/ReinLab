import { useEffect, useMemo, useState } from 'react';
import { type EntryWorkbench } from './entryWorkbenches';

export default function WorkbenchLogo({ workbench, still = false, startAt = 0, delay = 0 }: { workbench: EntryWorkbench; still?: boolean; startAt?: number; delay?: number }) {
  const [phase, setPhase] = useState<'waiting' | 'playing' | 'held'>(still ? 'held' : delay ? 'waiting' : 'playing');
  const source = useMemo(() => {
    const held = workbench.logo.replace('</style>', '.rhine-mark .motion{display:none}.rhine-mark .still{display:inline}</style>');
    const playing = workbench.logo.replace(/<(animate(?:Transform|Motion)?)\s/g, `<$1 begin="-${startAt}s" `);
    return { held: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(held)}`, playing: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(playing)}` };
  }, [workbench, startAt]);
  useEffect(() => {
    if (still) { setPhase('held'); return; }
    setPhase(delay ? 'waiting' : 'playing');
    const start = setTimeout(() => setPhase('playing'), delay);
    const hold = setTimeout(() => setPhase('held'), delay + Math.max(0, 4.8 - startAt) * 1000);
    return () => { clearTimeout(start); clearTimeout(hold); };
  }, [workbench, still, startAt, delay]);
  // Image documents isolate SVG animation and styles from the rotating selector.
  return <div className="entry-logo" data-animation={still?'held':phase} aria-hidden="true">{phase !== 'waiting' && <img src={still || phase === 'held' ? source.held : source.playing} alt="" draggable={false}/>}</div>;
}
