import type {
  FindingCard,
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
    timer: ReturnType<typeof setInterval> | undefined,
    endReason: RunView["endReason"],
    failureMessage: string | undefined;
  const tools = new Map<string, { index: number; event: ReadEvent }>();
  const emitted = new Set<number>();
  const announced = new Set<string>();

  const emit = (event: ReadEvent) => {
    snapshot.history.push(event);
    for (const listener of subs) listener(event);
  };
  const patchRun = (patch: Partial<RunView>) => {
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
        tool(String(data.callId ?? event.seq), name, true);
        if (name === "card_layer" || name === "card_finding") tool(String(data.callId ?? event.seq), name, true);
        return;
      }
      case "tool/result": {
        const callId = String(data.callId ?? data.message?.source?.callId ?? "");
        if (callId) {
          const existing = tools.get(callId);
          if (existing) {
            Object.assign(existing.event, { state: "done" });
            emit({ ...existing.event });
          }
        }
        const result = data.message?.content;
        const asText = Array.isArray(result) ? result.map((b: any) => b?.text ?? "").join("") : "";
        if (asText.includes("card_finding") || asText.includes("finding")) {
          const card: FindingCard = {
            id: "finding:" + event.seq,
            n: snapshot.findings.length + 1,
            text: asText.slice(0, 2000),
            refs: [],
            confidence: "mid",
            status: "hypothesis",
            at: new Date().toISOString(),
          };
          snapshot.findings.push(card);
          emit({ type: "finding", finding: card });
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
      if (card.runId !== runId || announced.has(card.id)) continue;
      // A question is the user's answer, not a permission: render it as a pick
      // (candidates) or as a plain question, keyed by the real card id so the
      // answer route addresses the same row.
      if (card.kind === "question") {
        announced.add(card.id);
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
              venue: String(candidate.venue ?? "OpenAlex"),
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
      announced.add(card.id);
      const effects = Array.isArray(card.effects)
        ? card.effects
            .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
            .slice(0, 4)
        : [];
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

  async function refresh(): Promise<void> {
    if (!runId) return;
    await refreshApprovals();
    const status = (await ports.api(`/v1/kernel/runs/${runId}`)) as {
      state?: string;
      usage?: { known?: boolean; knownCny?: string | null };
      session?: { errorCode?: string | null } | null;
    };
    const state = readRunState(String(status.state ?? ""));
    const known = status.usage?.known === true;
    const spent = known && status.usage?.knownCny ? Number(status.usage.knownCny) : null;
    patchRun({
      state,
      spentCny: spent,
      clarifySpentCny: spent ?? undefined,
      unknownCost: !known,
      ...(state === "done" ? { endReason: endReason ?? "completed" } : {}),
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

  async function startRun(query: string, chosenPaperId?: string): Promise<void> {
    const id = await ensureDossier();
    const created = (await ports.api(
      "/v1/kernel/runs",
      { dossierId: id, query, ...(chosenPaperId ? { chosenPaperId } : {}) },
      crypto.randomUUID(),
    )) as { id: string };
    runId = created.id;
    cursor = 0;
    emitted.clear();
    tools.clear();
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
          snapshot.history.push(toHistory(event));
          apply(event);
        }
        const status = (await ports.api(`/v1/kernel/runs/${runId}`)) as {
          state?: string;
          usage?: { known?: boolean };
        };
        patchRun({
          state: readRunState(String(status.state ?? "")),
          spentCny: null,
          unknownCost: status.usage?.known !== true,
        });
        startPolling();
        return snapshot;
      } catch (error) {
        throw Error(readable(error));
      }
    },
    subscribe(on) {
      subs.add(on);
      if (runId) startPolling();
      return () => {
        subs.delete(on);
        if (subs.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    async clarify(text) {
      if (!runId) {
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
    async cancelClarify() {
      if (runId) await ports.api(`/v1/kernel/runs/${runId}/cancel`, {}, crypto.randomUUID());
      runId = undefined;
      patchRun({ state: "idle" });
    },
    async unchoose() {
      chosen = undefined;
      patchRun({ chosen: undefined });
    },
    async estimate(_candidateId, budgetCny) {
      return {
        id: "kernel-estimate",
        model: "deepseek-v4-flash",
        maxCny: budgetCny,
        steps: 1,
        note: "按页数粗估，不预留预算。",
      };
    },
    async start(_estimateId, _budgetCny) {
      await startRun("就按我选的这篇开始精读", (chosen ?? lastPicked)?.id);
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
      await ports.decide("approval", approvalId, {
        decision: approve ? "approve" : "reject",
        scope: "once",
      });
      if (!approve) patchRun({ endReason: "rejected" });
    },
    async pick(pickId, candidateId) {
      const answer = await ports.api(
        `/v1/kernel/approvals/${pickId}/answer`,
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
      patchRun({ chosen: candidate, state: "confirm" });
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
