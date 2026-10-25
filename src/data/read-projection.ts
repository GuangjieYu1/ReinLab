import type {
  ReadSnapshot,
  ReadEvent,
  RunView,
  PaperView,
  LayerCard,
  QuizCard,
  FindingCard,
} from "../components/workbenches/research/read/readTypes";
export type ReadWire = {
  dossier: { id: string; title: string };
  clarification?: {
    chosen: any;
    spentCny: number;
    capCny: number;
    unknownCost: boolean;
    history: ReadEvent[];
  };
  cursor: number;
  run: any;
  papers: any[];
  pages: any[];
  approvals: any[];
};
const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
const label: Record<string, string> = {
  "papers.search": "检索论文",
  "papers.fetch": "下载全文",
  "papers.pages": "按页读取原文",
  "files.write": "写入档案文件",
  "cards.card.layer": "写入分层讲解",
  "cards.card.quiz": "写入检查题",
  "cards.card.finding": "记录发现",
};
export function projectReading(
  data: ReadWire,
  events: any[],
  selectedAsset?: string
): ReadSnapshot {
  const r = data.run;
  const candidates = data.papers.filter(
    (p) => !r || p.runId === r.id || data.pages.some((x) => x.assetId === p.id)
  );
  const p = candidates.find((p) => p.id === selectedAsset) ?? candidates[0];
  const pages = data.pages.filter((x) => p && x.assetId === p.id);
  const sections = new Map<
    number,
    { id: string; no: string; title: string; gist: string[] }
  >();
  for (const page of pages) {
    if (!Number.isSafeInteger(page.page) || page.page < 1 || page.page > 1000)
      continue;
    sections.set(page.page, {
      id: "p" + page.page,
      no: "p." + page.page,
      title: "原文第 " + page.page + " 页",
      gist: typeof page.quote === "string" && page.quote ? [page.quote] : [],
    });
  }
  const refs = (anchors: any): string[] | null => {
    if (
      !Array.isArray(anchors) ||
      !anchors.length ||
      anchors.some(
        (a) =>
          !object(a) ||
          a.paperId !== p?.id ||
          !sections.has(a.page) ||
          typeof a.quote !== "string" ||
          !a.quote.trim()
      )
    )
      return null;
    for (const a of anchors) {
      const s = sections.get(a.page)!;
      if (!s.gist.includes(a.quote)) s.gist.push(a.quote);
    }
    return [...new Set(anchors.map((a) => "p" + a.page))];
  };
  const layers: LayerCard[] = [],
    quizzes: QuizCard[] = [],
    findings: FindingCard[] = [],
    history: ReadEvent[] = [];
  if (r?.query)
    history.push({ type: "user", id: "query:" + r.id, text: r.query });
  let finalText: any;
  const assistant = new Set<string>(),
    textParts = new Map<string, any>();
  for (const e of events) {
    if (!r || e.runId !== r.id) continue;
    const v = e.payload ?? {},
      c = v.card;
    const props = v.properties ?? {};
    if (props.info?.role === "assistant") assistant.add(props.info.id);
    if (props.part?.type === "text" && typeof props.part.text === "string")
      textParts.set(props.part.id, { ...props.part, seq: e.seq });
    if (
      e.kind === "card" &&
      e.action === "card_created" &&
      object(c) &&
      typeof v.cardId === "string"
    ) {
      if (
        v.cardType === "layer" &&
        c.paperId === p?.id &&
        Array.isArray(c.body)
      ) {
        const body = c.body.map((b: any) => ({
          text: b.text,
          refs: refs(b.refs),
        }));
        if (
          typeof c.no === "string" &&
          typeof c.title === "string" &&
          typeof c.en === "string" &&
          body.length &&
          body.every((b: any) => typeof b.text === "string" && b.refs)
        )
          layers.push({
            id: v.cardId,
            no: c.no,
            title: c.title,
            en: c.en,
            body,
          } as LayerCard);
      } else if (
        v.cardType === "quiz" &&
        c.paperId === p?.id &&
        typeof c.q === "string" &&
        typeof c.layer === "string"
      )
        quizzes.push({
          id: v.cardId,
          q: c.q,
          layer: c.layer,
          ...(typeof c.hint === "string" ? { hint: c.hint } : {}),
        });
      else if (v.cardType === "finding") {
        const anchors = refs(c.evidence);
        if (
          anchors &&
          Number.isSafeInteger(c.n) &&
          c.n > 0 &&
          typeof c.text === "string" &&
          ["low", "mid", "high"].includes(c.confidence) &&
          ["hypothesis", "supported", "refuted"].includes(c.status) &&
          typeof c.at === "string"
        )
          findings.push({
            id: v.cardId,
            n: c.n,
            text: c.text,
            refs: anchors,
            confidence: c.confidence,
            status: c.status,
            at: c.at,
          });
      } else if (v.cardType === "answer") {
        const anchors = refs(c.citations);
        if (anchors && typeof c.text === "string")
          history.push({
            type: "agent",
            id: v.cardId,
            text: c.text,
            refs: anchors,
          });
      }
    }
    if (e.action === "capability.call" && typeof v.capability === "string") {
      const s = v.summary ?? {};
      const action = v.capability;
      const asset = data.papers.find((paper) => paper.id === s.assetId);
      const detail = [
        Number.isSafeInteger(s.count) ? "命中 " + s.count + " 篇" : null,
        typeof s.license === "string" ? "许可：" + s.license : null,
        Number.isSafeInteger(asset?.sizeBytes)
          ? "文件 " + asset.sizeBytes + " 字节"
          : null,
        Array.isArray(s.pages) ? "页码：" + s.pages.join("、") : null,
      ]
        .filter(Boolean)
        .join("；");
      history.push({
        type: "tool",
        id: "tool:" + e.seq,
        action,
        label:
          (label[action] ?? "能力调用") +
          (typeof s.query === "string"
            ? "：" + s.query
            : typeof asset?.title === "string"
            ? " · " + asset.title
            : ""),
        state: v.success === true ? "done" : "failed",
        detail: detail || undefined,
        ...(Number.isFinite(v.durationMs) ? { ms: v.durationMs } : {}),
      });
    }
  }
  for (const q of quizzes) {
    const matches = layers.filter((l) => l.id === q.layer || l.no === q.layer);
    if (matches.length === 1) q.layer = matches[0].id;
  }
  if (
    r &&
    ["completed", "failed", "cancelled", "interrupted"].includes(r.state)
  ) {
    for (const part of textParts.values())
      if (
        assistant.has(part.messageID) &&
        (!finalText || part.seq > finalText.seq)
      )
        finalText = part;
    if (finalText) {
      const text = [...textParts.values()]
        .filter((t) => t.messageID === finalText.messageID)
        .sort((a, b) => a.seq - b.seq)
        .map((t) => t.text)
        .join("\n");
      history.push({
        type: "agent",
        id: "summary:" + r.id + ":" + finalText.messageID,
        text,
      });
    }
  }
  for (const a of data.approvals) {
    if (a.runId !== r?.id) continue;
    if (
      a.kind === "permission" &&
      !a.sent &&
      (["approved", "rejected"].includes(a.state) ||
        (a.state === "pending" &&
          ["running", "waiting"].includes(r.state) &&
          !r.endedAt))
    )
      history.push({
        type: "approval",
        id: a.id,
        action: a.action,
        title: a.title,
        effects: a.effects,
        risk: a.risk,
        state: a.state,
      });
    else if (a.state === "approved" || a.state === "rejected")
      history.push({
        type: "approval",
        id: a.id,
        action: a.action,
        title: a.title,
        effects: a.effects,
        risk: a.risk,
        state: a.state,
      });
    else
      history.push({
        type: "tool",
        id: "approval-note:" + a.id,
        action: a.action,
        label:
          !["running", "waiting"].includes(r.state) || r.endedAt
            ? "运行已结束，审批不可再次执行"
            : a.kind === "question"
            ? "请在收件箱回答原生问题"
            : a.state === "expired"
            ? "审批已过期"
            : "审批结果待核对，不能重复执行",
        state: a.state === "expired" ? "failed" : "running",
      });
  }
  const states: Record<string, RunView["state"]> = {
    queued: "queued",
    running: "running",
    waiting: "waiting",
    paused_budget: "waiting",
    completed: "done",
    failed: "failed",
    cancelled: "cancelled",
    interrupted: "failed",
  };
  const run: RunView = r
    ? {
        id: r.id,
        state: states[r.state] ?? "failed",
        query: r.query,
        budgetCny: r.budgetCny,
        spentCny: r.spentCny,
        unknownCost: r.usageUnknown === true,
        ...(r.state === "paused_budget" ? { step: "预算暂停，等待核对" } : {}),
        ...(r.state === "interrupted"
          ? { message: "运行已中断，已保存结果保留；不会自动重新派发模型。" }
          : {}),
      }
    : { state: "idle", budgetCny: 5, spentCny: null };
  if (data.clarification) {
    run.chosen = data.clarification.chosen ?? undefined;
    run.clarifySpentCny = data.clarification.spentCny;
    run.clarifyCapCny = data.clarification.capCny;
    history.unshift(...data.clarification.history);
    if (data.clarification.unknownCost)
      run.message = "澄清另有待核用量，费用不按零记账。";
  }
  const paper: PaperView | null = p
    ? {
        id: p.id,
        title: p.title ?? "论文 " + p.paperId + "（标题未记录）",
        authors: p.authors?.length ? p.authors.join("、") : "作者信息未记录",
        venue: p.venue ?? "来源信息未记录",
        access: p.access,
        license: p.license ?? undefined,
        sections: [...sections.values()].sort(
          (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))
        ),
      }
    : null;
  return {
    dossier: data.dossier,
    paper,
    layers,
    quizzes,
    findings,
    anims: [],
    hasRepro: false,
    run,
    history,
  };
}
