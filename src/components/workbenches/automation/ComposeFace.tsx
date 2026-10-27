import { Fragment, useState, type ReactNode } from 'react';
import { PERM_LABEL, TRIGGER_LABEL, type Amb, type Perm, type Routine, type Tool } from './model';

// 编排面：例程就是一页「例程书」——自然语言指令 + 触发 + 工具权限 + 产出与预算。
// 右栏是 AI 对指令的解读：按句拆成它会执行的步骤，标出每一步用到的工具、会不会停下来问你；说不清的短语在正文里下划线标出。

const RISK: Record<Tool['risk'], string> = { read: '只读', write: '写入', danger: '危险' };
const DAYS = ['日', '一', '二', '三', '四', '五', '六'];

export type Reading = { text: string; tools: Tool[]; waits: boolean };
/** 把指令按句拆成执行步骤（本地模拟 Agent 的解读）。 */
export function interpret(r: Routine): Reading[] {
  // 按句号断句；逗号后面如果是一个新动作（按… / 每项… / 放到… / 然后…），也拆成单独一步。
  return r.instruction.split(/(?<=[。；])|，(?=(?:按|每项|放到|放进|然后|再|跳过|对每|拿不准|确认后|写好后|齐全|不齐全|没有|读不出|同一个|连同|归档前|先看|少于|已经))/).map(s => s.trim()).filter(Boolean).map(s => {
    const ids = [...s.matchAll(/@([a-z_]+)/g)].map(m => m[1]);
    const tools = r.tools.filter(t => ids.includes(t.id));
    if (/写入|存进|归进|放到|写进|移进|写到|发给/.test(s)) { const free = r.tools.filter(t => t.risk === 'write' && !tools.includes(t)); const w = free.find(t => /write/.test(t.id)) ?? free[0]; if (w) tools.push(w); }
    if (!tools.length && /摘要|起草|整理|排序|读|检查|盘点|导出/.test(s)) { const rd = r.tools.find(t => t.risk === 'read' && !ids.includes(t.id) && s.includes(t.name.slice(-2))) ?? null; if (rd) tools.push(rd); }
    return { text: s, tools, waits: /确认|看过|让我|告诉我|发给我/.test(s) };
  });
}

/** 指令正文：@工具、#档案 渲染成芯片；未说清的短语加橙色虚下划线和编号。 */
function Instruction({ text, r, ambs, onAmb, caret }: { text: string; r: Routine; ambs: Amb[]; onAmb: (id: string) => void; caret?: boolean }) {
  const chips = (s: string, key: string) => s.split(/(@[a-z_]+|#[^\s，。、；：]+)/).map((p, i) => {
    if (p.startsWith('@')) { const t = r.tools.find(x => x.id === p.slice(1)); return <span key={`${key}${i}`} className="au-chip" data-risk={t?.risk}><i>@</i>{t?.name ?? p.slice(1)}</span>; }
    if (p.startsWith('#')) return <span key={`${key}${i}`} className="au-chip is-ref"><i>#</i>{p.slice(1)}</span>;
    return <Fragment key={`${key}${i}`}>{p}</Fragment>;
  });
  const out: ReactNode[] = []; let rest = text, k = 0;
  while (rest) {
    const hit = ambs.map(a => ({ a, at: rest.indexOf(a.phrase) })).filter(h => h.at >= 0).sort((x, y) => x.at - y.at)[0];
    if (!hit) { out.push(...chips(rest, `t${k++}`)); break; }
    out.push(...chips(rest.slice(0, hit.at), `t${k++}`));
    out.push(<button key={`a${k++}`} className="au-amb" onClick={() => onAmb(hit.a.id)}>{hit.a.phrase}<sup>{ambs.indexOf(hit.a) + 1}</sup></button>);
    rest = rest.slice(hit.at + hit.a.phrase.length);
  }
  return <p className="au-instr">{out}{caret && <i className="au-caret" />}</p>;
}

export default function ComposeFace({ r, typing, dirty, preview, onEdit, onResolve, onPerm, onBudget, onToggle, onPreview, onRunNow, onSave, graphTools = {}, onOpenGraph }: {
  r: Routine; typing: number | null; dirty: boolean; preview: { at: number; done: boolean } | null;
  onEdit: (text: string) => void; onResolve: (a: Amb, option: string) => void; onPerm: (tool: string, p: Perm) => void;
  onBudget: (k: 'minutes' | 'calls', v: number) => void; onToggle: () => void; onPreview: () => void; onRunNow: () => void; onSave: () => void;
  /** 已发布为工具的节点图：工具名 → 工作流。 */
  graphTools?: Record<string, { id: string; name: string }>; onOpenGraph?: (wf: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [focusAmb, setFocusAmb] = useState<string | null>(null);
  const reading = interpret(r);
  const asks = r.tools.filter(t => t.perm === 'ask').length, denied = r.tools.filter(t => t.perm === 'deny').length;
  const text = typing !== null ? r.instruction.slice(0, typing) : r.instruction;
  return <div className="au-center">
    <header className="au-head">
      <span className="au-id">{r.id}</span>
      <div className="au-title"><strong>{r.name}</strong><span>{r.triggers.map(t => t.human).join(' · ')} <i>·</i> {r.version}{dirty && <em> · 有未保存的改动</em>}</span></div>
      <button className="au-switch" role="switch" aria-checked={r.enabled} onClick={onToggle}><i /><span>{r.enabled ? '已启用' : '未启用'}</span></button>
      <div className="au-head-act">
        {dirty && <button className="rh-btn" onClick={onSave}>保存为 v{(parseFloat(r.version.slice(1)) + .1).toFixed(1)}</button>}
        <button className="rh-btn" onClick={onPreview} disabled={!!preview && !preview.done}>预演</button>
        <button className="au-run" onClick={onRunNow}><i />立即运行</button>
      </div>
    </header>
    <div className="au-compose">
      <article className="au-doc">
        <section className="au-sec" data-n="01">
          <header><b>指令</b><small>INSTRUCTION · 用平常的话写，@ 引用工具，# 引用档案</small>
            {typing === null && <button onClick={() => setEditing(v => !v)}>{editing ? '完成' : '编辑'}</button>}</header>
          {editing
            ? <textarea className="au-instr-edit" value={r.instruction} onChange={e => onEdit(e.target.value)} rows={6} autoFocus />
            : <Instruction text={text} r={r} ambs={typing === null ? r.ambs : []} caret={typing !== null} onAmb={id => setFocusAmb(id)} />}
          {typing === null && r.ambs.length > 0 && <div className="au-ambs">
            {r.ambs.map((a, i) => <div key={a.id} className="au-amb-card" data-focus={focusAmb === a.id || undefined}>
              <span><sup>{i + 1}</sup>「{a.phrase}」<b>{a.question}</b></span>
              <div>{a.options.map(o => <button key={o} onClick={() => { onResolve(a, o); setFocusAmb(null); }}>{o}</button>)}</div>
            </div>)}
          </div>}
        </section>

        <section className="au-sec" data-n="02">
          <header><b>触发</b><small>TRIGGER</small></header>
          <div className="au-triggers">{r.triggers.map((t, i) => <div key={i} className="au-trig" data-kind={t.kind}>
            <span className="au-trig-k">{TRIGGER_LABEL[t.kind]}</span>
            <div><b>{t.human}</b><code>{t.spec}</code></div>
            {t.hours && <div className="au-week" aria-label="一周里的运行时间">
              {DAYS.map((d, di) => <Fragment key={d}><em>{d}</em><span>{(t.days ?? []).includes(di) && t.hours!.map(h => <i key={h} style={{ left: `${h / 24 * 100}%` }} />)}</span></Fragment>)}
              <small /><span className="au-week-axis"><i>0</i><i>6</i><i>12</i><i>18</i><i>24</i></span>
            </div>}
          </div>)}</div>
        </section>

        <section className="au-sec" data-n="03">
          <header><b>工具与权限</b><small>TOOLS · 允许直接用 / 每次先问你 / 不许用</small></header>
          <table className="au-perm"><tbody>{r.tools.map(t => <tr key={t.id} data-risk={t.risk}>
            <td><code>@{t.id}</code><b>{t.name}</b>{t.desc && <small>{t.desc}</small>}{graphTools[t.id] && <span className="au-graphtool"><i>节点图</i>{graphTools[t.id].id}<button onClick={() => onOpenGraph?.(graphTools[t.id].id)}>打开 ↗</button></span>}</td>
            <td><span className="au-risk" data-risk={t.risk}>{RISK[t.risk]}</span></td>
            <td><div className="au-seg">{(['allow', 'ask', 'deny'] as Perm[]).map(p => <button key={p} aria-pressed={t.perm === p} data-p={p}
              disabled={t.risk === 'danger' && p === 'allow'} title={t.risk === 'danger' && p === 'allow' ? '危险动作只能你点，不能交给例程' : undefined}
              onClick={() => onPerm(t.id, p)}>{PERM_LABEL[p]}</button>)}</div></td>
          </tr>)}</tbody></table>
        </section>

        <section className="au-sec" data-n="04">
          <header><b>产出与预算</b><small>OUTPUT · BUDGET</small></header>
          <div className="au-budget">
            <div><span className="rh-micro">产出到</span><b>{r.output}</b></div>
            <div><span className="rh-micro">模型</span><b>{r.model}</b></div>
            <label><span className="rh-micro">每次最多</span><input type="range" min={1} max={30} value={r.budget.minutes} onChange={e => onBudget('minutes', +e.target.value)} /><b>{r.budget.minutes} 分钟</b></label>
            <label><span className="rh-micro">工具调用上限</span><input type="range" min={5} max={200} step={5} value={r.budget.calls} onChange={e => onBudget('calls', +e.target.value)} /><b>{r.budget.calls} 次</b></label>
          </div>
        </section>

        <section className="au-sec" data-n="05">
          <header><b>版本</b><small>VERSIONS</small></header>
          <ol className="au-versions">{r.versions.map(([v, d, note], i) => <li key={v + i} data-now={i === 0 || undefined}><b>{v}</b><time>{d}</time><span>{note}</span></li>)}</ol>
        </section>
      </article>

      <aside className="au-read" aria-label="AI 的解读">
        <header><span className="rh-micro">AI 的解读 · READING</span><b>它会这样做</b></header>
        <ol>{(typing === null ? reading : []).map((s, i) => {
          const st = !preview ? undefined : i < preview.at || preview.done ? 'done' : i === preview.at ? 'now' : undefined;
          return <li key={i} data-state={st} style={{ animationDelay: `${i * 60}ms` }}>
            <em>{String(i + 1).padStart(2, '0')}</em>
            <p>{s.text.replace(/[@#]/g, '')}</p>
            <div>{s.tools.map(t => <span key={t.id} className="au-flag" data-p={t.perm}>{t.name}{t.perm === 'ask' ? ' · 先问你' : t.perm === 'deny' ? ' · 被禁止' : ''}</span>)}
              {s.waits && <span className="au-flag" data-p="wait">停下等你</span>}</div>
          </li>;
        })}</ol>
        {typing !== null && <div className="au-read-wait"><i /><i /><i /> 正在理解指令</div>}
        <footer>
          <span><b>{reading.length}</b> 步</span><span><b>{asks}</b> 个工具先问你</span><span><b>{denied}</b> 个被禁止</span><span data-alert={r.ambs.length > 0 || undefined}><b>{r.ambs.length}</b> 处没说清</span>
        </footer>
        {preview?.done && <div className="au-preview-done"><b>预演通过</b><span>没有执行任何工具，也没有写入。正式运行时会在 {reading.filter(s => s.waits || s.tools.some(t => t.perm === 'ask')).length} 处停下来等你。</span></div>}
      </aside>
    </div>
  </div>;
}
