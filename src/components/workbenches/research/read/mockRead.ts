import { LAYERS, PAPER, QA, QUIZ } from './paper';
import type { Estimate, FindingCard, Grade, PaperView, ReadAdapter, ReadEvent, ReadSnapshot, RunView } from './readTypes';

// 精读的 mock 数据源：剧本回放。
// 开局是「已经读完的一次精读」（原来的示例）；「新建精读」会从空档案开始，完整回放一次运行：
// 检索 → 下载全文要你批准 → 逐页读 → 分层讲解一层层长出来 → 检查题 → 发现卡 → 结算。
// 任何输入都回放同一篇示例论文；不连接模型，费用是示例数字。

const clock = () => new Date().toISOString();
const PAPER_VIEW: PaperView = { id: 'arxiv-1706.03762', title: PAPER.title, authors: PAPER.authors, venue: PAPER.venue, code: PAPER.code, access: 'full', license: 'arXiv · 开放获取', sections: PAPER.sections };
const FINDING: FindingCard = { id: 'f1', n: 1, text: '√dₖ 缩放不是细节：不缩放时 softmax 几乎退化成 one-hot，梯度消失，训练无法稳定。', refs: ['s321'], confidence: 'high', status: 'supported', at: clock() };
const ESTIMATE: Estimate = { id: 'est-demo', model: 'deepseek-v4-flash', maxCny: 0.82, steps: 48, note: '按每轮约 1 万输入 / 3 千输出 token、2 倍余量估算' };
const INTRO: ReadEvent = { type: 'agent', id: 'intro', text: `我读完了《${PAPER.title}》。左边是原文目录，中间是五层解析，从一句话开始。有任何地方没懂，直接问我，比如「为什么要除以根号 d」。` };

function done(): ReadSnapshot {
  return {
    dossier: { id: 'd-read-1', title: `${PAPER.title} · 精读` }, paper: PAPER_VIEW, layers: LAYERS, quizzes: QUIZ, findings: [FINDING],
    anims: ['scaled', 'pe', 'heads'], hasRepro: true, history: [INTRO],
    run: { id: 'run-1', state: 'done', query: PAPER.title, estimate: ESTIMATE, budgetCny: 5, spentCny: 0.11 },
  };
}
function empty(n: number): ReadSnapshot {
  return { dossier: { id: `d-read-new-${n}`, title: '新的精读' }, paper: null, layers: [], quizzes: [], findings: [], anims: [], hasRepro: false, history: [], run: { state: 'idle', budgetCny: 5, spentCny: null } };
}

export function mockReadAdapter(opts: { reduced?: boolean } = {}): ReadAdapter {
  let snap = done(), n = 0;
  const subs = new Set<(e: ReadEvent) => void>();
  let timers: number[] = [];
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
    step(500, () => { emit({ type: 'run', run: { state: 'done', step: undefined, spentCny: 0.11 } }); emit({ type: 'agent', id: 'fin', text: `读完了：5 层讲解、${QUIZ.length} 道检查题、1 条发现。实际花费 ¥0.11，预算 ¥5。有没懂的地方直接问我。` }); });
  }

  return {
    kind: 'mock',
    async load() { return structuredClone(snap); },
    subscribe(on) { subs.add(on); return () => { subs.delete(on); }; },
    async newReading() { stop(); n += 1; snap = empty(n); },
    async estimate(query, budgetCny) {
      emit({ type: 'run', run: { state: 'estimating', query, budgetCny } });
      await new Promise(r => setTimeout(r, opts.reduced ? 30 : 700));
      emit({ type: 'run', run: { state: 'confirm', estimate: ESTIMATE } });
      return ESTIMATE;
    },
    async start(_id, budgetCny) {
      emit({ type: 'run', run: { id: `run-${Date.now()}`, state: 'queued', budgetCny, spentCny: 0, unknownCost: false, step: '排队' } });
      let t = 0; const step = (ms: number, fn: () => void) => at((t += ms), fn);
      step(500, () => { emit({ type: 'run', run: { state: 'running', step: '检索论文' } }); emit({ type: 'tool', id: 'search', action: 'papers.search', label: `检索：${snap.run.query ?? PAPER.title}`, state: 'running' }); });
      step(1200, () => emit({ type: 'tool', id: 'search', action: 'papers.search', label: `检索：${snap.run.query ?? PAPER.title}`, state: 'done', ms: 1200, detail: `命中《${PAPER.title}》· ${PAPER.venue} · 开放获取` }));
      step(400, () => { emit({ type: 'approval', id: 'ap-fetch', action: 'papers.fetch', title: '下载全文到档案', effects: ['来源：arXiv 1706.03762（开放获取）', '约 2.1 MB，写入 papers/attention.pdf', '只写这一个文件，可以在档案里撤销'], risk: 'write', state: 'pending' }); emit({ type: 'run', run: { state: 'waiting', step: '等你批准下载全文', spentCny: 0.01 } }); });
    },
    async cancel() {
      stop();
      emit({ type: 'run', run: { state: 'cancelled', step: undefined, message: '你停止了这次精读；已经读到的内容保留在档案里。' } });
    },
    async decide(id, approve) {
      const ap = snap.history.find(e => e.type === 'approval' && e.id === id);
      if (!ap || ap.type !== 'approval' || ap.state !== 'pending') return;
      emit({ ...ap, state: approve ? 'approved' : 'rejected' });
      if (approve) { emit({ type: 'run', run: { state: 'running', step: '下载全文' } }); readAfterFetch(); }
      else emit({ type: 'run', run: { state: 'done', step: undefined, spentCny: 0.01, message: '你没有批准下载全文，这次只保留了检索结果。可以改为「只读摘要」再开始一次。' } });
    },
    async ask(text) {
      emit({ type: 'user', id: `u${Date.now()}`, text });
      await new Promise(r => setTimeout(r, opts.reduced ? 30 : 700));
      if (!snap.paper) { emit({ type: 'agent', id: `a${Date.now()}`, text: '先开始一次精读，读完再问我。' }); return; }
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
