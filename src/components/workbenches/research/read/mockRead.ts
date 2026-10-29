import { LAYERS, PAPER, QA, QUIZ } from './paper';
import type { Estimate, FindingCard, Grade, PaperCandidate, PaperView, ReadAdapter, ReadEvent, ReadSnapshot, RunView } from './readTypes';

/** 示例论文库：检索按关键词匹配。只有 Attention 备了完整讲解；其他几篇选中后如实说明「要在真实模式下生成」。 */
const CATALOG: (PaperCandidate & { arxiv: string; keys: string[]; size: string; pages: number })[] = [
  { id: 'arxiv-2210.03629', pages: 33, arxiv: '2210.03629', title: 'ReAct: Synergizing Reasoning and Acting in Language Models', authors: 'Yao 等 · Princeton / Google', venue: 'ICLR 2023', access: 'full', size: '1.4 MB', keys: ['react', 'reasoning', 'acting', 'agent', '推理', '行动', '智能体'] },
  { id: 'arxiv-1706.03762', pages: 15, arxiv: '1706.03762', title: PAPER.title, authors: PAPER.authors, venue: PAPER.venue, access: 'full', size: '2.1 MB', keys: ['attention', 'transformer', '注意力', 'all you need'] },
  { id: 'arxiv-2106.09685', pages: 26, arxiv: '2106.09685', title: 'LoRA: Low-Rank Adaptation of Large Language Models', authors: 'Hu 等 · Microsoft', venue: 'ICLR 2022', access: 'full', size: '1.6 MB', keys: ['lora', 'low-rank', '低秩', '微调', 'fine-tun'] },
  { id: 'arxiv-2309.14717', pages: 16, arxiv: '2309.14717', title: 'QA-LoRA: Quantization-Aware Low-Rank Adaptation of Large Language Models', authors: 'Xu 等', venue: 'ICLR 2024', access: 'full', size: '0.7 MB', keys: ['qa-lora', 'quantization', '量化', 'lora'] },
  { id: 'arxiv-2101.03961', pages: 40, arxiv: '2101.03961', title: 'Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity', authors: 'Fedus, Zoph, Shazeer · Google', venue: 'JMLR 2022', access: 'full', size: '1.9 MB', keys: ['switch', 'moe', 'mixture', 'sparse', '专家', '稀疏', 'routing', '路由'] },
  { id: 'arxiv-2302.04761', pages: 17, arxiv: '2302.04761', title: 'Toolformer: Language Models Can Teach Themselves to Use Tools', authors: 'Schick 等 · Meta AI', venue: 'NeurIPS 2023', access: 'full', size: '1.1 MB', keys: ['toolformer', 'tool', '工具', 'agent', '智能体'] },
];
function search(query: string) {
  const q = query.toLowerCase();
  return CATALOG.map(p => ({ p, score: p.keys.filter(k => q.includes(k)).length * 2 + (q.includes(p.arxiv) ? 10 : 0) + (p.title.toLowerCase().includes(q.trim()) && q.trim().length > 2 ? 3 : 0) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map(x => x.p);
}

// 精读的 mock 数据源：剧本回放。
// 开局是「已经读完的一次精读」（原来的示例）；「新建精读」从空档案开始：
// 先在对话里说想读什么 → 助手检索、拿不准就追问 → 候选卡片里选一篇 → 按页数预估 → 你确认 →
// 下载全文要你批准 → 逐页读 → 分层讲解一层层长出来 → 检查题 → 发现卡 → 结算。
// 论文库是 6 篇真实论文，只有 Attention 备了讲解；选别的会如实说明。不连接模型，费用是示例数字。

const clock = () => new Date().toISOString();
const PAPER_VIEW: PaperView = { id: 'arxiv-1706.03762', title: PAPER.title, authors: PAPER.authors, venue: PAPER.venue, code: PAPER.code, access: 'full', license: 'arXiv · 开放获取', sections: PAPER.sections };
const FINDING: FindingCard = { id: 'f1', n: 1, text: '√dₖ 缩放不是细节：不缩放时 softmax 几乎退化成 one-hot，梯度消失，训练无法稳定。', refs: ['s321'], confidence: 'high', status: 'supported', at: clock() };
const ESTIMATE: Estimate = { id: 'est-demo', model: 'deepseek-v4-flash', maxCny: 0.82, steps: 48, note: '按每轮约 1 万输入 / 3 千输出 token、2 倍余量估算' };
const estimateFor = (pages: number): Estimate => ({ id: `est-${pages}`, model: 'deepseek-v4-flash', maxCny: +(0.2 + pages * 0.04).toFixed(2), steps: 48, note: `按 ${pages} 页、每轮约 1 万输入 / 3 千输出 token、2 倍余量估算` });
const CLARIFY_CAP = 0.5, CLARIFY_STEP = 0.003;
const INTRO: ReadEvent = { type: 'agent', id: 'intro', text: `我读完了《${PAPER.title}》。左边是原文目录，中间是五层解析，从一句话开始。有任何地方没懂，直接问我，比如「为什么要除以根号 d」。` };

function done(): ReadSnapshot {
  return {
    dossier: { id: 'd-read-1', title: `${PAPER.title} · 精读` }, paper: PAPER_VIEW, layers: LAYERS, quizzes: QUIZ, findings: [FINDING],
    anims: ['scaled', 'pe', 'heads'], hasRepro: true, history: [INTRO],
    run: { id: 'run-1', state: 'done', query: PAPER.title, estimate: ESTIMATE, budgetCny: 5, spentCny: 0.11 },
  };
}
function empty(n: number): ReadSnapshot {
  return { dossier: { id: `d-read-new-${n}`, title: '新的精读' }, paper: null, layers: [], quizzes: [], findings: [], anims: [], hasRepro: false, history: [], run: { state: 'idle', budgetCny: 5, spentCny: null, clarifySpentCny: 0, clarifyCapCny: CLARIFY_CAP } };
}

export function mockReadAdapter(opts: { reduced?: boolean } = {}): ReadAdapter {
  let snap = done(), n = 0;
  const subs = new Set<(e: ReadEvent) => void>();
  let timers: number[] = [];
  let chosen: (typeof CATALOG)[number] | null = null;
  const emit = (e: ReadEvent) => {
    // 同步到快照，刷新或切换后能恢复
    if (e.type === 'run') snap = { ...snap, run: { ...snap.run, ...e.run } as RunView };
    else if (e.type === 'paper') snap = { ...snap, paper: e.paper };
    else if (e.type === 'section' && snap.paper) snap = { ...snap, paper: { ...snap.paper, sections: [...snap.paper.sections.filter(s => s.id !== e.section.id), e.section] } };
    else if (e.type === 'layer') snap = { ...snap, layers: [...snap.layers.filter(l => l.id !== e.layer.id), e.layer] };
    else if (e.type === 'quiz') snap = { ...snap, quizzes: [...snap.quizzes.filter(q => q.id !== e.quiz.id), e.quiz] };
    else if (e.type === 'finding') snap = { ...snap, findings: [...snap.findings.filter(f => f.id !== e.finding.id), e.finding] };
    else snap = { ...snap, history: [...snap.history.filter(x => !(x.type === e.type && 'id' in x && 'id' in e && x.id === e.id)), e] };
    subs.forEach(f => f(e));
  };
  const at = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, opts.reduced ? Math.min(ms, 60) : ms)); };
  const stop = () => { timers.forEach(clearTimeout); timers = []; };

  // 批准下载全文之后的后半程
  function readAfterFetch() {
    let t = 0; const step = (ms: number, fn: () => void) => at((t += ms), fn);
    step(500, () => { emit({ type: 'tool', id: 'fetch', action: 'papers.fetch', label: '下载全文 · arXiv 1706.03762', state: 'done', ms: 900, detail: '2.1 MB · 写入 papers/attention.pdf · 开放获取' }); emit({ type: 'paper', paper: { ...PAPER_VIEW, sections: [] } }); emit({ type: 'run', run: { state: 'running', step: '逐页阅读', spentCny: 0.02 } }); });
    step(300, () => emit({ type: 'tool', id: 'pages', action: 'papers.pages', label: '按页读取 · p.1–p.9', state: 'running' }));
    PAPER.sections.forEach(s => step(260, () => emit({ type: 'section', section: s })));
    step(200, () => { emit({ type: 'tool', id: 'pages', action: 'papers.pages', label: '按页读取 · p.1–p.9', state: 'done', ms: 2100, detail: `${PAPER.sections.length} 段原文 · 页码锚点已核对` }); emit({ type: 'run', run: { step: '写分层讲解', spentCny: 0.05 } }); });
    LAYERS.forEach((l, i) => step(i ? 1100 : 600, () => emit({ type: 'layer', layer: l })));
    step(700, () => { emit({ type: 'run', run: { step: '出检查题', spentCny: 0.09 } }); QUIZ.forEach(q => emit({ type: 'quiz', quiz: q })); });
    step(800, () => emit({ type: 'finding', finding: { ...FINDING, at: clock() } }));
    step(500, () => { emit({ type: 'run', run: { state: 'done', endReason: 'completed', step: undefined, spentCny: 0.11 } }); emit({ type: 'agent', id: 'fin', text: `读完了：5 层讲解、${QUIZ.length} 道检查题、1 条发现。实际花费 ¥0.11，预算 ¥5。有没懂的地方直接问我。` }); });
  }

  return {
    kind: 'mock',
    async load() { return structuredClone(snap); },
    subscribe(on) { subs.add(on); return () => { subs.delete(on); }; },
    async newReading() { stop(); n += 1; snap = empty(n); },
    async clarify(text) {
      emit({ type: 'user', id: `u${Date.now()}`, text });
      const spent = snap.run.clarifySpentCny ?? 0, cap = snap.run.clarifyCapCny ?? CLARIFY_CAP;
      if (snap.run.clarifyBlocked) { emit({ type: 'agent', id: `a${Date.now()}`, text: snap.run.clarifyBlocked.text }); return; }
      // 演示「上一段澄清没结束」：真实模式下在途用量未核对时会这样
      if (text.trim() === '模拟卡住') { emit({ type: 'run', run: { clarifyBlocked: { reason: 'stuck', text: '上一段澄清还没结束，用量也还没核对完，新的话先发不出去。可以结束这段澄清再重新说。' } } }); return; }
      if (spent + CLARIFY_STEP > cap) {
        const t = `澄清已经用到 ¥${cap} 的上限，我先停下。可以在「预算余额」里加一点，或者直接给我完整标题、arXiv 编号。`;
        emit({ type: 'run', run: { clarifyBlocked: { reason: 'cap', text: t } } }); emit({ type: 'agent', id: `a${Date.now()}`, text: t }); return;
      }
      emit({ type: 'tool', id: `s${Date.now()}`, action: 'papers.search', label: `检索：${text}`, state: 'done', ms: 900, detail: '只检索公开元数据，不下载' });
      emit({ type: 'run', run: { clarifySpentCny: +(spent + CLARIFY_STEP).toFixed(3) } });
      await new Promise(r => setTimeout(r, opts.reduced ? 30 : 800));
      const recommend = /推荐/.test(text);
      const found = recommend ? ['arxiv-2210.03629', 'arxiv-2302.04761', 'arxiv-2106.09685'].map(id => CATALOG.find(p => p.id === id)!) : search(text);
      const id = `pick-${Date.now()}`;
      const cands: PaperCandidate[] = found.map(({ id, title, authors, venue, access, pages }) => ({ id, title, authors, venue, access, pages, note: id === PAPER_VIEW.id ? undefined : '示例未备讲解' }));
      if (!found.length) { emit({ type: 'agent', id: `a${Date.now()}`, text: `没找到和「${text}」对得上的论文。能多说一点吗？比如完整标题、作者、年份，或者它讲的是什么问题。` }); return; }
      const ambiguous = /^\s*react\s*$/i.test(text);
      emit({ type: 'agent', id: `a${Date.now()}`, text: recommend ? '按最近常被精读、又有开放全文的挑了三篇，选一篇；都不想读就说说你关心的方向。' : ambiguous
        ? '你说的 react，是指让语言模型「边推理边行动」的 ReAct 论文，还是前端框架 React？前端框架不是论文，研究台读不了；如果是前者，就是下面这篇。'
        : found.length === 1 ? '找到一篇，是这篇吗？' : `找到 ${found.length} 篇，点你要读的那篇；都不是就再描述一下。` });
      emit({ type: 'pick', id, query: text, candidates: cands, state: 'pending' });
    },
    async pick(id, candidateId) {
      const pk = snap.history.find(e => e.type === 'pick' && e.id === id);
      if (!pk || pk.type !== 'pick' || (pk.state !== 'pending' && (chosen || !candidateId))) return;
      emit({ ...pk, state: 'answered', chosen: candidateId ?? undefined });
      if (!candidateId) { emit({ type: 'agent', id: `a${Date.now()}`, text: '好，那再描述一下？作者、年份、讲的问题，或者你在哪里看到它的，都可以。' }); return; }
      const p = CATALOG.find(x => x.id === candidateId)!;
      chosen = p;
      const { id: cid, title, authors, venue, access, pages } = p;
      emit({ type: 'run', run: { chosen: { id: cid, title, authors, venue, access, pages }, query: title, state: 'idle', estimate: undefined } });
      emit({ type: 'agent', id: `a${Date.now()}`, text: `好，读《${title}》（${pages} 页）。中间可以按这篇的长度预估费用了。` });
    },
    async raiseBudget(scope, addCny) {
      if (scope === 'clarify') {
        const cap = +((snap.run.clarifyCapCny ?? CLARIFY_CAP) + addCny).toFixed(2);
        emit({ type: 'run', run: { clarifyCapCny: cap, clarifyBlocked: snap.run.clarifyBlocked?.reason === 'cap' ? undefined : snap.run.clarifyBlocked } });
        emit({ type: 'agent', id: `a${Date.now()}`, text: `澄清上限加到 ¥${cap}，可以接着说了。` });
      } else {
        const b = +(snap.run.budgetCny + addCny).toFixed(2);
        emit({ type: 'run', run: { budgetCny: b } });
        emit({ type: 'agent', id: `a${Date.now()}`, text: `这次精读的预算加到 ¥${b}。` });
      }
    },
    async cancelClarify() {
      emit({ type: 'run', run: { clarifyBlocked: undefined } });
      emit({ type: 'agent', id: `a${Date.now()}`, text: '上一段澄清已结束，已用的照实记账。重新说说想读哪篇？' });
    },
    async unchoose() {
      chosen = null;
      emit({ type: 'run', run: { chosen: undefined, state: 'idle', estimate: undefined } });
      emit({ type: 'agent', id: `a${Date.now()}`, text: '好，换一篇。想读什么？' });
    },
    async estimate(candidateId, budgetCny) {
      const p = CATALOG.find(x => x.id === candidateId);
      emit({ type: 'run', run: { state: 'estimating', budgetCny } });
      await new Promise(r => setTimeout(r, opts.reduced ? 30 : 700));
      const est = p ? (p.id === PAPER_VIEW.id ? ESTIMATE : estimateFor(p.pages)) : ESTIMATE;
      emit({ type: 'run', run: { state: 'confirm', estimate: est } });
      return est;
    },
    async start(_id, budgetCny) {
      const p = chosen; if (!p) return;
      emit({ type: 'run', run: { id: `run-${Date.now()}`, state: 'queued', budgetCny, spentCny: 0, unknownCost: false, step: '排队' } });
      at(500, () => {
        emit({ type: 'approval', id: 'ap-fetch', action: 'papers.fetch', title: '下载全文到档案', effects: [`来源：arXiv ${p.arxiv}（开放获取）`, `约 ${p.size}，写入 papers/${p.arxiv}.pdf`, '只写这一个文件，可以在档案里撤销'], risk: 'write', state: 'pending' });
        emit({ type: 'run', run: { state: 'waiting', step: '等你批准下载全文', spentCny: 0 } });
      });
    },
    async cancel() {
      stop();
      emit({ type: 'run', run: { state: 'cancelled', endReason: 'cancelled', step: undefined, message: '你停止了这次精读；已经读到的内容保留在档案里。' } });
    },
    async decide(id, approve) {
      const ap = snap.history.find(e => e.type === 'approval' && e.id === id);
      if (!ap || ap.type !== 'approval' || ap.state !== 'pending') return;
      emit({ ...ap, state: approve ? 'approved' : 'rejected' });
      if (approve && chosen && chosen.id !== PAPER_VIEW.id) {
        const c = chosen;
        emit({ type: 'tool', id: 'fetch', action: 'papers.fetch', label: `下载全文 · arXiv ${c.arxiv}`, state: 'done', ms: 800, detail: `${c.size} · 写入 papers/${c.arxiv}.pdf · 开放获取` });
        emit({ type: 'paper', paper: { id: c.id, title: c.title, authors: c.authors, venue: c.venue, access: c.access, license: 'arXiv · 开放获取', sections: [] } });
        emit({ type: 'run', run: { state: 'done', step: undefined, spentCny: 0.02, message: `示例数据只为《${PAPER.title}》准备了讲解内容。《${c.title}》的分层讲解、检查题和发现，要在真实模式下由模型生成。` } });
        emit({ type: 'agent', id: 'demo-only', text: `示例到此为止：这篇论文的讲解要在真实模式下生成。想看完整的示例流程，可以新建精读，选《${PAPER.title}》。` });
      } else if (approve) { emit({ type: 'run', run: { state: 'running', step: '下载全文' } }); readAfterFetch(); }
      else emit({ type: 'run', run: { state: 'cancelled', endReason: 'rejected', step: undefined, spentCny: 0, message: '你没有批准下载全文，这次没有读。可以换一篇再开始。' } });
    },
    async ask(text) {
      emit({ type: 'user', id: `u${Date.now()}`, text });
      await new Promise(r => setTimeout(r, opts.reduced ? 30 : 700));
      const hit = QA.find(x => x.keys.test(text));
      emit(hit ? { type: 'agent', id: `a${Date.now()}`, text: hit.answer, refs: hit.refs, anim: hit.anim }
        : { type: 'agent', id: `a${Date.now()}`, text: '这个问题论文里没有直接回答。可以派给群研去查后续工作。' });
    },
    async grade(quizId, answer): Promise<Grade> {
      const q = snap.quizzes.find(x => x.id === quizId); if (!q?.keys) return 'miss';
      const hit = q.keys.filter(g => g.some(k => answer.toLowerCase().includes(k.toLowerCase()))).length;
      return hit === q.keys.length ? 'ok' : hit ? 'part' : 'miss';
    },
  };
}
