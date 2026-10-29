/* eslint-disable */
/**
 * openmaic-outline-repair.js —— 只针对一门课堂的一次性「诊断 + 目录回填」脚本。
 *
 * 为什么需要脚本：OpenMAIC 的 agent 工具集里**没有**写 outline 的工具
 * （create_stage 铸出的 outline.outlines 永远是 []，generate_scene 只写 scene 行，
 *  patch_stage 只允许 /scenes/<order|id>，edit_deck / duplicate_scene 在 outline 为空时
 *  直接跳过同步）。所以「补大纲」只能走 HTTP：GET 整份文档 → 重建 outlines → PUT 回去。
 *  PUT /api/stages/{id} 是平台自己的保存路径（owner 作用域 + 结构校验），不新增能力。
 *
 * 怎么用：
 *   1. 在浏览器里打开这门课的课堂页（同一个部署，cookie 才带得上）
 *        https://<你的 OpenMAIC>/classroom/stage-ms5z68hOex
 *   2. DevTools → Console → 整段粘贴本文件 → 回车
 *   3. 先把 MODE 保持 'inspect'：它只读，打印一份对照表，判断「0 页」到底是
 *      目录（outline）空、还是列表元信息（sceneCount）陈旧。
 *   4. 确认要补目录，再把 MODE 改成 'repair' 重跑一次：先打印将要写入的 JSON，
 *      再确认 CONFIRM = true 才会真正 PUT。
 *
 * 安全性：
 *   - 只增加 outline.outlines 条目，不改任何 scene、不改 stage 名称、不删数据；
 *     generationComplete 保持原值（agent 建课本来就是 true），所以播放/编辑行为不变。
 *   - 每条条目按真实 scene 的 order / id / type / title 生成，id 优先沿用
 *     scene.outlineId，其次 scene.id —— 和 mergeStageOutline 的配对规则一致。
 *   - 写之前把原始 GET 结果完整打印出来（可复制留档），出问题用同一份 JSON 再 PUT 即可回滚。
 *
 * 注意：本文件必须在**课堂页**的控制台里跑（同源 + 同 cookie）。跑到别的域名下
 * 只会拿到一个新的匿名 owner，GET 会 404。
 */

const STAGE_ID = 'stage-ms5z68hOex';

/** 'inspect' = 只读诊断；'repair' = 预览 + 写入。 */
const MODE = 'inspect';

/** repair 模式下必须改成 true 才会真的 PUT。 */
const CONFIRM = false;

const api = async (path, init) => {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
};

const OUTLINE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);
const outlineType = (type) => (OUTLINE_TYPES.has(type) ? type : 'slide');

/** 按 scene 顺序生成摘要级 outline 条目；已存在的条目只补缺、不覆盖原有描述。 */
const buildOutlines = (doc) => {
  const scenes = [...(doc.scenes ?? [])]
    .filter((scene) => scene && typeof scene.order === 'number')
    .sort((a, b) => a.order - b.order);
  const previous = Array.isArray(doc.outline?.outlines) ? doc.outline.outlines : [];
  const byOutlineId = new Map(previous.map((entry) => [entry.id, entry]));
  const byOrder = new Map(previous.map((entry) => [entry.order, entry]));

  const entries = scenes.map((scene) => {
    const linked =
      (scene.outlineId ? byOutlineId.get(scene.outlineId) : undefined) ?? byOrder.get(scene.order);
    return {
      // 配对身份：mergeStageOutline 先看 outlineId，再看 order —— 两者满足其一即可命中。
      id: (scene.outlineId ?? linked?.id ?? scene.id),
      type: outlineType(scene.type),
      title: scene.title ?? `第 ${scene.order} 页`,
      description: linked?.description?.trim() || scene.title || `第 ${scene.order} 页`,
      keyPoints: Array.isArray(linked?.keyPoints) ? [...linked.keyPoints] : [],
      order: scene.order,
    };
  });

  // 只补「已有页面对应的条目」；生成尚未完成的课（generationComplete !== true）里
  // 还可能有「已规划、页面未落库」的条目，那些原样保留，否则回填会把待生成页抹掉。
  if (doc.outline?.generationComplete === true) return entries;
  const consumed = new Set(entries.map((entry) => entry.id));
  const consumedOrders = new Set(entries.map((entry) => entry.order));
  const plannedOnly = previous.filter(
    (entry) => !consumed.has(entry.id) && !consumedOrders.has(entry.order),
  );
  return [...entries, ...plannedOnly].sort((a, b) => a.order - b.order);
};

const main = async () => {
  console.log(`\n=== OpenMAIC outline repair · ${STAGE_ID} · MODE=${MODE} ===\n`);

  // ── 1. 读整份文档（课堂页同源 → 带得上 owner cookie）
  const doc = await api(`/api/stages/${STAGE_ID}`);
  if (!doc.ok) {
    console.error(
      `GET /api/stages/${STAGE_ID} → ${doc.status}`,
      doc.body,
      '\n提示：必须在**这门课的课堂页**（同部署、同浏览器）里执行；否则拿到的是另一个匿名 owner。',
    );
    return;
  }
  const document = doc.body;
  const scenes = [...(document.scenes ?? [])].sort((a, b) => a.order - b.order);
  const planned = Array.isArray(document.outline?.outlines) ? document.outline.outlines : [];

  // ── 2. 读列表索引（左栏/课程行用的就是这份 sceneCount）
  const list = await api('/api/stages');
  const rows = Array.isArray(list.body?.stages) ? list.body.stages : [];
  const row = rows.find((item) => item.id === STAGE_ID);

  // ── 3. 对照表：三个「页数」到底谁在说谎
  console.table({
    'GET /api/stages → sceneCount（左栏行元信息）': row ? row.sceneCount : '（列表里没有这门课）',
    'GET /api/stages/{id} → scenes.length（播放器）': scenes.length,
    'outline.outlines.length（目录）': planned.length,
  });
  console.log('前 8 个 scene：', scenes.slice(0, 8).map((s) => `${s.order}. ${s.title} [${s.type}]`));
  console.log('document.outline（原样）：', document.outline);

  if (scenes.length === 0) {
    console.warn('这份文档的 scenes 是空的 —— 播放器不可能播 8 页，先确认 STAGE_ID / owner 是否正确。');
    return;
  }
  if (row && row.sceneCount !== scenes.length) {
    console.warn(
      `注意：列表索引的 sceneCount=${row.sceneCount} 与真实 scenes=${scenes.length} 不一致。` +
        '这说明「0 页」来自**索引陈旧**，和 outline 无关；刷新工作区/重新拉一次列表就能恢复。',
    );
  }
  if (planned.length === scenes.length) {
    console.log('目录条目数与页数一致，无需回填。');
    return;
  }

  // ── 4. 构造新目录（只增不减：已有条目按 id/order 保留原描述）
  const outlines = buildOutlines(document);
  const nextOutline = {
    ...(document.outline ?? {}),
    outlines,
    updatedAt: Date.now(),
  };
  console.log(`将写入 ${outlines.length} 条目录条目：`);
  console.table(outlines.map(({ order, title, type }) => ({ order, title, type })));

  const payload = { ...document, outline: nextOutline };

  if (MODE !== 'repair') {
    console.log(
      '\n【inspect 模式 · 未写入】原始 GET 结果留档 ↓\n' +
        JSON.stringify(document),
      '\n若要写入：把 MODE 改成 \'repair\'、CONFIRM 改成 true 后重跑。',
    );
    return;
  }
  if (!CONFIRM) {
    console.log('【repair 预览 · 未写入】将提交的完整 payload ↓\n', payload);
    console.log('把 CONFIRM 改成 true 才会真正 PUT。');
    return;
  }

  // ── 5. 写入：PUT 是平台自己的保存路径（owner 作用域 + 文档结构校验）
  const put = await api(`/api/stages/${STAGE_ID}`, {
    method: 'PUT',
    body: JSON.stringify({ stage: payload.stage, scenes: payload.scenes, outline: nextOutline }),
  });
  console.log(`PUT /api/stages/${STAGE_ID} → ${put.status}`, put.body);
  if (!put.ok) {
    console.error('写入失败。原始文档已在上方打印，可用同一份 JSON 重新 PUT 回滚。');
    return;
  }

  // ── 6. 回读核对
  const after = await api(`/api/stages/${STAGE_ID}`);
  const afterPlanned = Array.isArray(after.body?.outline?.outlines) ? after.body.outline.outlines : [];
  console.log(`回读：outline.outlines.length=${afterPlanned.length}，scenes.length=${(after.body?.scenes ?? []).length}`);
  console.table(
    afterPlanned.map(({ order, title, type }) => ({ order, title, type })),
  );
};

main().catch((error) => console.error('脚本异常：', error));

/* 附：删除这门课（不可恢复，按需手动执行；支持级联删除 scenes / outline）
 *   await fetch(`/api/stages/${STAGE_ID}`, { method: 'DELETE', credentials: 'same-origin' }).then(r => r.text());
 * 左栏课程行的菜单里也有删除入口；agent 工具集里**没有** delete_stage。
 */
