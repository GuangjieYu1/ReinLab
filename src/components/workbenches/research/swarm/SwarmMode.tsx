import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BenchFrame from '../../BenchFrame';
import { scrollWithin } from '../../scrollWithin';
import AgentDock, { type DockDraft, type DockEvent, type Suggestion } from '../../AgentDock';
import Explorer, { type ExplorerSection, type ExplorerView } from '../../engineering/Explorer';
import type { BenchChrome } from '../../WorkbenchStudio';
import { AGENTS, DURATION, MSG, ROLES, SCRIPT, SUBS, TASKS, agent, stateAt, type Msg, type MsgType, type Post, type Role, type TaskStatus } from './swarmModel';
import '../../engineering/dev.css';
import './swarm.css';

// 研究台 · 群研模式：几十个 agent 分头攻一个大问题，通信是主角。
// 整个状态只由「当前时刻」推出（任务进度、谁在干什么、留言板），所以底部时间轴可以暂停、拖动、回放。
// 01 任务树 · 02 通信（星座 + 消息流 + 协议说明）· 03 留言板（你可以插话、@ 某个 agent）· 04 汇总。全部为前端示例剧本。

type Face = 'tree' | 'bus' | 'board' | 'synth';
const STATUS_ZH: Record<TaskStatus, string> = { open: '开放', doing: '进行中', done: '完成', failed: '失败路径', limit: '降级为局限' };
const ORDER: Role[] = ['plan', 'scout', 'read', 'analyst', 'critic', 'verify', 'synth'];
const clock = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ts = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let seq = 0; const uid = () => `w${++seq}`;

/** 星座里的位置：总负责人居中，留言板在下方，其余按角色分区排成一圈。 */
const POS: Record<string, [number, number]> = (() => {
  const out: Record<string, [number, number]> = { L: [50, 46], board: [50, 74] };
  const ring = AGENTS.filter(a => a.role !== 'lead').sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));
  ring.forEach((a, i) => { const ang = -Math.PI / 2 + (i / ring.length) * Math.PI * 2; out[a.id] = [50 + Math.cos(ang) * 42, 48 + Math.sin(ang) * 40]; });
  return out;
})();

export default function SwarmMode({ file, reduced, chrome, modeSwitch, question, onDispatch }: {
  file: number; reduced: boolean; chrome: BenchChrome; modeSwitch: ReactNode; question?: string | null; onDispatch: (to: 'auto', text: string) => void;
}) {
  const [face, setFace] = useState<Face>('bus');
  const [msgs, setMsgs] = useState<Msg[]>(SCRIPT);
  const [now, setNow] = useState(reduced ? DURATION : 0);
  const [playing, setPlaying] = useState(!reduced);
  const [speed, setSpeed] = useState(1);
  const [selAgent, setSelAgent] = useState<string | null>(null);
  const [selMsg, setSelMsg] = useState<string | null>(null);
  const [events, setEvents] = useState<DockEvent[]>(() => [{ id: uid(), kind: 'agent', at: clock(), text: <p>我是总负责人。{question ? <>收到精读派来的问题：<b>{question}</b>。</> : null}32 个 agent 已就位，正在拆题。去「通信」看我们怎么互相传话；底部时间轴可以随时暂停、拖回去重看。</p> }]);
  const end = Math.max(DURATION, ...msgs.map(x => x.t + 2));
  // 时间引擎：播放时按帧推进 now（只在播放时运行）。
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (t: number) => { const dt = (t - last) / 1000; last = t; setNow(v => { const nv = v + dt * speed; if (nv >= end) { setPlaying(false); return end; } return nv; }); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);
  const st = useMemo(() => stateAt(now, msgs), [now, msgs]);
  const push = (e: DockDraft) => { const id = e.id ?? uid(); setEvents(l => [...l, { ...e, id } as DockEvent]); };
  /** 你在留言板 / 对话里下的指令：变成剧本里的新消息（从当前时刻往后排）。 */
  const inject = (text: string, by = 'YOU') => {
    const mention = text.match(/@([A-Z]\d{0,2})/)?.[1], to = mention && agent(mention) ? mention : 'L';
    const t = now;
    const add: Msg[] = [
      { id: uid(), t: t + .05, from: by, to: 'board', type: to === 'L' ? 'help' : 'ask', text, post: 'question' },
      { id: uid(), t: t + 1.2, from: to, to: 'board', type: 'claim', text: `收到，我来处理：「${text.replace(/@\S+\s*/, '').slice(0, 28)}」` },
      { id: uid(), t: t + 3.4, from: to, to: 'board', type: 'deliver', text: /停|暂停/.test(text) ? '已暂停我手上的任务。' : /反例|反驳/.test(text) ? '找到一个反例：线性注意力在「大海捞针」式检索里明显落后，已补进局限。' : '已补充：这一点放进汇总的「待确认」里，并请核实组复核。', post: 'finding' },
    ];
    setMsgs(l => [...l, ...add].sort((a, b) => a.t - b.t));
    if (!playing && now < end) setPlaying(true);
    return to;
  };
  const onSend = (text: string) => {
    push({ kind: 'user', text, at: clock() });
    if (/暂停|停一下/.test(text)) { setPlaying(false); push({ kind: 'agent', at: clock(), text: <p>全体暂停在 {ts(now)}。</p> }); return; }
    const to = inject(text);
    push({ kind: 'agent', at: clock(), text: <p>已转到留言板，由 <b>{agent(to)?.name ?? to}</b> 接手。去「留言板」看它的回复。</p> });
  };
  const suggestions: Suggestion[] = [
    playing ? { id: 'p', label: '全体暂停', onClick: () => setPlaying(false) } : { id: 'r', label: now >= end ? '从头回放' : '继续', onClick: () => { if (now >= end) setNow(0); setPlaying(true); } },
    { id: 'c', label: '@C01 给线性注意力找反例', onClick: () => onSend('@C01 给线性注意力找一个反例') },
    { id: 'a', label: '交给自研：长文本速度对比', onClick: () => onDispatch('auto', '8k 长度下 FlashAttention 与线性注意力的速度 / 显存对比') },
  ];

  const working = Object.entries(st.busy).filter(([, b]) => now - b.t < 3).length;
  const done = TASKS.filter(t => st.status[t.id] === 'done').length;
  const [xpOpen, setXpOpen] = useState(true), [xpView, setXpView] = useState<ExplorerView>('files');
  const sections: ExplorerSection[] = [{ id: 'agents', title: `agent · ${AGENTS.length}`, count: working, grow: true, body: <div className="sw-roster">
    {(['lead', ...ORDER] as Role[]).map(r => <div key={r} className="sw-roster-group"><span className="rh-micro">{ROLES[r].en} · {ROLES[r].zh}</span>
      {AGENTS.filter(a => a.role === r).map(a => { const b = st.busy[a.id], live = b && now - b.t < 3; return <button key={a.id} aria-current={selAgent === a.id || undefined} data-live={live || undefined} onClick={() => setSelAgent(s => s === a.id ? null : a.id)}>
        <em>{a.id}</em><span>{live ? `${MSG[b.type].zh}${b.task ? ` · ${b.task}` : ''}` : b ? '空闲' : '待命'}</span><i /></button>; })}</div>)}
  </div> }];

  const bar = <header className="dv-bar sw-bar" data-busy={playing || undefined}>
    <div className="dv-bar-id"><b>SWARM</b><small>群研<br />{AGENTS.length} AGENTS</small></div>
    <div className="sw-q"><small>QUESTION · 根问题</small><strong title={question ?? TASKS[0].title}>{question ?? TASKS[0].title}</strong></div>
    <div className="sw-nums"><span><b>{String(working).padStart(2, '0')}</b><small>工作中</small></span><span><b>{String(st.seen.length).padStart(3, '0')}</b><small>消息</small></span><span><b>{String(done).padStart(2, '0')}</b><small>/ {TASKS.length} 任务完成</small></span></div>
  </header>;
  const timeline = <TimeBar now={now} end={end} playing={playing} speed={speed} msgs={msgs} onPlay={() => { if (now >= end) setNow(0); setPlaying(v => !v); }} onSeek={t => setNow(t)} onSpeed={() => setSpeed(s => s === 4 ? 1 : s * 2)} />;

  return <BenchFrame code="RSCH" section="002" file={file} reduced={reduced} chrome={chrome} face={face} onFace={id => { if (id === 'synth' && st.status.ROOT !== 'done') { setFace('tree'); return; } setFace(id as Face); }} tools={modeSwitch}
    faces={[{ id: 'tree', label: '任务树', en: 'TASKS', badge: done }, { id: 'bus', label: '通信', en: 'BUS', badge: st.seen.length }, { id: 'board', label: '留言板', en: 'BOARD', badge: st.posts.length }, { id: 'synth', label: '汇总', en: 'SYNTHESIS', locked: st.status.ROOT !== 'done' }]}
    strip={<>SWARM <i>·</i> T {ts(now)} <i>·</i> ×{speed}</>}
    shutterLines={f => [`> face · ${f.en.toLowerCase()}`, `> replay bus · ${st.seen.length} messages`, '> ready']}
    status={<><span><i className="en-sq" />群研</span><span>{AGENTS.length} 个 agent</span><span>消息 {st.seen.length}</span><span data-alert={playing || undefined}>{playing ? '运行中' : '已暂停'}</span><span>T {ts(now)}</span><span>示例剧本 · 不连接模型</span></>}>
    <div className="sw rh" data-face={face}>
      <Explorer code="RSCH" open={xpOpen} view={xpView} onView={setXpView} onToggle={() => setXpOpen(v => !v)} title={`${working} 个工作中`} sections={sections} />
      <section className="sw-center" data-wb-panel>
        {bar}
        <div className="sw-body">
          {face === 'tree' ? <TreeView st={st} msgs={msgs} now={now} onAgent={setSelAgent} />
            : face === 'bus' ? <Bus st={st} now={now} msgs={msgs} selAgent={selAgent} selMsg={selMsg} onAgent={setSelAgent} onMsg={id => { setSelMsg(id); }} />
            : face === 'board' ? <Board posts={st.posts} now={now} onPost={t => inject(t)} />
            : <Synth onDispatch={onDispatch} />}
        </div>
        {timeline}
      </section>
      {face === 'bus' ? <MsgLog st={st} msgs={msgs} now={now} selAgent={selAgent} selMsg={selMsg} onMsg={(id, t) => { setSelMsg(id); setPlaying(false); setNow(t + .7); }} onAgent={setSelAgent} />
        : <AgentDock name="总负责人" target={`${AGENTS.length} 个 agent · T ${ts(now)}`} plan={{ stages: ['拆题', '分头搜索阅读', '反驳与核实', '汇总'], current: now < 5 ? 0 : now < 30 ? 1 : now < 52 ? 2 : 3 }} suggestions={suggestions} events={events} busy={false} onSend={onSend} placeholder="对总负责人说，或 @某个 agent 下指令" />}
    </div>
  </BenchFrame>;
}

/* ———— 时间轴 ———— */
function TimeBar({ now, end, playing, speed, msgs, onPlay, onSeek, onSpeed }: { now: number; end: number; playing: boolean; speed: number; msgs: Msg[]; onPlay: () => void; onSeek: (t: number) => void; onSpeed: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const seek = (x: number) => { const r = track.current!.getBoundingClientRect(); onSeek(Math.max(0, Math.min(end, ((x - r.left) / r.width) * end))); };
  return <footer className="sw-time">
    <button className="sw-play" onClick={onPlay} aria-label={playing ? '暂停' : '播放'}><svg viewBox="0 0 12 12" aria-hidden="true">{playing ? <><rect x="2" y="1.5" width="3" height="9" /><rect x="7" y="1.5" width="3" height="9" /></> : <path d="M3 1.5 L10.5 6 L3 10.5 Z" />}</svg></button>
    <div className="sw-track" ref={track} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); seek(e.clientX); }} onPointerMove={e => { if (e.buttons) seek(e.clientX); }}>
      {msgs.map(x => <i key={x.id} data-type={x.type} style={{ left: `${(x.t / end) * 100}%` }} />)}
      <span className="sw-fill" style={{ transform: `scaleX(${now / end})` }} />
      <b style={{ left: `${(now / end) * 100}%` }} />
    </div>
    <small>{ts(now)} / {ts(end)}</small>
    <button className="sw-speed" onClick={onSpeed}>×{speed}</button>
  </footer>;
}

/* ———— 02 通信：星座 + 光点 ———— */
function Bus({ st, now, msgs, selAgent, selMsg, onAgent, onMsg }: { st: ReturnType<typeof stateAt>; now: number; msgs: Msg[]; selAgent: string | null; selMsg: string | null; onAgent: (id: string | null) => void; onMsg: (id: string) => void }) {
  const [proto, setProto] = useState(false);
  const recent = msgs.filter(x => x.t <= now && now - x.t < 6);
  const flying = msgs.filter(x => x.t <= now && now - x.t < 1.1);
  const sel = msgs.find(x => x.id === selMsg);
  const at = (id: string) => POS[id] ?? POS.L;
  const touched = (a: string) => selAgent === a || (sel && (sel.from === a || sel.to === a));
  return <div className="sw-bus">
    <svg className="sw-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {recent.filter(x => x.to !== 'all').map(x => { const [x1, y1] = at(x.from), [x2, y2] = at(x.to); return <line key={x.id} x1={x1} y1={y1} x2={x2} y2={y2} data-type={x.type} data-sel={x.id === selMsg || (selAgent && (x.from === selAgent || x.to === selAgent)) || undefined} style={{ opacity: 1 - (now - x.t) / 6 }} vectorEffect="non-scaling-stroke" />; })}
    </svg>
    {flying.filter(x => x.to === 'all').map(x => { const [cx, cy] = at(x.from); return <span key={x.id} className="sw-wave" style={{ left: `${cx}%`, top: `${cy}%`, transform: `translate(-50%,-50%) scale(${.2 + (now - x.t) * 9})`, opacity: 1 - (now - x.t) / 1.1 }} />; })}
    {flying.filter(x => x.to !== 'all').map(x => { const [x1, y1] = at(x.from), [x2, y2] = at(x.to), p = Math.min(1, (now - x.t) / 1.1), e = 1 - Math.pow(1 - p, 3); return <span key={x.id} className="sw-packet" data-type={x.type} onClick={() => onMsg(x.id)} style={{ left: `${x1 + (x2 - x1) * e}%`, top: `${y1 + (y2 - y1) * e}%` }}>{MSG[x.type].glyph}</span>; })}
    <button className="sw-node is-board" style={{ left: `${POS.board[0]}%`, top: `${POS.board[1]}%` }} data-hot={flying.some(x => x.to === 'board') || undefined}><b>BOARD</b><small>留言板 · {st.posts.length}</small></button>
    {AGENTS.map(a => { const [x, y] = at(a.id), b = st.busy[a.id], live = b && now - b.t < 3;
      return <button key={a.id} className="sw-node" data-role={a.role} data-live={live || undefined} data-sel={touched(a.id) || undefined} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => onAgent(selAgent === a.id ? null : a.id)} title={`${a.name}${b ? ` · ${MSG[b.type].zh}` : ''}`}>
        <b>{a.id}</b>{a.role === 'lead' && <small>总负责人</small>}</button>; })}
    {ORDER.map(r => { const ids = AGENTS.filter(a => a.role === r).map(a => POS[a.id]); const cx = ids.reduce((s, p) => s + p[0], 0) / ids.length, cy = ids.reduce((s, p) => s + p[1], 0) / ids.length; const dx = cx - 50, dy = cy - 48, k = .74; // 标签放在圈内侧，不压节点
      return <span key={r} className="sw-role-label" style={{ left: `${50 + dx * k}%`, top: `${48 + dy * k}%` }}>{ROLES[r].en}<small>{ROLES[r].zh}</small></span>; })}
    {sel && <div className="sw-inspect"><span className="rh-micro">MESSAGE · {ts(sel.t)}</span><b><em>{MSG[sel.type].glyph}</em>{MSG[sel.type].zh}</b><span className="sw-route">{agent(sel.from)?.name ?? '你'} → {sel.to === 'all' ? '全体' : sel.to === 'board' ? '留言板' : agent(sel.to)?.name}</span><p>{sel.text}</p>{sel.task && <small>关联任务 · {sel.task}</small>}<i>{MSG[sel.type].desc}</i></div>}
    <button className={`sw-proto-btn${proto ? ' is-on' : ''}`} onClick={() => setProto(v => !v)}>{proto ? '收起协议' : '通信协议 · 7 种消息'}</button>
    {proto && <div className="sw-proto"><span className="rh-micro">PROTOCOL · 每条消息 = 发件人 · 收件人 · 类型 · 关联任务 · 内容</span>
      {(Object.keys(MSG) as MsgType[]).map(k => <div key={k}><em data-type={k}>{MSG[k].glyph}</em><b>{MSG[k].zh}</b><span>{MSG[k].desc}</span><small>{msgs.filter(x => x.type === k && x.t <= now).length}</small></div>)}
      <p>三种通道：点对点（提问 / 交付 / 转交 / 反驳）· 广播（发布任务、决定）· 留言板（求助、发现，谁都能接）。</p></div>}
  </div>;
}
function MsgLog({ st, msgs, now, selAgent, selMsg, onMsg, onAgent }: { st: ReturnType<typeof stateAt>; msgs: Msg[]; now: number; selAgent: string | null; selMsg: string | null; onMsg: (id: string, t: number) => void; onAgent: (id: string | null) => void }) {
  const [filter, setFilter] = useState<MsgType | null>(null);
  const list = st.seen.filter(x => (!filter || x.type === filter) && (!selAgent || x.from === selAgent || x.to === selAgent)).slice().reverse();
  return <aside className="sw-log" data-wb-panel>
    <header><span className="rh-ph-no">B</span><span><b>消息流</b><small>BUS · {st.seen.length} / {msgs.length}</small></span>{selAgent && <button className="rh-btn" onClick={() => onAgent(null)}>只看 {selAgent} ×</button>}</header>
    <div className="sw-filters">{(Object.keys(MSG) as MsgType[]).map(k => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(f => f === k ? null : k)}><em data-type={k}>{MSG[k].glyph}</em>{MSG[k].zh}</button>)}</div>
    <ol>{list.map(x => <li key={x.id} data-type={x.type} aria-current={x.id === selMsg || undefined} data-fresh={now - x.t < 1.2 || undefined}>
      <button onClick={() => onMsg(x.id, x.t)}><time>{ts(x.t)}</time><em data-type={x.type}>{MSG[x.type].glyph}</em>
        <span><b>{x.from === 'YOU' ? '你' : x.from} → {x.to === 'all' ? '全体' : x.to === 'board' ? '留言板' : x.to}</b><small>{MSG[x.type].zh}{x.task ? ` · ${x.task}` : ''}</small><p>{x.text}</p></span></button></li>)}</ol>
  </aside>;
}

/* ———— 01 任务树 ———— */
function TreeView({ st, msgs, now, onAgent }: { st: ReturnType<typeof stateAt>; msgs: Msg[]; now: number; onAgent: (id: string) => void }) {
  const [sel, setSel] = useState<string>('Q2');
  const owners = (id: string) => [...new Set(msgs.filter(x => x.t <= now && x.task === id && x.from !== 'L' && x.from !== 'P02').map(x => x.from))];
  const thread = msgs.filter(x => x.t <= now && (x.task === sel || x.task?.startsWith(`${sel}-`)));
  const S = (id: string) => st.status[id];
  return <div className="sw-tree">
    <div className="sw-tree-map">
      <div className="sw-root" data-s={S('ROOT')}><span className="rh-micro">ROOT · 根问题</span><b>{TASKS[0].title}</b><i>{S('ROOT') ? STATUS_ZH[S('ROOT')] : '待开始'}</i></div>
      <div className="sw-subs">{[...SUBS.map(s => s.id), 'X1'].map(id => { const t = TASKS.find(x => x.id === id)!; const kids = TASKS.filter(x => x.parent === id);
        return <div key={id} className="sw-sub" data-s={S(id)} aria-current={sel === id || undefined} onClick={() => setSel(id)}>
          <header><em>{id}</em><b>{t.title}</b><i>{S(id) ? STATUS_ZH[S(id)] : '待开放'}</i></header>
          {kids.length > 0 && <div className="sw-kids">{kids.map(k => <span key={k.id} data-s={S(k.id)}><i />{k.title}<small>{owners(k.id).slice(0, 3).map(o => <button key={o} onClick={e => { e.stopPropagation(); onAgent(o); }}>{o}</button>)}</small></span>)}</div>}
        </div>; })}</div>
    </div>
    <aside className="sw-thread"><header><span className="rh-ph-no">T</span><b>{sel} · {TASKS.find(x => x.id === sel)?.title}</b></header>
      <ol>{thread.length ? thread.map(x => <li key={x.id} data-type={x.type}><em data-type={x.type}>{MSG[x.type].glyph}</em><span><b>{x.from} → {x.to === 'all' ? '全体' : x.to === 'board' ? '留言板' : x.to}</b><p>{x.text}</p></span><time>{ts(x.t)}</time></li>) : <li className="sw-none">还没有关于这个任务的消息。</li>}</ol></aside>
  </div>;
}

/* ———— 03 留言板 ———— */
const COLS: { id: Post['col']; zh: string; en: string }[] = [{ id: 'question', zh: '问题', en: 'QUESTIONS' }, { id: 'finding', zh: '发现', en: 'FINDINGS' }, { id: 'help', zh: '求助', en: 'HELP' }, { id: 'decision', zh: '决定', en: 'DECISIONS' }];
function Board({ posts, now, onPost }: { posts: Post[]; now: number; onPost: (t: string) => void }) {
  const [draft, setDraft] = useState('');
  return <div className="sw-board">
    <form className="sw-post" onSubmit={e => { e.preventDefault(); if (draft.trim()) { onPost(draft.trim()); setDraft(''); } }}>
      <span className="rh-micro">发帖 · 用 @C01 / @S03 / @A02 这样的写法指定某个 agent</span>
      <div><input value={draft} onChange={e => setDraft(e.target.value)} placeholder="例如：@C01 给线性注意力找一个反例" /><button className="rh-btn is-solid" disabled={!draft.trim()}>贴到留言板</button></div>
    </form>
    <div className="sw-cols">{COLS.map(c => <section key={c.id}><header><b>{c.zh}</b><small>{c.en} · {posts.filter(p => p.col === c.id).length}</small></header>
      <ol>{posts.filter(p => p.col === c.id).slice().reverse().map(p => <li key={p.id} data-new={now - p.t < 1.5 || undefined} data-you={p.by === 'YOU' || undefined}><span><b>{p.by === 'YOU' ? '你' : p.by}</b><time>{ts(p.t)}</time></span><p>{p.text}</p></li>)}</ol></section>)}</div>
  </div>;
}

/* ———— 04 汇总 ———— */
function Synth({ onDispatch }: { onDispatch: (to: 'auto', t: string) => void }) {
  return <div className="sw-synth en-report">
    <nav className="en-report-index"><span className="rh-micro">INDEX</span>{['分类', '对比', '局限', '失败路径', '下一步'].map((t, i) => <button key={t} onClick={() => scrollWithin(document.getElementById(`sw-sec-${i}`), 'start')}><em>{String(i + 1).padStart(2, '0')}</em>{t}</button>)}</nav>
    <article className="rh-read en-report-body">
      <span className="rh-micro">SYNTHESIS · 32 个 agent · 6 个子问题 · 汇总员 Y 起草，总负责人发布</span>
      <h2>长文本：注意力的平方代价是怎么被绕过去的</h2>
      <h3 id="sw-sec-0">五类思路</h3>
      <ol className="sw-classes">{[['减少谁看谁', '稀疏、低秩'], ['改写计算顺序', '线性 / 核注意力'], ['换掉注意力', '状态空间 / 循环'], ['不改数学只改实现', '系统层优化'], ['改位置信息', '长度外推（由 C02 反驳后补上）']].map(([a, b], i) => <li key={a}><em>{String(i + 1).padStart(2, '0')}</em><b>{a}</b><span>{b}</span></li>)}</ol>
      <h3 id="sw-sec-1">对比</h3>
      <table className="rs-table"><thead><tr><th>子问题</th><th>代表</th><th>计算量</th><th>精确？</th><th>代价</th></tr></thead>
        <tbody>{SUBS.map(s => <tr key={s.id}><td>{s.id} {s.title}</td><td>{s.method}</td><td>{s.cost}</td><td>{s.exact}</td><td>{s.trade}</td></tr>)}</tbody></table>
      <h3 id="sw-sec-2">反驳后保留的局限</h3>
      <ul><li>线性 / 核注意力是近似，不等价于 softmax 注意力；在需要精确查找的任务上质量下降（C01 反驳）。</li><li>低秩压缩依赖「注意力矩阵近似低秩」的前提，不能当成通用结论（C03 反驳，总负责人降级）。</li></ul>
      <h3 id="sw-sec-3">失败路径</h3>
      <p>「注意力蒸馏」：S10 没有找到直接解决长文本的工作，相关研究多为压缩模型大小。保留记录，不再投入。</p>
      <h3 id="sw-sec-4">下一步</h3>
      <p>能量化的问题交给自研：在 8k 长度下实测 FlashAttention 与线性注意力的速度、显存与质量。</p>
      <div className="ts-report-act"><button className="rh-btn is-solid" onClick={() => onDispatch('auto', '8k 长度下 FlashAttention 与线性注意力的速度 / 显存对比')}>交给自研 →</button><button className="rh-btn">导出 md</button></div>
    </article>
  </div>;
}
