import { useState } from 'react';
import type { BenchProps } from '../WorkbenchStudio';
import ReadMode from './read/ReadMode';
import ResearchBench from './ResearchBench';
import SwarmMode from './swarm/SwarmMode';

// 研究台的三种模式：精读（搞懂一篇论文）· 群研（几十个 agent 攻一个大问题）· 自研（对一个目标自动优化）。
// 模式之间一键串联：精读「派给群研 / 交给自研」后切过去，并带上任务。

type Mode = 'read' | 'swarm' | 'auto';
const MODES: { id: Mode; label: string; en: string }[] = [{ id: 'read', label: '精读', en: 'READ' }, { id: 'swarm', label: '群研', en: 'SWARM' }, { id: 'auto', label: '自研', en: 'AUTO' }];
const DEFAULT: Mode[] = ['read', 'swarm', 'auto', 'auto'];
/** 真实模式下还没接后端的模式：入口保留但置灰，标出在哪一期接入，点不进去（避免 live 下显示示例数据）。 */
const LATER: Record<Mode, string> = { read: '', swarm: '第三期', auto: '第一期末' };

/** available：可进入的模式。mock 不传（三个都可用）；live 传入已接后端的模式，例如 ['read']。 */
export default function ResearchStudio(props: BenchProps & { available?: Mode[] }) {
  // 预览用：?modes=read 模拟「真实模式只接了精读」
  const available = props.available ?? (new URLSearchParams(location.search).get('modes')?.split(',') as Mode[] | undefined);
  const ok = (m: Mode) => !available || available.includes(m);
  const [mode, setMode] = useState<Mode>(() => { const d = DEFAULT[props.file] ?? 'read'; return ok(d) ? d : 'read'; });
  const [inbox, setInbox] = useState<Record<Mode, string[]>>({ read: [], swarm: [], auto: [] });
  const switcher = <div className="rs-modes" role="group" aria-label="研究模式">
    <span className="rh-micro">MODE</span>
    {MODES.map(m => ok(m.id)
      ? <button key={m.id} aria-pressed={m.id === mode} onClick={() => setMode(m.id)}><b>{m.en}</b>{m.label}{inbox[m.id].length ? <em>{inbox[m.id].length}</em> : null}</button>
      : <button key={m.id} aria-pressed={false} aria-disabled="true" data-later title={`真实模式下${m.label}将在${LATER[m.id]}接入`} onClick={e => e.preventDefault()}><b>{m.en}</b>{m.label}<small>{LATER[m.id]}</small></button>)}
  </div>;
  // 派给未接入的模式时，只记下待办、不切过去
  const dispatch = (to: 'swarm' | 'auto', text: string) => { setInbox(b => ({ ...b, [to]: [...b[to], text] })); if (ok(to)) setMode(to); };
  if (mode === 'read') return <ReadMode key="read" {...props} modeSwitch={switcher} onDispatch={dispatch} />;
  if (mode === 'auto') return <ResearchBench key="auto" {...props} modeSwitch={switcher} inbox={inbox.auto[inbox.auto.length - 1] ?? null} />;
  return <SwarmMode key="swarm" {...props} modeSwitch={switcher} question={inbox.swarm[inbox.swarm.length - 1] ?? null} onDispatch={dispatch} />;
}
