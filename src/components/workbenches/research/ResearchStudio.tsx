import {liveBackend} from '../../../data/research-live';
import { liveReadAdapter } from '../../../data/read-live';
import { liveInboxAdapter } from '../../../data/inbox-live';
import InboxHost from '../../inbox/InboxHost';
import { useMemo, useState } from 'react';
import type { BenchProps } from '../WorkbenchStudio';
import ReadMode from './read/ReadMode';
import ResearchBench from './ResearchBench';
import SwarmMode from './swarm/SwarmMode';

// 研究台的三种模式：精读（搞懂一篇论文）· 群研（几十个 agent 攻一个大问题）· 自研（对一个目标自动优化）。
// 模式之间一键串联：精读「派给群研 / 交给自研」后切过去，并带上任务。

type Mode = 'read' | 'swarm' | 'auto';
const MODES: { id: Mode; label: string; en: string }[] = [{ id: 'read', label: '精读', en: 'READ' }, { id: 'swarm', label: '群研', en: 'SWARM' }, { id: 'auto', label: '自研', en: 'AUTO' }];
const DEFAULT: Mode[] = ['read', 'swarm', 'auto', 'auto'];

export default function ResearchStudio(props:BenchProps){return liveBackend?<LiveReadStudio {...props}/>:<MockResearchStudio {...props}/>;}
function LiveReadStudio(props: BenchProps) {
  const adapter = useMemo(() => liveReadAdapter(), []);
  return <ReadMode {...props} adapter={adapter} modeSwitch={<InboxHost autoOpen adapter={liveInboxAdapter} />} onDispatch={adapter.dispatchUnavailable} />;
}
function MockResearchStudio(props: BenchProps) {
  const [mode, setMode] = useState<Mode>(() => DEFAULT[props.file] ?? 'read');
  const [inbox, setInbox] = useState<Record<Mode, string[]>>({ read: [], swarm: [], auto: [] });
  const switcher = <div className="rs-modes" role="group" aria-label="研究模式">
    <span className="rh-micro">MODE</span>
    {MODES.map(m => <button key={m.id} aria-pressed={m.id === mode} onClick={() => setMode(m.id)}><b>{m.en}</b>{m.label}{inbox[m.id].length ? <em>{inbox[m.id].length}</em> : null}</button>)}
  </div>;
  const dispatch = (to: 'swarm' | 'auto', text: string) => { setInbox(b => ({ ...b, [to]: [...b[to], text] })); setMode(to); };
  if (mode === 'read') return <ReadMode key="read" {...props} modeSwitch={switcher} onDispatch={dispatch} />;
  if (mode === 'auto') return <ResearchBench key="auto" {...props} modeSwitch={switcher} inbox={inbox.auto[inbox.auto.length - 1] ?? null} />;
  return <SwarmMode key="swarm" {...props} modeSwitch={switcher} question={inbox.swarm[inbox.swarm.length - 1] ?? null} onDispatch={dispatch} />;
}
