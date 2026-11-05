// 覆盖视图（18 广度返工 B4②）：按计划里的几条路线（问题被拆成的几个轴），
// 列出「已经查证过的名字」和「被提到但还没查的名字」。只给数据，不替负责人决定查不查。
//
// 名字怎么抽：不调模型，靠三组保守规则——
//   1) 拉丁名：2–4 个首字母大写的词（World Anvil / Aeon Timeline），或单个驼峰/全大写专名（Wikidata、OSRM）；
//   2) 中文名：书名号 / 引号里的（《…》「…」“…”），以及「数字+字」这种产品名（51码字）；
//   3) 明确的域名/仓库名（github.com/xxx、xxx.io）。
// 归到哪个轴：用这条名字证据是从哪条路线的结论引来的；没有证据的名，按它出现在哪条路线的结论里归轴。
// 「查证过」= 这条名字自己有一条证据（source.title/ref/quote 里出现），否则算「被提到但没查」。

export type CoverageAxis = {
  routeId: string;
  title: string;
  /** 已经有证据的名字（去重后）。 */
  checked: string[];
  /** 结论里提到、但没有任何一条证据指向的名字。 */
  mentioned: string[];
};

export type Coverage = {
  axes: CoverageAxis[];
  checkedTotal: number;
  mentionedTotal: number;
  /** 抽查用的样例，交付单里直接贴。 */
  note: string;
};

const STOPWORDS = new Set([
  "The",
  "This",
  "That",
  "There",
  "These",
  "Those",
  "However",
  "Because",
  "Figure",
  "Table",
  "Section",
  "Abstract",
  "Introduction",
  "Appendix",
  "AI",
  "LLM",
  "LLMs",
  "API",
  "URL",
  "DOI",
  "PDF",
  "OK",
]);

/** 从一段文字里抽候选名字（保守，宁可漏也不乱认）。 */
export function extractNames(text: string): string[] {
  const found = new Set<string>();
  const push = (value: string) => {
    const name = value.trim().replace(/^[「《“"]|[」》”"]$/g, "").trim();
    if (name.length < 2 || name.length > 60) return;
    if (STOPWORDS.has(name)) return;
    found.add(name);
  };
  // 1) 引号 / 书名号里的中文名
  for (const match of text.matchAll(/[「《“"]([^「」《》“”"]{2,40})[」》”"]/g)) {
    const inner = match[1].trim();
    // 引号里常常是一整句界面文字：太长或带句读的不当名字（D2 复测里出现过）。
    if (!/[\u4e00-\u9fa5]/.test(inner)) continue;
    if (inner.length > 12) continue;
    if (/[。，、；：！？,;]/.test(inner)) continue;
    push(inner);
  }
  // 2) 拉丁专名：2–4 个首字母大写的词
  for (const match of text.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){1,3})\b/g)) push(match[1]);
  // 3) 单个专名：驼峰（OpenStreetMap）、全大写缩写（OSRM）、长首字母大写词（Wikidata）
  for (const match of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+|[A-Z]{3,6}|[A-Z][a-z]{5,})\b/g))
    push(match[1]);
  // 4) 数字 + 中文字的产品名（51码字）
  for (const match of text.matchAll(/\b(\d{1,3}[\u4e00-\u9fa5]{2,6})\b/g)) push(match[1]);
  return [...found];
}

const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[\s\-_:：·、,，.。()（）]/g, "");

export type CoverageInput = {
  routes: Array<{ id: string; title: string }>;
  claims: Array<{ id: string; text: string; routeId: string | null; evidenceIds: string[] }>;
  evidence: Array<{
    id: string;
    claimIds: string[];
    source: { title?: string; ref?: string };
    locator: { quote?: string; section?: string } | null;
  }>;
};

/** 算出覆盖视图：每个轴的已查证 / 提到但没查。 */
export function buildCoverage(input: CoverageInput): Coverage {
  // 每条证据的「可匹配文本」：标题 + 来源 + 定位 + 摘句，归一化后用来判断「这个名字查过没有」。
  const evidenceTexts = input.evidence.map((entry) => ({
    id: entry.id,
    axis:
      entry.claimIds
        .map((id) => input.claims.find((claim) => claim.id === id)?.routeId)
        .find((routeId) => routeId) ?? "",
    text: normalize(
      [
        entry.source?.title ?? "",
        entry.source?.ref ?? "",
        entry.locator?.quote ?? "",
        entry.locator?.section ?? "",
      ].join(" "),
    ),
    raw: [
      entry.source?.title ?? "",
      entry.source?.ref ?? "",
      entry.locator?.quote ?? "",
      entry.locator?.section ?? "",
    ].join(" \n "),
  }));

  // 已查证：证据文本里抽出来的名字，加上「结论提到、同时证据文本里也出现过」的名字。
  const checked = new Map<string, { name: string; axis: string }>();
  const markChecked = (name: string, axis: string) => {
    const key = normalize(name);
    if (!checked.has(key)) checked.set(key, { name, axis });
  };
  for (const entry of evidenceTexts) for (const name of extractNames(entry.raw)) markChecked(name, entry.axis);

  const mentioned = new Map<string, { name: string; axis: string }>();
  for (const claim of input.claims) {
    const axisId = claim.routeId ?? "";
    for (const name of extractNames(claim.text)) {
      const key = normalize(name);
      if (checked.has(key)) continue;
      // 名字在证据里出现过（比如 World Anvil 对上 worldanvil.com）：算查证过。
      if (evidenceTexts.some((entry) => entry.text.includes(key))) {
        markChecked(name, axisId || evidenceTexts.find((entry) => entry.text.includes(key))?.axis || "");
        continue;
      }
      if (!mentioned.has(key)) mentioned.set(key, { name, axis: axisId });
    }
  }

  const routes = input.routes.map((route) => ({ id: String(route.id ?? ""), title: route.title }));
  const axes = routes.map((route) => ({
    routeId: route.id,
    title: route.title,
    checked: [...checked.values()]
      .filter((entry) => entry.axis === route.id)
      .map((entry) => entry.name)
      .sort()
      .slice(0, 30),
    mentioned: [...mentioned.values()]
      .filter((entry) => entry.axis === route.id)
      .map((entry) => entry.name)
      .sort()
      .slice(0, 30),
  }));
  // 没归到任何路线的：单列一个轴，别丢。
  const isKnownRoute = (axis: string) => routes.some((route) => route.id === axis);
  const orphanChecked = [...checked.values()].filter((entry) => !isKnownRoute(entry.axis));
  const orphanMentioned = [...mentioned.values()].filter((entry) => !isKnownRoute(entry.axis));
  if (orphanChecked.length || orphanMentioned.length)
    axes.push({
      routeId: "",
      title: "未归到路线",
      checked: orphanChecked.map((entry) => entry.name).sort().slice(0, 30),
      mentioned: orphanMentioned.map((entry) => entry.name).sort().slice(0, 30),
    });

  const checkedTotal = checked.size;
  const mentionedTotal = mentioned.size;
  return {
    axes,
    checkedTotal,
    mentionedTotal,
    note:
      mentionedTotal > 0
        ? `有 ${mentionedTotal} 个名字在结论里被提到、但没有任何证据指向它们。`
        : "结论里提到的名字都至少有一条证据。",
  };
}

/** 进缺口的那几行（每条轴一行，避免把缺口列表冲爆）。 */
export function coverageGaps(coverage: Coverage): string[] {
  return coverage.axes
    .filter((axis) => axis.mentioned.length > 0)
    .slice(0, 6)
    .map(
      (axis) =>
        `覆盖（${axis.title || axis.routeId}）：提到但没查证的名字 —— ${axis.mentioned
          .slice(0, 8)
          .join("、")}`,
    );
}
