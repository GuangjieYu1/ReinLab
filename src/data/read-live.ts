import type {
  FindingCard,
  LayerCard,
  PaperView,
  SourceSection,
  PaperCandidate,
  ReadAdapter,
  ReadEvent,
  ReadSnapshot,
  RunView,
} from "../components/workbenches/research/read/readTypes";
import { api, decide, sessionGeneration } from "./research-live";

type Ports = {
  api: typeof api;
  decide: typeof decide;
  generation: () => number;
};
/** The bench-mounting adapter: no dossier yet, created on first `clarify`. */
/** 候选没写来源时，按编号说清是哪一家，不一律写 OpenAlex。 */
const defaultVenue = (candidate: any) =>
  String(candidate.paperId ?? "").startsWith("arxiv:")
    ? "arXiv"
    : String(candidate.paperId ?? "").startsWith("W")
      ? "OpenAlex"
      : "检索结果";

export const liveReadAdapter = () => createLiveReadAdapter();
type LiveReadAdapter = ReadAdapter & {
  dispatchUnavailable(to: "swarm" | "auto", text: string): void;
};

const CANDIDATE_LABEL: Record<string, string> = {
  "papers.search": "检索论文",
  "papers.fetch": "下载论文全文",
  "papers.pages": "按页读取原文",
  "card.layer": "写入分层讲解",
  "card.finding": "记录发现",
};

const readRunState = (state: string): RunView["state"] =>
  state === "completed"
    ? "done"
    : state === "running" || state === "queued"
      ? "running"
      : state === "cancelled"
        ? "cancelled"
        : state === "failed"
          ? "failed"
          : "idle";

const readable = (error: unknown) => {
  const message = String((error as Error)?.message ?? "").trim();
  if (!message || /^HTTP_\d+$/.test(message)) return "读取真实精读数据失败，请重试。";
  return message;
};

const empty = (message?: string): ReadSnapshot => ({
  dossier: { id: "", title: "新的精读" },
  paper: null,
  layers: [],
  quizzes: [],
  findings: [],
  anims: [],
  hasRepro: false,
  history: [],
  run: {
    state: message ? "failed" : "idle",
    budgetCny: 5,
    spentCny: null,
    ...(message ? { message } : {}),
  },
});

type KernelEvent = { seq: number; action: string; payload: Record<string, any> };

/**
 * Live reading adapter over the DSH kernel endpoints (`/v1/kernel/*`).
 * The interface is the unchanged `ReadAdapter`; everything below maps the
 * kernel's own events onto `ReadEvent`.
 */
export function createLiveReadAdapter(
  initialDossier?: string,
  ports: Ports = { api, decide, generation: sessionGeneration },
): LiveReadAdapter {
  const generation = ports.generation(),
    subs = new Set<(e: ReadEvent) => void>();
  let dossier = initialDossier,
    runId: string | undefined,
    cursor = 0,
    snapshot = empty(),
    chosen: PaperCandidate | undefined,
    lastPicked: PaperCandidate | undefined,
    pendingQuestion: { approvalId: string; text: string } | undefined,
    freshReading = false,
    questionCardId: string | undefined,
    localPhase: RunView["state"] | undefined,
    rejected = false,
    fetchCardShown = false,
    permissionCardShown = false,
    shownPermissionId: string | undefined = undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    endReason: RunView["endReason"],
    failureMessage: string | undefined;
  const tools = new Map<string, { index: number; event: ReadEvent }>();
  /** 卡片先攒着，等写入回执成功了再显示。 */
  const pendingCards = new Map<string, { kind: "layer"; card: LayerCard } | { kind: "finding"; card: FindingCard }>();
  const emitted = new Set<number>();
  const announced = new Set<string>();

  const sections = new Map<number, SourceSection>();
  let paperView: PaperView | undefined;
  const emitPaper = () => {
    if (!paperView) return;
    const merged: PaperView = {
      ...paperView,
      sections: [...sections.values()].sort(
        (a, b) => Number(a.no.replace(/\D/g, "")) - Number(b.no.replace(/\D/g, "")),
      ),
    };
    snapshot.paper = merged;
    emit({ type: "paper", paper: merged });
  };
  /** 论文视图：下载成功后带着标题/作者，读到页后带上按页的原文段落。 */
  const updatePaper = (result: Record<string, any>) => {
    const assetId = String(result.assetId ?? "");
    if (!assetId) return;
    if (!paperView || paperView.id !== assetId) {
      paperView = {
        id: assetId,
        title: String(result.title ?? "选定的论文"),
        authors: Array.isArray(result.authors)
          ? result.authors.join("，").slice(0, 200)
          : String(result.authors ?? ""),
        venue: String(result.venue ?? "来源未知"),
        access: result.status === "full_text" ? "full" : "abstract_only",
        ...(typeof result.license === "string" ? { license: result.license } : {}),
        sections: [],
      };
      sections.clear();
      emitPaper();
    }
    if (Array.isArray(result.pages)) {
      for (const page of result.pages) {
        const no = Number(page?.page);
        if (!Number.isSafeInteger(no) || no < 1) continue;
        sections.set(no, {
          id: String(page.anchor ?? "p" + no),
          no: "p." + no,
          title: "第 " + no + " 页",
          gist: [String(page.text ?? "").slice(0, 400)],
        });
      }
      emitPaper();
    }
  };

  const emit = (event: ReadEvent) => {
    // 同一个动作同时来两条「待批准」（工具调用一条、轮询一条）时只留一条：
    // 界面上就是一张卡，不会出现两个「批准」按钮。
    if (
      event.type === "approval" &&
      event.state === "pending" &&
      snapshot.history.some(
        (entry) =>
          entry.type === "approval" &&
          entry.action === event.action &&
          entry.state === "pending",
      )
    )
      return;
    snapshot.history.push(event);
    for (const listener of subs) listener(event);
  };
  const patchRun = (patch: Partial<RunView>) => {
    // Only emit when something actually changed: a per-poll re-render detaches
    // the buttons mid-click and makes the page feel broken.
    const changed = Object.entries(patch).some(
      ([key, value]) => (snapshot.run as Record<string, unknown>)[key] !== value,
    );
    if (!changed) return;
    snapshot.run = { ...snapshot.run, ...patch };
    emit({ type: "run", run: patch });
  };

  const tool = (callId: string, name: string, running: boolean) => {
    const key = name.replace("papers_", "papers.").replace("cards_", "");
    const existing = tools.get(callId);
    const event: ReadEvent = {
      type: "tool",
      id: callId,
      action: key,
      label: CANDIDATE_LABEL[key] ?? CANDIDATE_LABEL[key.replace("card.", "card.")] ?? name,
      state: running ? "running" : "done",
    };
    if (existing) {
      Object.assign(existing.event, { state: event.state });
      emit({ ...existing.event });
      return;
    }
    tools.set(callId, { index: snapshot.history.length, event });
    emit(event);
  };

  const textOf = (message: any): string => {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("");
  };

  const apply = (event: KernelEvent) => {
    if (emitted.has(event.seq)) return;
    emitted.add(event.seq);
    cursor = Math.max(cursor, event.seq);
    const data = event.payload ?? {};
    switch (event.action) {
      case "user/message": {
        const text = textOf(data);
        if (text) emit({ type: "user", id: String(data.id ?? "user:" + event.seq), text });
        return;
      }
      case "assistant/message": {
        const text = textOf(data.message);
        const usage = data.usage;
        if (usage) {
          const known = Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
          if (known > 0) patchRun({ spentCny: null, unknownCost: snapshot.run.unknownCost });
        }
        if (text) emit({ type: "agent", id: String(data.message?.id ?? "agent:" + event.seq), text });
        return;
      }
      case "tool/call": {
        const name = String(data.name ?? "");
        if (name === "clarify_question") {
          const args = JSON.parse(String(data.arguments ?? "{}") || "{}");
          // Candidates in hand means the user is choosing a paper, whatever the
          // model labelled the question.
          if (args.kind === "paper_pick" || (Array.isArray(args.candidates) && args.candidates.length > 0)) {
            emit({
              type: "pick",
              id: String(data.callId ?? event.seq),
              query: String(args.question ?? ""),
              candidates: Array.isArray(args.candidates)
                ? args.candidates.map((candidate: any) => ({
                    id: String(candidate.paperId ?? candidate.id ?? ""),
                    title: String(candidate.title ?? ""),
                    authors: String(candidate.authors ?? "检索结果"),
                    venue: String(candidate.venue ?? defaultVenue(candidate)),
                    access: "full",
                  }))
                : [],
              state: "pending",
            });
          }
        }
        tool(String(data.callId ?? event.seq), name, true);
        if (name === "papers_fetch" && !permissionCardShown && !fetchCardShown) {
          const callId = String(data.callId ?? event.seq);
          fetchCardShown = true;
          permissionCardShown = true;
          shownPermissionId = callId;
          emit({
            type: "approval",
            id: callId,
            action: "papers.fetch",
            title: "下载论文全文",
            effects: [
              "只读你选定的这一篇：下载全文并写入当前档案",
              "只写 papers/ 下的这一个文件，可以撤销",
              "不批准就停下，不会读、也不会编造内容",
            ],
            risk: "write",
            state: "pending",
          });
        }
        if (name === "card_layer" || name === "card_finding") {
          tool(String(data.callId ?? event.seq), name, true);
          const raw = JSON.parse(String(data.arguments ?? "{}") || "{}");
          const args = raw.card ?? raw;
          if (name === "card_finding") {
            const evidence = Array.isArray(args.evidence) ? args.evidence : [];
            const finding: FindingCard = {
              id: "finding:" + String(data.callId ?? event.seq),
              n: snapshot.findings.length + 1,
              text: String(args.text ?? ""),
              refs: evidence
                .map((item: any) => (item?.page ? "p." + String(item.page) : ""))
                .filter(Boolean),
              confidence: ["low", "mid", "high"].includes(args.confidence)
                ? args.confidence
                : "mid",
              status: ["hypothesis", "supported", "refuted"].includes(args.status)
                ? args.status
                : "hypothesis",
              at: new Date().toISOString(),
            };
            // 写成功才显示：失败的卡片不该出现在讲解/发现里。
            if (finding.text)
              pendingCards.set(String(data.callId ?? event.seq), { kind: "finding", card: finding });
          } else {
            const body = Array.isArray(args.body) ? args.body : [];
            const layer: LayerCard = {
              id: "layer:" + String(data.callId ?? event.seq),
              no: String(args.no ?? "1"),
              title: String(args.title ?? "讲解"),
              en: String(args.en ?? ""),
              body: body
                .map((entry: any) => ({
                  text: String(entry?.text ?? ""),
                  refs: (Array.isArray(entry?.refs) ? entry.refs : [])
                    .map((ref: any) => (ref?.page ? "p." + String(ref.page) : ""))
                    .filter(Boolean),
                }))
                .filter((entry: { text: string }) => entry.text),
            };
            if (layer.body.length)
              pendingCards.set(String(data.callId ?? event.seq), { kind: "layer", card: layer });
          }
        }
        return;
      }
      case "approval.decided": {
        // 审批落定后，卡片要立刻从待办里消失：否则界面会一直显示同一张卡，
        // 人会重复点、脚本会一直点。
        const decision = String(data.decision ?? ""),
          // 卡片用的是弹出时那个 id，落定也要用它，界面才替换掉而不是再叠一张。
          decidedId = shownPermissionId ?? String(data.approvalId ?? "approval:" + event.seq);
        if (decision === "approve" || decision === "reject") {
          permissionCardShown = false;
          fetchCardShown = false;
          shownPermissionId = undefined;
          emit({
            type: "approval",
            id: decidedId,
            action: "papers.fetch",
            title: "下载论文全文",
            effects: [],
            risk: "write",
            state: decision === "approve" ? "approved" : "rejected",
          });
          if (decision === "reject") {
            rejected = true;
            patchRun({ endReason: "rejected", message: "已停止 · 没有下载" });
          }
        }
        return;
      }
      case "tool/result": {
        const callId = String(data.callId ?? data.message?.source?.callId ?? "");
        const resultText = Array.isArray(data.message?.content)
          ? data.message.content.map((block: any) => block?.text ?? "").join("")
          : "";
        const parsedResult = (() => {
          try {
            return JSON.parse(resultText) as Record<string, any>;
          } catch {
            return undefined;
          }
        })();
        if (parsedResult && parsedResult.assetId) updatePaper(parsedResult);
        if (callId) {
          const existing = tools.get(callId);
          if (existing) {
            Object.assign(existing.event, {
              state: parsedResult?.error ? "failed" : "done",
              ...(parsedResult?.error
                ? { detail: `${parsedResult.error.code}：${parsedResult.error.message}` }
                : {}),
            });
            emit({ ...existing.event });
          }
          const written = pendingCards.get(callId);
          if (written && !parsedResult?.error) {
            pendingCards.delete(callId);
            if (written.kind === "layer") {
              if (!snapshot.layers.some((entry) => entry.no === written.card.no)) {
                snapshot.layers.push(written.card);
                emit({ type: "layer", layer: written.card });
              }
            } else {
              snapshot.findings.push(written.card);
              emit({ type: "finding", finding: written.card });
            }
          }
        }
        return;
      }
      case "turn/end": {
        const kind = String(data.reason?.kind ?? "");
        endReason = kind === "completed" ? "completed" : "failed";
        if (kind !== "completed") failureMessage = String(data.reason?.error?.message ?? "执行失败，可以重来。");
        return;
      }
      default:
        return;
    }
  };

  async function fetchEvents(after: number): Promise<KernelEvent[]> {
    if (!runId) return [];
    const response = (await ports.api(
      `/v1/kernel/runs/${runId}/events?after=${after}`,
    )) as { events?: KernelEvent[] };
    return response?.events ?? [];
  }

  async function refreshApprovals(): Promise<void> {
    if (!runId) return;
    const listed = (await ports.api("/v1/approvals?state=pending")) as {
      items?: Array<{
        id: string;
        runId: string;
        kind: string;
        title: string;
        effects?: unknown;
        risk?: string;
      }>;
    };
    for (const card of listed?.items ?? []) {
      // 认运行，也认当前档案：重新开始后运行会换，卡片仍属于这段精读。
      const sameDossier =
        (card as { source?: { dossierId?: string } }).source?.dossierId === dossier;
      if ((card.runId !== runId && !sameDossier) || announced.has(card.id)) continue;
      // A question is the user's answer, not a permission: render it as a pick
      // (candidates) or as a plain question, keyed by the real card id so the
      // answer route addresses the same row.
      if (card.kind === "question") {
        announced.add(card.id);
        questionCardId = card.id;
        const candidates = Array.isArray((card as any).effects?.candidates)
          ? (card as any).effects.candidates
          : [];
        if (candidates.length > 0) {
          emit({
            type: "pick",
            id: card.id,
            query: String(card.title ?? ""),
            candidates: candidates.map((candidate: any) => ({
              id: String(candidate.paperId ?? candidate.id ?? ""),
              title: String(candidate.title ?? ""),
              authors: String(candidate.authors ?? "检索结果"),
              venue: String(candidate.venue ?? defaultVenue(candidate)),
              access: "full",
            })),
            state: "pending",
          });
        } else {
          pendingQuestion = { approvalId: card.id, text: String(card.title ?? "请补充线索。") };
          emit({ type: "agent", id: "question:" + card.id, text: String(card.title ?? "请补充线索。") });
        }
        continue;
      }
      if (permissionCardShown) continue;
      announced.add(card.id);
      permissionCardShown = true;
      shownPermissionId = card.id;
      // A pending permission means the run is waiting on the user: show the
      // run panel with the card instead of the local estimate step.
      localPhase = undefined;
      patchRun({ state: "running" });
      const capability = (card as any).effects?.capability;
      const effects =
        capability === "papers.fetch" || !capability
          ? [
              "只读你选定的这一篇：下载全文并写入当前档案",
              "只写 papers/ 下的这一个文件，可以撤销",
              "不批准就停下，不会读、也不会编造内容",
            ]
          : [`操作：${String(capability)}`, "只处理这一次请求；参数变化后需要重新批准"];
      emit({
        type: "approval",
        id: card.id,
        action: "papers.fetch",
        title: String(card.title ?? "等你批准"),
        effects,
        risk: card.risk === "danger" ? "danger" : card.risk === "read" ? "read" : "write",
        state: "pending",
      });
    }
  }

  /** 讲不满 5 层时照实写层数：刷新、轮询两个入口说的是同一句话。 */
  function shortfall(): Partial<RunView> {
    if (endReason !== "completed" || snapshot.layers.length >= 5) return {};
    return {
      endReason: "completed",
      message: snapshot.layers.length
        ? `讲解只生成了 ${snapshot.layers.length} 层`
        : "这一轮没有写出分层讲解",
    };
  }

  async function refresh(): Promise<void> {
    if (!runId) return;
    await refreshApprovals();
    const status = (await ports.api(`/v1/kernel/runs/${runId}`)) as {
      state?: string;
      usage?: { known?: boolean; knownCny?: string | null };
      session?: { errorCode?: string | null } | null;
    };
    let state = readRunState(String(status.state ?? ""));
    // A running kernel must not clobber the local choosing/estimating step: the
    // user is picking a paper while the conversation turn is still open.
    // The local choosing/estimating step owns the panel until the user confirms
    // the start (start() clears it); a finished clarify turn must not yank the
    // candidate/chosen card away.
    if (localPhase) state = localPhase;
    const known = status.usage?.known === true;
    const spent = known && status.usage?.knownCny ? Number(status.usage.knownCny) : null;
    patchRun({
      state,
      spentCny: spent,
      clarifySpentCny: spent ?? undefined,
      unknownCost: !known,
      ...(state === "done"
        ? rejected
          ? { endReason: "rejected" as const, message: "已停止 · 没有下载" }
          : {
              endReason: endReason ?? "completed",
              // 后端已经提醒补写过一次；到这里还是不满 5 层就照实写层数，不说「已完成」。
              ...shortfall(),
            }
        : {}),
      ...(state === "failed" ? { message: failureMessage ?? status.session?.errorCode ?? "执行失败，可以重来。" } : {}),
    });
    if (state === "done" || state === "failed" || state === "cancelled") {
      if (timer) clearInterval(timer);
      timer = undefined;
    }
  }

  function startPolling() {
    if (timer) return;
    timer = setInterval(() => {
      void (async () => {
        try {
          for (const event of await fetchEvents(cursor)) apply(event);
          await refresh();
        } catch {
          /* a transient poll failure keeps the last known state */
        }
      })();
    }, 1500);
  }

  async function latestRun(): Promise<string | undefined> {
    if (!dossier) return undefined;
    const listed = (await ports.api(`/v1/kernel/dossiers/${dossier}/runs`)) as {
      runs?: Array<{ id: string; state: string }>;
    };
    return listed?.runs?.[0]?.id;
  }

  async function ensureDossier(): Promise<string> {
    if (dossier) return dossier;
    const created = (await ports.api("/v1/dossiers", { title: "新的精读" }, crypto.randomUUID())) as {
      id: string;
    };
    dossier = created.id;
    snapshot.dossier = { id: dossier, title: "新的精读" };
    return dossier;
  }

  // 一次用户意图一个键：同一次开始重试（会话被占、响应丢失）不会再开第二个运行。
  let startKey: string | undefined,
    startSignature: string | undefined;
  async function startRun(query: string, chosenPaperId?: string): Promise<void> {
    const id = await ensureDossier(),
      signature = JSON.stringify([id, query, chosenPaperId ?? null, freshReading]);
    if (signature !== startSignature) {
      startSignature = signature;
      startKey = crypto.randomUUID();
    }
    // The clarify turn may still be closing when the user confirms; the session
    // lease frees only after it ends, so retry briefly instead of failing.
    let created: { id: string } | undefined;
    for (let attempt = 0; attempt < 40 && !created; attempt += 1) {
      try {
        created = (await ports.api(
          "/v1/kernel/runs",
          {
            dossierId: id,
            query,
            ...(chosenPaperId ? { chosenPaperId } : {}),
            ...(freshReading ? { newSession: true } : {}),
          },
          startKey ?? crypto.randomUUID(),
        )) as { id: string };
      } catch (error) {
        const message = String((error as { message?: string })?.message ?? "");
        if (!/占用|SESSION_BUSY/.test(message) || attempt === 39) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    if (!created) throw Error("开始精读失败，请重试。");
    const createdRun = created;
    startKey = undefined;
    startSignature = undefined;
    runId = createdRun.id;
    rejected = false;
    fetchCardShown = false;
    freshReading = false;
    localPhase = undefined;
    cursor = 0;
    emitted.clear();
    tools.clear();
    pendingCards.clear();
    permissionCardShown = false;
    endReason = undefined;
    failureMessage = undefined;
    patchRun({ state: "running", spentCny: null });
    startPolling();
  }

  return {
    kind: "live",
    dispatchUnavailable(_to, text) {
      emit({ type: "agent", id: "unavailable:" + crypto.randomUUID(), text });
    },
    async load() {
      if (ports.generation() !== generation) throw Error("会话已变化，请刷新页面。");
      if (!dossier) {
        // The bench does not pass a dossier: adopt the account's reading archive,
        // and create one on the first sentence when there is none.
        const listed = (await ports.api("/v1/dossiers?view=read")) as {
          items?: Array<{ id: string; title?: string }>;
        };
        const first = listed?.items?.[0];
        if (!first) {
          snapshot = empty();
          return snapshot;
        }
        dossier = first.id;
        snapshot.dossier = { id: first.id, title: first.title ?? "精读档案" };
      }
      try {
        if (freshReading) return snapshot;
        const latest = await latestRun();
        if (!latest) {
          snapshot = { ...empty(), dossier: { id: dossier, title: "新的精读" } };
          return snapshot;
        }
        runId = latest;
        cursor = 0;
        emitted.clear();
        tools.clear();
        snapshot = { ...empty(), dossier: { id: dossier, title: snapshot.dossier.title } };
        for (const event of await fetchEvents(0)) {
          // apply 自己会往 history 里放（审批、卡片、消息），只有它没放时才补一条通用记录，
          // 否则刷新后同一张审批会显示两遍。
          const before = snapshot.history.length;
          apply(event);
          if (snapshot.history.length === before) snapshot.history.push(toHistory(event));
        }
        const status = (await ports.api(`/v1/kernel/runs/${runId}`)) as {
          state?: string;
          usage?: { known?: boolean };
        };
        const loaded = readRunState(String(status.state ?? ""));
        patchRun({
          state: loaded,
          spentCny: null,
          unknownCost: status.usage?.known !== true,
          ...(loaded === "done" ? shortfall() : {}),
        });
        startPolling();
        return snapshot;
      } catch (error) {
        throw Error(readable(error));
      }
    },
    subscribe(on) {
      subs.add(on);
      // 订阅即轮询：重新开始等场景下运行 id 会换，不能因为当时没有 runId 就不轮询。
      startPolling();
      return () => {
        subs.delete(on);
        if (subs.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    async clarify(text) {
      // 每段新对话都在全新档案里开始：旧档案里已下载的论文会让「下载审批」直接消失，
      // 也违反「一次只批一次下载」的观看路径。
      const running = snapshot.run.state === "running" || snapshot.run.state === "estimating" || snapshot.run.state === "confirm";
      if (!runId || !running) {
        dossier = undefined;
        await startRun(text);
        return;
      }
      const pending = existsPendingQuestion();
      if (pending) {
        await ports.api(`/v1/kernel/approvals/${pending.approvalId}/answer`, { text });
        pendingQuestion = undefined;
        return;
      }
      await startRun(text);
    },
    async newReading() {
      runId = undefined;
      cursor = 0;
      emitted.clear();
      announced.clear();
      tools.clear();
      chosen = undefined;
      lastPicked = undefined;
      pendingQuestion = undefined;
      endReason = undefined;
      failureMessage = undefined;
      // 新建精读就是一个全新档案：不复用旧档案里已下载的论文，
      // 这样下载审批与「没批准就不下载」都能如实出现。
      dossier = undefined;
      snapshot = empty();
      freshReading = true;
      localPhase = undefined;
      patchRun({ state: "idle", message: undefined });
    },
    async cancelClarify() {
      if (runId) await ports.api(`/v1/kernel/runs/${runId}/cancel`, {}, crypto.randomUUID());
      runId = undefined;
      patchRun({ state: "idle" });
    },
    async unchoose() {
      chosen = undefined;
      localPhase = "idle";
      patchRun({ chosen: undefined, state: "idle", estimate: undefined, query: undefined });
    },
    async estimate(_candidateId, budgetCny) {
      localPhase = "estimating";
      patchRun({ state: "estimating" });
      const estimate = {
        id: "kernel-estimate",
        model: "deepseek-v4-flash",
        maxCny: Math.min(budgetCny, 2.5),
        steps: 48,
        note: "按页数粗估，不预留预算。",
      };
      localPhase = "confirm";
      patchRun({ state: "confirm", estimate });
      return estimate;
    },
    async start(_estimateId, _budgetCny) {
      // 一按「确认开始」就把面板切到排队/运行，别继续显示上一轮的「已完成」。
      rejected = false;
      fetchCardShown = false;
      patchRun({
        state: "queued",
        endReason: undefined,
        message: undefined,
        spentCny: 0,
        unknownCost: false,
        accounting: undefined,
      });
      // 选定之后澄清轮的任务就结束了：先让它收尾，避免它继续占着会话，
      // 正式精读才不会被 SESSION_BUSY 挡在门外。
      if (runId) {
        await ports
          .api(`/v1/kernel/runs/${runId}/cancel`, {}, crypto.randomUUID())
          .catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      const picked = chosen ?? lastPicked;
      // The chosen paper travels with the instruction so this turn is
      // deterministic: fetch this exact paper, no searching, no re-asking.
      await startRun(
        picked
          ? `就按我选的这篇开始精读（paperId=${picked.id}）。`
          : "就按我选的这篇开始精读",
        picked?.id,
      );
    },
    async cancel() {
      if (!runId) return;
      const receipt = (await ports.api(
        `/v1/kernel/runs/${runId}/cancel`,
        {},
        crypto.randomUUID(),
      )) as { state?: string };
      if (receipt?.state === "cancel_unconfirmed") {
        patchRun({ state: "running", message: "停止未确认，内核可能仍在运行。" });
        return;
      }
      patchRun({ state: "cancelled", endReason: "cancelled" });
    },
    async decide(approvalId, approve) {
      let target = approvalId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(target)) {
        // 卡片来自工具调用事件：落到这一轮真实的审批行上
        const pending = (await ports.api("/v1/approvals?state=pending")) as {
          items?: Array<{ id: string; runId: string; title: string }>;
        };
        // 只认这一轮的待办：别的运行（含上一段精读）的审批不能借卡片 id 被点掉。
        const items = pending?.items ?? [];
        const hit =
          items.find((item) => item.runId === runId) ??
          // 同一档案里上一轮留下的卡也能点：面板显示的就是它。
          items.find(
            (item) => (item as { source?: { dossierId?: string } }).source?.dossierId === dossier,
          );
        if (!hit) {
          // 已经不在待办里：按当前结果收尾，不重复提交
          if (!approve) {
            rejected = true;
            patchRun({ endReason: "rejected", message: "已停止 · 没有下载" });
          }
          return;
        }
        target = hit.id;
      }
      const approvalIdSafe = target;
      await ports.decide("approval", approvalIdSafe, {
        decision: approve ? "approve" : "reject",
        scope: "once",
      });
      if (!approve) {
        rejected = true;
        patchRun({ endReason: "rejected", message: "已停止 · 没有下载" });
      }
    },
    async pick(pickId, candidateId) {
      const answer = await ports.api(
        `/v1/kernel/approvals/${questionCardId ?? pickId}/answer`,
        candidateId === null ? { text: "都不是，请再找找" } : { candidateId },
        crypto.randomUUID(),
      );
      void answer;
      if (candidateId === null) {
        pendingQuestion = undefined;
        return;
      }
      const pick = snapshot.history.find(
        (event): event is Extract<ReadEvent, { type: "pick" }> =>
          event.type === "pick" && event.id === pickId,
      );
      const candidate = pick?.candidates.find((item) => item.id === candidateId);
      chosen = candidate;
      lastPicked = candidate;
      const answered = snapshot.history.find(
        (event): event is Extract<ReadEvent, { type: "pick" }> =>
          event.type === "pick" && (event.id === pickId || event.id === questionCardId),
      );
      if (answered) {
        const updated = { ...answered, state: "answered" as const, chosen: candidateId };
        snapshot.history = snapshot.history.map((event) =>
          event.type === "pick" && event.id === answered.id ? updated : event,
        );
        emit(updated);
      }
      localPhase = "idle";
      patchRun({ chosen: candidate, query: candidate?.title, state: "idle", estimate: undefined });
      emit({
        type: "agent",
        id: "picked:" + crypto.randomUUID(),
        text: `好，读《${candidate?.title ?? ""}》。可以按这篇的长度预估费用了。`,
      });
    },
    async ask() {
      throw Error("追问未接入。");
    },
    async grade() {
      throw Error("评分未接入。");
    },
  };

  function existsPendingQuestion() {
    return pendingQuestion;
  }
}

/** One stored kernel event in the history shape a re-opened page can render. */
function toHistory(event: KernelEvent): ReadEvent {
  const data = event.payload ?? {};
  switch (event.action) {
    case "user/message":
      return { type: "user", id: String(data.id ?? "u:" + event.seq), text: String(data.text ?? data.content ?? "") };
    case "assistant/message":
      return {
        type: "agent",
        id: String(data.message?.id ?? "a:" + event.seq),
        text: Array.isArray(data.message?.content)
          ? data.message.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("")
          : "",
      };
    default:
      return {
        type: "tool",
        id: "e:" + event.seq,
        action: event.action,
        label: CANDIDATE_LABEL[event.action] ?? event.action,
        state: "done",
      };
  }
}
