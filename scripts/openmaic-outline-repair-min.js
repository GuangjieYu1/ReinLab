/* 单行版：课堂页控制台 → 整段粘贴 → 回车。
 *
 * 做两件事，一次跑完：
 *   1) 只读诊断：打印 scenes / outline / 列表 sceneCount 三列对照（「0 页」到底来自哪）；
 *   2) 需要时回填：按现存页面重建 outline 条目，先把 before/after JSON 打到控制台，
 *      confirm() 点确定才真正 PUT（走平台自己的保存接口，不改页面、不改标题）。
 *
 * 前提：必须在这门课的课堂页里执行（同源 + 带 owner cookie），否则 GET 404。
 * Chrome 若拦截粘贴，先在控制台手敲 allow pasting 回车。
 */
(async () => {
  const id = 'stage-ms5z68hOex';
  const j = async (p, o) => {
    const r = await fetch(p, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...o });
    const t = await r.text();
    try { return { ok: r.ok, s: r.status, b: JSON.parse(t) }; } catch { return { ok: r.ok, s: r.status, b: t }; }
  };
  const g = await j('/api/stages/' + id);
  console.log('GET /api/stages/' + id, '→', g.s, g.ok ? '' : g.b);
  if (!g.ok) return;
  const d = g.b;
  const sc = [...(d.scenes || [])].sort((a, b) => a.order - b.order);
  const pl = (d.outline && d.outline.outlines) || [];
  const list = await j('/api/stages');
  const row = ((list.b && list.b.stages) || []).find((x) => x.id === id);
  console.table({
    'scenes.length（播放器）': sc.length,
    'outline.outlines.length（目录）': pl.length,
    'sceneCount（列表元信息）': row ? row.sceneCount : '（列表里没有这门课）',
  });
  if (!sc.length) return console.warn('scenes 为空：先确认 STAGE_ID / owner 是否正确。');
  if (pl.length >= sc.length) return console.log('目录条目数与页数已齐，无需回填。');
  const byId = new Map(pl.map((e) => [e.id, e]));
  const byOrd = new Map(pl.map((e) => [e.order, e]));
  const out = sc.map((s) => {
    const l = (s.outlineId && byId.get(s.outlineId)) || byOrd.get(s.order) || {};
    const title = s.title || 'Page ' + s.order;
    return {
      id: s.outlineId || l.id || s.id,
      type: ['slide', 'quiz', 'interactive', 'pbl'].includes(s.type) ? s.type : 'slide',
      title,
      description: ((l.description || '').trim() || title),
      keyPoints: l.keyPoints || [],
      order: s.order,
    };
  });
  console.log('原始文档（备份用）↓\n' + JSON.stringify(d));
  console.log('before → after ↓\n' + JSON.stringify({ before: pl, after: out }, null, 1));
  if (!confirm('写入 ' + out.length + ' 条目录条目？（原始 JSON 已打印在上方，可留档）')) return;
  const payload = { stage: d.stage, scenes: d.scenes, outline: { ...(d.outline || {}), outlines: out, updatedAt: Date.now() }, ...(d.dslVersion ? { dslVersion: d.dslVersion } : {}) };
  const put = await j('/api/stages/' + id, { method: 'PUT', body: JSON.stringify(payload) });
  console.log('PUT →', put.s, put.b);
  const v = await j('/api/stages/' + id);
  console.log('回读：outlines =', v.b && v.b.outline && v.b.outline.outlines ? v.b.outline.outlines.length : '?', '· scenes =', v.b && v.b.scenes ? v.b.scenes.length : '?');
  if (v.b && v.b.outline) console.table(v.b.outline.outlines.map(({ order, title, type }) => ({ order, title, type })));
})();
