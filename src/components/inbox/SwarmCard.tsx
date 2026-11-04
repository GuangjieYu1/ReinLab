// 群研的四种收件箱卡（design/prd/13-swarm-contract.md §5）。收件箱和群研页用同一个卡面：
// 卡面字段来自 effects[0]，服务端算好，这里只按种类排版；追加额度可以在批准前改数值。
import './swarm-card.css';

export type SwarmCardKind = 'swarm_add_member' | 'swarm_extend' | 'swarm_scope' | 'swarm_divergence' | 'delegation_result';
/** 群研页对话框里就地处理的四种（委托结果卡属于源档案，只在收件箱里处理）。 */
export const isSwarmCard = (kind: string): kind is Exclude<SwarmCardKind, 'delegation_result'> => kind === 'swarm_add_member' || kind === 'swarm_extend' || kind === 'swarm_scope' || kind === 'swarm_divergence';
/** 收件箱认的：四种群研卡 + 委托结果卡。 */
export const isInboxSwarmCard = (kind: string): kind is SwarmCardKind => isSwarmCard(kind) || kind === 'delegation_result';

/** 每种卡叫什么、两个按钮各是什么意思（驳回不等于「什么都不做」，要说清楚）。 */
export const SWARM_CARD: Record<SwarmCardKind, { tag: string; name: string; approve: string; reject: string; why: string }> = {
  swarm_add_member: { tag: '加人', name: '中途加人', approve: '批准加人', reject: '不加', why: '加人会多花钱、多占一个名额（全程最多 16 人），所以要你点头；批准后由负责人去建。' },
  swarm_extend: { tag: '追加', name: '追加额度', approve: '批准追加', reject: '不追加，按现在收尾', why: '额度是开跑前你定的，超出要你批准；不追加就到限停下、保存阶段结果。' },
  swarm_scope: { tag: '范围', name: '扩大研究范围', approve: '按新范围继续', reject: '不改，按原问题继续', why: '改方向把原问题本身改了，超出了你开跑前确认的范围。' },
  delegation_result: { tag: '结果', name: '群研结果', approve: '采用', reject: '不采用', why: '这是你交给群研的问题的结果。研究档案保留完整过程；采用只在源档案里记一笔并挂上引用，不会改动源档案的内容。' },
  swarm_divergence: { tag: '分歧', name: '报告前的分歧', approve: '再查一轮', reject: '按「有争议」写入报告', why: '有结论被反驳后仍有分歧，写成已证实不诚实；要么再查一轮，要么在报告里如实标「有争议」。' },
};

const ROLE_ZH: Record<string, string> = { researcher: '研究员', critic: '反驳', verifier: '核实', lead: '负责人' };
const STATUS_ZH: Record<string, string> = { candidate: '候选', awaiting_refute: '待反驳', awaiting_verify: '待核实', verified: '已核实', disputed: '有争议', falsified: '已证伪', insufficient: '证据不足' };
/** 缺口前面带着结论状态的英文前缀（如「candidate：…」）：换成中文。 */
const gapText = (g: string) => { const m = g.match(/^([a-z_]+)[：:]\s*(.*)$/s); return m && STATUS_ZH[m[1]] ? { tag: STATUS_ZH[m[1]], text: m[2] } : { tag: '', text: g }; };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export type SwarmCardAnswers = { rounds?: number; minutes?: number };

export function SwarmCardBody({ kind, data, answers, setAnswers, locked }: {
  kind: SwarmCardKind; data: Record<string, any>; answers: SwarmCardAnswers; setAnswers: (v: SwarmCardAnswers) => void; locked: boolean;
}) {
  if (kind === 'swarm_add_member') return <dl className="sw-card-kv">
    <dt>加什么人</dt><dd>{ROLE_ZH[data.role] ?? data.role ?? '研究员'} × {num(data.count) ?? 1}</dd>
    {data.routeId && <><dt>放到哪条路线</dt><dd>{data.routeId}</dd></>}
    <dt>模型</dt><dd>{data.model ?? '默认'}</dd>
    <dt>加完之后</dt><dd>累计 {num(data.membersAfter) ?? '?'} / {num(data.max) ?? 16} 人（失败的创建也占名额）</dd>
  </dl>;
  if (kind === 'swarm_extend') {
    const s = data.suggest ?? {}, u = data.used ?? {};
    const rounds = answers.rounds ?? num(s.rounds) ?? 2, minutes = answers.minutes ?? num(s.minutes) ?? 15;
    return <div className="sw-card-body">
      <p className="sw-card-used">已用 {num(u.rounds) ?? '?'} 轮 / {num(u.minutes) ?? '?'} 分钟</p>
      {Array.isArray(data.findings) && data.findings.length > 0 && <><h5>这段时间的新发现</h5><ul>{data.findings.map((f: string, i: number) => <li key={i}>{f}</li>)}</ul></>}
      {Array.isArray(data.gaps) && data.gaps.length > 0 && <><h5>还缺什么</h5><ul>{data.gaps.map((g: string, i: number) => { const x = gapText(g); return <li key={i}>{x.tag && <em className="sw-card-tag">{x.tag}</em>}{x.text}</li>; })}</ul></>}
      <h5>追加多少</h5>
      <div className="sw-card-limits">
        <label>轮数<input type="number" min={1} value={rounds} disabled={locked} onChange={e => setAnswers({ ...answers, rounds: Math.max(1, Number(e.target.value) || 1) })} /></label>
        <label>分钟<input type="number" min={5} step={5} value={minutes} disabled={locked} onChange={e => setAnswers({ ...answers, minutes: Math.max(5, Number(e.target.value) || 5) })} /></label>
        <small>负责人建议 {num(s.rounds) ?? '?'} 轮 / {num(s.minutes) ?? '?'} 分钟，可以改</small>
      </div>
    </div>;
  }
  if (kind === 'delegation_result') {
    const OUT: Record<string, string> = { done: '完成', partial: '部分完成', unresolved: '无法完成' };
    const claims: any[] = Array.isArray(data.claims) ? data.claims : [];
    const verified = claims.filter(c => c.status === 'verified'), rest = claims.filter(c => c.status !== 'verified');
    const href = data.researchDossierId ? `/?preview=workbench&studio=research&file=1&dossier=${encodeURIComponent(data.researchDossierId)}` : null;
    return <div className="sw-card-body">
      <p className="sw-card-used">{OUT[data.outcome] ?? data.outcome ?? '—'} · 第 {num(data.version) ?? '?'} 版 · 已核实 {verified.length} / 共 {claims.length} 条{href && <> · <a href={href}>看完整过程 ↗</a></>}</p>
      <h5>已核实的结论 · {verified.length}</h5>
      {verified.length ? <ul>{verified.map(c => <li key={c.id}>{c.text}</li>)}</ul> : <p>没有通过独立核实的结论。</p>}
      {rest.length > 0 && <><h5>其余（没核实或有争议） · {rest.length}</h5><ul>{rest.slice(0, 8).map(c => <li key={c.id}><em className="sw-card-tag">{STATUS_ZH[c.status] ?? c.status}</em>{c.text}</li>)}{rest.length > 8 && <li>……还有 {rest.length - 8} 条，看完整过程</li>}</ul></>}
      {Array.isArray(data.evidence) && data.evidence.length > 0 && <><h5>证据 · {data.evidence.length}</h5><ul>{data.evidence.slice(0, 6).map((e: any) => <li key={e.id}>{e.title}{e.locator ? ` · ${e.locator}` : ''}</li>)}{data.evidence.length > 6 && <li>……还有 {data.evidence.length - 6} 条</li>}</ul></>}
      {Array.isArray(data.limits) && data.limits.length > 0 && <><h5>局限</h5><ul>{data.limits.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></>}
      {Array.isArray(data.openQuestions) && data.openQuestions.length > 0 && <><h5>还没解决</h5><ul>{data.openQuestions.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></>}
    </div>;
  }
  if (kind === 'swarm_scope') return <div className="sw-card-body">
    <p>计划 v{data.from ?? '?'} → v{data.to ?? '?'}</p>
    {Array.isArray(data.changes) && <><h5>改了什么</h5><ul>{data.changes.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul></>}
  </div>;
  return <div className="sw-card-body">
    <h5>还有分歧的结论 · {Array.isArray(data.claims) ? data.claims.length : 0}</h5>
    <ol className="sw-card-claims">{(Array.isArray(data.claims) ? data.claims : []).map((c: any) => <li key={c.id}>
      <p>{c.text}</p>{Array.isArray(c.sides) && c.sides.length > 0 && <ul>{c.sides.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}</li>)}</ol>
  </div>;
}

/** 批准时交给服务端的 answers：只有追加额度用得上。 */
export const cardAnswers = (kind: SwarmCardKind, data: Record<string, any>, a: SwarmCardAnswers) =>
  kind === 'swarm_extend' ? { rounds: a.rounds ?? num(data.suggest?.rounds) ?? 2, minutes: a.minutes ?? num(data.suggest?.minutes) ?? 15 } : undefined;
