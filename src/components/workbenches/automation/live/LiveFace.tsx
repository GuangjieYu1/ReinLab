import { useEffect, useRef, useState, type ReactNode } from 'react';
import { scrollWithin } from '../../scrollWithin';
import type { ExplorerSection } from '../../engineering/Explorer';
import { hm, RISK_TEXT, SOURCE_LABEL, STATE_TEXT, yamlOf, type Param, type Unit } from './liveModel';
import { Spark, WidgetView } from './LiveCharts';
import type { LiveCtl } from './useLive';
import './live.css';

// 看板面 LIVE：所有常驻自动化排成实时小面板（参照 Grafana）；点开一个 = 放大的面板 + 旋钮 + 和维护 Agent 对话。
// 「接入」把 GitHub 项目 / 研究成果 / 一句话想法 / API 走成 侦查 → 适配 → 沙盒试跑 → 你批准上线。

const STATE_DOT: Record<string, string> = { ok: 'ok', alert: 'waiting', fail: 'fail', paused: 'none', trial: 'running' };
const show = (v: Param['value']) => Array.isArray(v) ? v.join('、') : String(v);

function firstSeries(c: LiveCtl, u: Unit) {
  const d = c.data[u.id]; if (!d) return [];
  if (u.kind === 'simulation') { const cur = d.sim?.curves.find(x => x.now); return cur ? cur.pts.slice(0, Math.max(2, d.sim!.step)) : []; }
  const w = u.panel.find(x => x.kind === 'line'); if (!w || w.kind !== 'line') return [];
  const k = w.series.find(s => d.series[s]?.length); return k ? d.series[k].slice(-60) : [];
}
function headline(c: LiveCtl, u: Unit) {
  const d = c.data[u.id]; const w = u.panel.find(x => x.kind === 'stat');
  if (w && w.kind === 'stat') return { v: d?.stats[w.stat]?.v ?? '—', label: w.title };
  const l = u.panel.find(x => x.kind === 'line'); const k = l && l.kind === 'line' ? l.series.find(s => d?.series[s]?.length) : undefined;
  return k ? { v: String(d.series[k].reduce((a, b) => a + b, 0)), label: `近 ${d.series[k].length * 5} 分钟${k}` } : { v: '—', label: '' };
}

function Knob({ p, pending, onSet }: { p: Param; pending: Param['value'] | undefined; onSet: (v: Param['value']) => void }) {
  const [draft, setDraft] = useState(p.value);
  const [tag, setTag] = useState('');
  useEffect(() => setDraft(p.value), [p.value]);
  const commit = () => { if (JSON.stringify(draft) !== JSON.stringify(p.value)) onSet(draft); };
  return <div className="lv-knob" data-risk={p.risk} data-pending={pending !== undefined || undefined}>
    <header><b>{p.label}</b><em data-risk={p.risk}>{RISK_TEXT[p.risk]}</em></header>
    {p.kind === 'number' && <div className="lv-range">
      <input type="range" min={p.min} max={p.max} step={p.step} value={draft as number} aria-label={p.label}
        onChange={e => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <output>{draft as number}{p.unit}</output>
    </div>}
    {p.kind === 'enum' && <div className="lv-seg">{p.options!.map(o => <button key={o} aria-pressed={p.value === o} onClick={() => onSet(o)}>{o}</button>)}</div>}
    {p.kind === 'multi' && <div className="lv-chips">{p.options!.map(o => { const on = (p.value as string[]).includes(o); return <button key={o} aria-pressed={on}
      onClick={() => { const cur = p.value as string[]; const v = on ? cur.filter(x => x !== o) : [...cur, o]; if (v.length) onSet(v); }}>{on ? '✓ ' : '+ '}{o}</button>; })}</div>}
    {p.kind === 'tags' && <div className="lv-chips is-tags">{(p.value as string[]).map(t => <span key={t}>{t}<button aria-label={`删除 ${t}`} onClick={() => onSet((p.value as string[]).filter(x => x !== t))}>×</button></span>)}
      <input value={tag} placeholder="+ 关键词" onChange={e => setTag(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && tag.trim()) { onSet([...(p.value as string[]), tag.trim()]); setTag(''); } }} /></div>}
    {pending !== undefined ? <small className="lv-pend">等你批准 → {show(pending)}</small> : p.hint && <small>{p.hint}</small>}
  </div>;
}

function Board({ c }: { c: LiveCtl }) {
  const alerts = c.units.filter(u => u.state === 'alert').length; const now = Math.max(...Object.values(c.data).map(d => d.minute));
  return <div className="au-center lv-center">
    <header className="au-head">
      <span className="au-id">LIVE</span>
      <div className="au-title"><strong>实时看板</strong><span>{c.units.length} 个常驻 <i>·</i> {alerts ? <em>{alerts} 个告警</em> : '没有告警'} <i>·</i> 一拍 = 1 分钟 <i>·</i> 现在 {hm(now)}</span></div>
      <div className="au-head-act"><button className="au-run" onClick={() => c.startOnboard('https://github.com/opendata/hotlist-tracker 接进来')}><i />接入项目</button></div>
    </header>
    <div className="lv-board">
      {c.units.map(u => { const d = c.data[u.id], hl = headline(c, u); return <button key={u.id} className="lv-card" data-state={u.state} onClick={() => { c.setSel(u.id); c.setTab('panel'); }}>
        <div className="lv-card-top"><code>{u.id}</code><span className="lv-kind">{u.kind === 'simulation' ? '模拟' : '常驻'}</span><span className="lv-st"><i data-s={STATE_DOT[u.state]} />{STATE_TEXT[u.state]}</span></div>
        <b className="lv-card-title">{u.title}</b>
        <Spark vals={firstSeries(c, u)} hot={u.state === 'alert'} />
        <div className="lv-card-kpi"><strong>{hl.v}</strong><small>{hl.label}</small></div>
        {d?.alert ? <p className="lv-card-alert">{d.alert}</p> : <p className="lv-card-src">{SOURCE_LABEL[u.source.type]} · {u.cadence === '按需' ? '按需运行' : `每 ${u.cadence.replace('m', ' 分钟')}`}{u.kind === 'live' ? ` · ${hm(d?.minute ?? 0)}` : ''}</p>}
      </button>; })}
      <button className="lv-card is-add" onClick={() => document.querySelector<HTMLTextAreaElement>('.ad-input textarea')?.focus()}>
        <b>＋ 接一个新的</b><span>把 GitHub 链接、研究台成果、外部 API，或者一句话想法发给右边的维护 Agent。例如「盯一下 RTX 5090 的二手价格」。</span>
      </button>
    </div>
  </div>;
}

function Detail({ c, u }: { c: LiveCtl; u: Unit }) {
  const d = c.data[u.id]; const logs = c.logs[u.id] ?? [];
  return <div className="au-center lv-center">
    <header className="au-head">
      <button className="lv-back" onClick={() => c.setSel(null)} aria-label="回到看板">←</button>
      <span className="au-id" data-state={u.state}>{u.id}</span>
      <div className="au-title"><strong>{u.title}</strong><span>{u.source.label} <i>·</i> {u.cadence === '按需' ? '按需运行' : `每 ${u.cadence.replace('m', ' 分钟')}`} <i>·</i> {u.versions[0].v} <i>·</i> {u.runtime}</span></div>
      <span className="lv-observe">{u.id === 'LV-02' ? '只看 · 不下单' : '只观察 · 只告警'}</span>
      <span className="au-state" data-state={u.state === 'alert' ? 'waiting' : u.state === 'ok' ? 'ok' : u.state}>{STATE_TEXT[u.state]}</span>
      <div className="au-head-act">
        {u.kind === 'simulation'
          ? <button className="au-run" onClick={() => c.runSim(u.id)} disabled={d?.sim?.running}><i />{d?.sim?.running ? `模拟中 ${d.sim.step}/48h` : '运行模拟'}</button>
          : <button className="au-run" onClick={() => c.togglePause(u.id)}><i />{u.state === 'paused' ? '恢复' : '暂停'}</button>}
      </div>
    </header>
    <div className="lv-detail">
      <div className="lv-main">
        <nav className="lv-tabs" role="tablist">{([['panel', '面板'], ['yaml', '清单 automation.yaml'], ['log', `日志 ${logs.length}`]] as const).map(([k, l]) =>
          <button key={k} role="tab" aria-selected={c.tab === k} onClick={() => c.setTab(k)}>{l}</button>)}</nav>
        {d?.alert && c.tab === 'panel' && <p className="lv-banner"><b>告警</b>{d.alert}<small>已进收件箱 · 规则：{u.alerts[0]}</small></p>}
        {u.note && c.tab === 'panel' && <p className="lv-note">{u.note}</p>}
        {c.tab === 'panel' && <div className="lv-grid">{u.panel.map((w, i) => <WidgetView key={i} w={w} d={d} u={u} />)}</div>}
        {c.tab === 'yaml' && <pre className="lv-yaml">{yamlOf(u)}</pre>}
        {c.tab === 'log' && <ol className="lv-log">{logs.map((l, i) => <li key={i} data-k={l.kind}><time>{l.t}</time><span>{l.text}</span></li>)}</ol>}
      </div>
      <aside className="lv-side">
        <section><h4>旋钮</h4>{u.params.map(p => <Knob key={p.key} p={p} pending={c.pending[`${u.id}.${p.key}`]} onSet={v => c.setParam(u.id, p.key, v)} />)}</section>
        <section><h4>告警</h4>{u.alerts.length ? <ul className="lv-plain">{u.alerts.map(a => <li key={a}>{a}</li>)}</ul> : <p className="lv-none">模拟不设告警</p>}</section>
        <section><h4>网络放行</h4><ul className="lv-plain is-mono">{u.network.map(n => <li key={n}>{n}</li>)}</ul></section>
        <section><h4>版本</h4><ol className="au-versions is-mini">{u.versions.map((v, k) => <li key={v.v + k} data-now={k === 0 || undefined}><b>{v.v}</b><time>{v.at}</time><span>{v.note}</span></li>)}</ol>
          {u.versions.length > 1 && <button className="lv-link" onClick={() => c.rollback(u.id)}>回到上一版</button>}</section>
      </aside>
    </div>
  </div>;
}

function OnboardView({ c }: { c: LiveCtl }) {
  const ob = c.onboard!; const u = ob.unit;
  const box = useRef<HTMLDivElement>(null);
  // 每进入新的一段，把它滚进视野
  useEffect(() => { const secs = box.current?.querySelectorAll('.lv-ob-sec'); const last = secs?.[secs.length - 1]; if (last && ob.stage > 0) scrollWithin(last as HTMLElement, 'start'); }, [ob.stage]);
  const STEPS = ['侦查', '适配', '沙盒试跑', '你批准上线'];
  return <div className="au-center lv-center">
    <header className="au-head">
      <button className="lv-back" onClick={() => c.setSel(null)} aria-label="回到看板">←</button>
      <span className="au-id" data-state="trial">{ob.id}</span>
      <div className="au-title"><strong>接入 · {u.title}</strong><span>{SOURCE_LABEL[ob.from]} <i>·</i> {ob.input.slice(0, 48)}</span></div>
      {ob.result === 'live' && <div className="au-head-act"><button className="au-run" onClick={() => c.setSel(u.id)}><i />打开</button></div>}
    </header>
    <div className="lv-onboard" ref={box}>
      <ol className="lv-rail">{STEPS.map((s, i) => <li key={s} data-state={ob.stage > i || ob.result === 'live' ? 'done' : ob.stage === i ? 'now' : undefined}><em>{String(i + 1).padStart(2, '0')}</em>{s}</li>)}</ol>
      <section className="lv-ob-sec" data-on={ob.stage >= 0 || undefined}><h4>01 侦查报告</h4>
        {ob.stage === 0 ? <p className="lv-none lv-working">正在{ob.from === 'github' ? '把代码拉进沙盒、读 README 和依赖' : '找数据来源'}…</p>
          : <ul className="lv-scout">{ob.scout.map(([k, v, s]) => <li key={k} data-s={s}><b>{k}</b><span>{v}</span></li>)}</ul>}
      </section>
      {ob.stage >= 1 && <section className="lv-ob-sec"><h4>02 适配 · 生成四件套</h4>
        <div className="lv-files"><span data-on>automation.yaml</span><span data-on={ob.stage >= 2 || undefined}>main.py · rl.emit</span><span data-on={ob.stage >= 2 || undefined}>panel · {u.panel.length} 块</span></div>
        <pre className="lv-yaml is-typing">{ob.yaml.slice(0, ob.typed)}{ob.stage === 1 && <i className="lv-caret" />}</pre>
      </section>}
      {ob.stage >= 2 && c.trial && <section className="lv-ob-sec"><h4>03 沙盒试跑 <small>{Math.min(ob.trialTicks, 6)} / 6 拍 · 拦截一切对外写入</small></h4>
        <div className="lv-grid is-sandbox">{u.panel.map((w, i) => <WidgetView key={i} w={w} d={c.trial!} u={u} />)}</div>
      </section>}
      {ob.stage >= 3 && <section className="lv-ob-sec"><h4>04 批准</h4>
        <p className="lv-verdict" data-r={ob.result}>{ob.result === 'live' ? `已上线，出现在看板上。维护 Agent 负责它；改动照样要你批准。` : ob.result === 'rejected' ? '你驳回了，没有上线。四件套和沙盒都保留着。' : '试跑通过。上线需要你在右侧批准。'}</p>
      </section>}
    </div>
  </div>;
}

export default function LiveFace({ c }: { c: LiveCtl }) {
  if (c.sel === '__onboard' && c.onboard) return <OnboardView c={c} />;
  const u = c.units.find(x => x.id === c.sel);
  return u ? <Detail c={c} u={u} /> : <Board c={c} />;
}

export function liveSections(c: LiveCtl, onNew: () => void): ExplorerSection[] {
  const item = (u: Unit): ReactNode => <button key={u.id} className="au-item" aria-current={u.id === c.sel || undefined} data-off={u.state === 'paused' || undefined} onClick={() => { c.setSel(u.id); c.setTab('panel'); }}>
    <i data-s={STATE_DOT[u.state]} /><span><b>{u.title}</b><small>{u.id} · {STATE_TEXT[u.state]} · {SOURCE_LABEL[u.source.type]}</small></span></button>;
  const live = c.units.filter(u => u.kind === 'live'), sims = c.units.filter(u => u.kind === 'simulation');
  return [
    { id: 'lnew', title: '新建', body: <div className="gm-new"><button onClick={() => c.setSel(null)}>▦ 看板总览</button><button onClick={onNew}>＋ 接入项目 / 一句话</button></div> },
    ...(c.onboard ? [{ id: 'lob', title: '接入中', body: <div className="au-list"><button className="au-item" aria-current={c.sel === '__onboard' || undefined} onClick={() => c.setSel('__onboard')}>
      <i data-s={c.onboard.result === 'live' ? 'ok' : c.onboard.result === 'rejected' ? 'none' : 'running'} /><span><b>{c.onboard.unit.title}</b><small>{c.onboard.id} · {['侦查', '适配', '沙盒试跑', '等你批准', c.onboard.result === 'live' ? '已上线' : '已驳回'][c.onboard.stage]}</small></span></button></div> }] : []),
    { id: 'llive', title: '常驻', count: live.length, grow: true, body: <div className="au-list">{live.map(item)}</div> },
    { id: 'lsim', title: '模拟', count: sims.length, body: <div className="au-list">{sims.map(item)}</div> },
  ];
}
