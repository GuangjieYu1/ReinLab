import type {
  ReadAdapter,
  ReadEvent,
  ReadSnapshot,
  Estimate,
} from "../components/workbenches/research/read/readTypes";
import {
  api,
  decide,
  sessionGeneration,
  readEventStream,
} from "./research-live";
import { projectReading, type ReadWire } from "./read-projection";
type Ports = {
  api: typeof api;
  decide: typeof decide;
  generation: () => number;
  stream: typeof readEventStream;
};
type LiveReadAdapter = ReadAdapter & {
  dispatchUnavailable(to: "swarm" | "auto", text: string): void;
};
const unavailable = () => Error("真实精读来源或会话已变化，请刷新。");
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
export function createLiveReadAdapter(
  initialDossier?: string,
  ports: Ports = {
    api,
    decide,
    generation: sessionGeneration,
    stream: readEventStream,
  }
): LiveReadAdapter {
  const generation = ports.generation(),
    subs = new Set<(e: ReadEvent) => void>();
  let dossier = initialDossier,
    runId: string | undefined,
    snapshot = empty(),
    wire: ReadWire | undefined,
    local: ReadEvent[] = [],
    cursor = 0,
    epoch = 0,
    controller: AbortController | undefined;
  let quote:
    | {
        view: Estimate;
        query: string;
        expires: number;
        role: string;
        steps: number;
        dossier: string;
        candidateId?: string;
      }
    | undefined;
  let intent:
    | {
        estimate: string;
        key: string;
        body: any;
        unknown: boolean;
        accepted?: string;
      }
    | undefined;
  let pendingMutation: { path: string; body: string; key: string } | undefined;
  let cancelIntent: { dossier: string; key: string } | undefined;
  async function clarifyMutation(path: string, body: unknown) {
    const encoded = JSON.stringify(body);
    if (
      pendingMutation &&
      (pendingMutation.path !== path || pendingMutation.body !== encoded)
    )
      throw unavailable();
    const request = (pendingMutation ??= {
      path,
      body: encoded,
      key: crypto.randomUUID(),
    });
    try { await ports.api(path, body, request.key); }
    catch (error) {
      if ([400,401,403,404,409,422].includes((error as {status?: number}).status ?? 0) && pendingMutation === request)
        pendingMutation = undefined;
      throw error;
    }
    current();
    if (pendingMutation === request) pendingMutation = undefined;
  }
  let refreshQueue = Promise.resolve();
  let quoteVersion = 0,
    sourceVersion = 0,
    createKey: string | undefined,
    creating: Promise<boolean> | undefined,
    loading: Promise<ReadSnapshot> | undefined,
    // 「换一篇」把上一次的选择清掉后，界面回到起始卡：旧 run 的标题不再挡着改选。
    dropped = false;
  const current = () => {
    if (generation !== ports.generation()) throw unavailable();
  };
  const forThisAccount = (value: ReadSnapshot) =>
    generation === ports.generation()
      ? value
      : empty("会话已变化，请重新登录后读取档案。");
  const emit = (e: ReadEvent) => {
    current();
    if (e.type === "run")
      snapshot = { ...snapshot, run: { ...snapshot.run, ...e.run } };
    for (const on of subs) on(e);
  };
  const stop = () => {
    epoch++;
    controller?.abort();
    controller = undefined;
  };
  async function choose() {
    current();
    if (dossier) return;
    const list = await ports.api("/v1/dossiers?view=read");
    current();
    dossier = list.items
      .filter((d: any) => d.bench === "research" && !d.archivedAt)
      .at(-1)?.id;
  }
  async function fetchSnapshot(): Promise<ReadSnapshot> {
    current();
    if (createKey) {
      snapshot = empty(
        "新档案创建结果未知，未切回旧档案运行；请再次新建以核对同一收据。"
      );
      return snapshot;
    }
    const version = epoch;
    await choose();
    if (version !== epoch) throw unavailable();
    if (!dossier) return empty();
    const expected = dossier,
      source = sourceVersion,
      expectedRun = runId;
    const data = (await ports.api(
      "/v1/dossiers/" +
        encodeURIComponent(dossier) +
        "/read-state" +
        (runId ? "?runId=" + encodeURIComponent(runId) : "")
    )) as ReadWire;
    current();
    if (
      version !== epoch ||
      expected !== dossier ||
      data.dossier.id !== dossier ||
      !Number.isSafeInteger(data.cursor) ||
      data.cursor < 0 ||
      data.cursor < cursor ||
      source !== sourceVersion ||
      (expectedRun && data.run?.id !== expectedRun)
    )
      throw unavailable();
    const events: any[] = [];
    let after = 0;
    while (after < data.cursor) {
      const page = await ports.api(
        "/v1/dossiers/" +
          encodeURIComponent(dossier) +
          "/read-events?after=" +
          after +
          "&through=" +
          data.cursor
      );
      current();
      if (
        version !== epoch ||
        expected !== dossier ||
        !Array.isArray(page.items) ||
        !Number.isSafeInteger(page.cursor) ||
        page.cursor <= after ||
        page.cursor > data.cursor
      )
        throw unavailable();
      for (const event of page.items) {
        if (event.dossierId && event.dossierId !== dossier) throw unavailable();
        if (
          !Number.isSafeInteger(event.seq) ||
          event.seq <= after ||
          event.seq > data.cursor
        )
          throw unavailable();
        events.push(event);
      }
      after = page.cursor;
      if (page.done) break;
    }
    if (after !== data.cursor) throw unavailable();
    if (source !== sourceVersion || data.cursor < cursor) throw unavailable();
    sourceVersion++;
    wire = data;
    runId = data.run?.id;
    cursor = data.cursor;
    snapshot = projectReading(data, events, snapshot.paper?.id);
    if (dropped && !snapshot.run.chosen && !snapshot.paper)
      snapshot = {
        ...snapshot,
        run: {
          state: "idle",
          budgetCny: snapshot.run.budgetCny ?? 5,
          spentCny: snapshot.run.spentCny ?? null,
          clarifySpentCny: snapshot.run.clarifySpentCny,
          clarifyCapCny: snapshot.run.clarifyCapCny,
          clarifyUnknownCost: snapshot.run.clarifyUnknownCost,
        },
      };
    else if (snapshot.run.chosen || snapshot.paper) dropped = false;
    // Committed clarification events may arrive after the estimate response.
    // Preserve a still-valid quote for the same selection; never let SSE reset its confirmation.
    if (
      !data.run &&
      quote &&
      quote.dossier === dossier &&
      quote.expires > Date.now() &&
      (!quote.candidateId || snapshot.run.chosen?.id === quote.candidateId)
    )
      snapshot.run = {
        ...snapshot.run,
        state: "confirm",
        estimate: quote.view,
        query: quote.query,
      };
    snapshot.history.push(...local);
    if (intent && data.run?.estimateId === intent.estimate) {
      intent.accepted = data.run.id;
      intent.unknown = false;
    }
    if (intent?.unknown)
      snapshot.run = {
        ...snapshot.run,
        state: "failed",
        unknownCost: true,
        message: "提交结果未知，未再次派发；请先只读刷新核对原运行。",
      };
    return snapshot;
  }
  async function refresh() {
    const previous = snapshot;
    const next = await fetchSnapshot();
    current();
    if (next.dossier.id !== previous.dossier.id) return;
    emit({ type: "run", run: next.run });
    if (next.paper) {
      emit({ type: "paper", paper: next.paper });
      for (const section of next.paper.sections)
        emit({ type: "section", section });
    }
    for (const layer of next.layers) emit({ type: "layer", layer });
    for (const quiz of next.quizzes) emit({ type: "quiz", quiz });
    for (const finding of next.findings) emit({ type: "finding", finding });
    for (const e of next.history) emit(e);
  }
  async function refreshSerially() {
    const work = refreshQueue.catch(() => {}).then(() => refresh());
    refreshQueue = work.then(() => {}, () => {});
    await work;
  }
  function listen() {
    if (controller || !subs.size || !dossier) return;
    const mine = epoch,
      abort = new AbortController();
    controller = abort;
    void (async () => {
      while (!abort.signal.aborted && subs.size && mine === epoch) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          current();
          const response = await ports.stream(
            "/v1/dossiers/" +
              encodeURIComponent(dossier!) +
              "/events?view=read&after=" +
              cursor,
            abort.signal,
            cursor
          );
          current();
          if (!response?.ok || !response.body) throw unavailable();
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const part = await reader.read();
            current();
            if (abort.signal.aborted || mine !== epoch) return;
            if (part.done) break;
            buffer += decoder.decode(part.value, { stream: true });
            if (buffer.length > 8 * 1024 * 1024) throw unavailable();
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const lines = frame.split(/\r?\n/);
              const raw = lines
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart())
                .join("\n");
              if (!raw) continue;
              const event = JSON.parse(raw);
              if (
                !Number.isSafeInteger(event.seq) ||
                event.dossierId !== dossier
              )
                throw unavailable();
              if (event.seq <= cursor) continue;
              refreshQueue = refreshQueue.then(() => {
                current();
                if (mine !== epoch) return;
                return refresh();
              });
              await refreshQueue;
            }
          }
        } catch {
          if (
            abort.signal.aborted ||
            mine !== epoch ||
            generation !== ports.generation()
          )
            return;
          refreshQueue = Promise.resolve();
        } finally {
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1000);
          function done() {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", done);
            resolve();
          }
          abort.signal.addEventListener("abort", done, { once: true });
          if (abort.signal.aborted) done();
        });
      }
    })().finally(() => {
      if (controller === abort) controller = undefined;
    });
  }
  async function cancelClarification() {
    current();
    if (!dossier) return;
    if (!cancelIntent || cancelIntent.dossier !== dossier) cancelIntent = { dossier, key: crypto.randomUUID() };
    const request = cancelIntent;
    await ports.api('/v1/dossiers/'+dossier+'/read/cancel-clarify',{},request.key);
    current();
    await refreshSerially();
    if (wire?.clarification?.activeRunId) throw unavailable();
    pendingMutation = undefined;
    if (cancelIntent === request) cancelIntent = undefined;
  }
  async function newDossier() {
    current();
    if (creating) return creating;
    if (
      intent?.unknown ||
      ["queued", "running", "waiting"].includes(snapshot.run.state)
    ) {
      emit({
        type: "agent",
        id: "reading-busy",
        text: "当前运行或提交结果尚未核对，请先确认停止结果；未另建运行。",
      });
      return false;
    }
    const work = (async () => {
      // 关旧澄清只是清理：失败（例如旧账已结清的结算冲突）也要继续建新档案，
      // 否则新档案发不出话（run7 C3b）。
      try {
        await cancelClarification();
      } catch {
        if (generation === ports.generation())
          emit({
            type: "agent",
            id: "cancel-before-new:" + crypto.randomUUID(),
            text: "上一段澄清没能关闭（结算待核对），新档案照常新建；旧账没有被改写。",
          });
      }
      stop();
      quoteVersion++;
      const expected = epoch;
      createKey ??= crypto.randomUUID();
      const created = await ports.api(
        "/v1/dossiers",
        { bench: "research", title: "新的精读" },
        createKey
      );
      current();
      if (expected !== epoch) throw unavailable();
      dossier = created.id;
      runId = undefined;
      wire = undefined;
      local = [];
      quote = undefined;
      intent = undefined;
      cursor = 0;
      snapshot = empty();
      snapshot.dossier = { id: created.id, title: created.title };
      createKey = undefined;
      return true;
    })();
    creating = work;
    try {
      return await work;
    } finally {
      if (creating === work) creating = undefined;
    }
  }
  return {
    kind: "live",
    dispatchUnavailable(to, _text) {
      current();
      const event: ReadEvent = {
        type: "agent",
        id: "unavailable-dispatch:" + crypto.randomUUID(),
        text:
          (to === "swarm" ? "群研" : "自研") +
          "未接入，当前只开放精读；没有创建或派发运行。",
      };
      local.push(event);
      emit(event);
    },
    async load() {
      stop();
      const version = epoch,
        before = sourceVersion;
      let work!: Promise<ReadSnapshot>;
      work = (async () => {
        try {
          const result = await fetchSnapshot();
          current();
          if (version !== epoch && loading && loading !== work)
            return forThisAccount(await loading);
          listen();
          return result;
        } catch {
          if (generation !== ports.generation())
            return forThisAccount(snapshot);
          if (version !== epoch && loading && loading !== work)
            return forThisAccount(await loading);
          if (version === epoch && sourceVersion !== before)
            return forThisAccount(snapshot);
          const failed = empty("档案读取失败或会话已变化，请重新登录后刷新。");
          if (version === epoch) {
            snapshot = failed;
            wire = undefined;
          }
          return failed;
        }
      })();
      loading = work;
      return work;
    },
    subscribe(on) {
      current();
      subs.add(on);
      listen();
      return () => {
        subs.delete(on);
        if (!subs.size) stop();
      };
    },
    async newReading() {
      try {
        await newDossier();
      } catch {
        if (generation === ports.generation())
          emit({
            type: "agent",
            id: "new-reading-failed",
            text: "新档案创建结果尚未确认；重试会沿用原幂等键，不会自动发起模型。",
          });
      }
    },
    async cancelClarify() { await cancelClarification(); },
    async clarify(text) {
      current();
      let accepted = false;
      try {
        if (creating && !(await creating)) return;
        current();
        if (!dossier && !(await newDossier())) return;
        listen();
        await refreshSerially();
        const pending = wire?.clarification?.pendingQuestion;
        // 回答已经存在的问题由 approvalId 定身份；再带上滞后的选中代次只会被挡掉。
        await clarifyMutation("/v1/dossiers/" + dossier + "/read/clarify", {
          text,
          ...(pending
            ? { approvalId: pending.approvalId }
            : wire?.clarification?.selectionRevision !== undefined
              ? { selectionRevision: wire.clarification.selectionRevision }
              : {}),
        });
        accepted = true;
        await refreshSerially();
      } catch {
        if (generation === ports.generation()) {
          const e: ReadEvent = {
            type: "agent",
            id: "clarify-status:" + crypto.randomUUID(),
            text: accepted ? '澄清已受理，结果待只读刷新；没有另建或重复派发运行。' : "澄清未受理或结果尚未核对，请只读刷新账本；没有自动重试或提高预算。",
          };
          local.push(e);
          emit(e);
        }
      }
    },
    async pick(pickId, candidateId) {
      current();
      try {
        if (!dossier) throw unavailable();
        // 已回答过的候选卡也能改选：后端从 read_candidate 里换，不调模型。
        await clarifyMutation("/v1/dossiers/" + dossier + "/read/pick", {
          pickId,
          candidateId,
        });
        quote = undefined;
        quoteVersion++;
        dropped = false;
        await refreshSerially();
      } catch {
        if (generation === ports.generation())
          emit({
            type: "agent",
            id: "pick-status:" + pickId,
            text: "选择结果尚未核对，请刷新；未代选、未重复提交。",
          });
      }
    },
    async unchoose() {
      current();
      try {
        if (!dossier) return;
        await clarifyMutation("/v1/dossiers/" + dossier + "/read/unchoose", {});
        quote = undefined;
        intent = undefined;
        quoteVersion++;
        dropped = true;
        await refreshSerially();
      } catch {
        if (generation === ports.generation())
          emit({
            type: "agent",
            id: "unchoose-status",
            text: "换篇结果尚未核对，请刷新；未自动重开澄清或精读。",
          });
      }
    },
    async estimate(query, budget) {
      current();
      if (
        !query.trim() ||
        query.length > 4000 ||
        !Number.isFinite(budget) ||
        budget <= 0 ||
        budget > 50 ||
        createKey ||
        intent?.unknown ||
        ["queued", "running", "waiting"].includes(snapshot.run.state)
      )
        throw unavailable();
      if (!dossier && !(await newDossier())) throw unavailable();
      // Initial load can have no dossier, so subscribe() could not open SSE yet.
      // An explicit estimate may create that first dossier without a UI reload.
      listen();
      const expected = dossier,
        version = ++quoteVersion;
      emit({
        type: "run",
        run: { state: "estimating", query, budgetCny: budget, spentCny: null },
      });
      try {
        const harness = await ports.api(
          "/v1/dossiers/" + dossier + "/harness?view=read"
        );
        current();
        // 用数值比较，别再写死版本列表：1.2.x 起预估必须带人工选定的 candidateId。
        const [major, minor] = String(harness.version)
            .split(".")
            .map(Number),
          chosenFlow = major > 1 || (major === 1 && minor >= 2);
        if (
          version !== quoteVersion ||
          dossier !== expected ||
          !(major > 1 || (major === 1 && minor >= 1))
        )
          throw Error("旧工作台档案请新建精读，不会静默升级。");
        const candidateId = chosenFlow ? query : undefined;
        if (candidateId && snapshot.run.chosen?.id !== candidateId)
          throw unavailable();
        const role = harness.entrypoints.read,
          steps = harness.roles[role].steps;
        const value = await ports.api(
          "/v1/runs/estimate",
          {
            dossierId: dossier,
            mode: "read",
            ...(candidateId ? { candidateId } : {}),
          },
          crypto.randomUUID()
        );
        current();
        if (
          version !== quoteVersion ||
          dossier !== expected ||
          !Number.isFinite(Number(value.estimatedCny)) ||
          Number(value.estimatedCny) < 0 ||
          !Number.isFinite(Date.parse(value.expiresAt)) ||
          Date.parse(value.expiresAt) <= Date.now() ||
          !Number.isSafeInteger(steps) ||
          steps < 1
        )
          throw unavailable();
        const view = {
          id: value.id,
          model: value.model,
          maxCny: Number(value.estimatedCny),
          steps,
          note: candidateId
            ? (snapshot.run.chosen?.pages
                ? "按公开书目估计的 " +
                  snapshot.run.chosen.pages +
                  " 页预估，尚未下载核验。"
                : "公开元数据缺少可靠页数，按32页保守预估。") +
              "这是预估，不是实际结算；澄清另行计费。"
            : "这是预估，不是实际结算；未知用量不会记成零。",
        };
        quote = {
          view,
          query,
          expires: Date.parse(value.expiresAt),
          role,
          steps,
          dossier: dossier!,
          candidateId,
        };
        intent = undefined;
        emit({
          type: "run",
          run: { state: "confirm", query, estimate: view, budgetCny: budget },
        });
        return view;
      } catch (error) {
        if (version === quoteVersion && generation === ports.generation())
          emit({
            type: "run",
            run: { state: "idle", message: "预估失败，请核对配置后再预估。" },
          });
        throw error;
      }
    },
    async start(id, budget) {
      current();
      if (intent?.estimate === id && intent.accepted) return;
      if (
        !quote ||
        quote.view.id !== id ||
        quote.dossier !== dossier ||
        Date.now() >= quote.expires ||
        !Number.isFinite(budget) ||
        budget < quote.view.maxCny ||
        budget <= 0 ||
        budget > 50
      )
        throw unavailable();
      if (intent) {
        if (intent.estimate !== id || intent.unknown) return;
        return;
      }
      const query = quote.query;
      const body = {
        dossierId: dossier,
        mode: "read",
        roleId: quote.role,
        budget: { cny: budget },
        estimateId: id,
        confirmed: true,
        input: {
          ...(quote.candidateId
            ? { chosenCandidateId: quote.candidateId }
            : {}),
          query,
          question:
            (quote.candidateId
              ? "请精读已选论文，第一步请求papers.fetch批准："
              : "请精读以下论文查询：") +
            query +
            (quote.candidateId
              ? "。不再检索；等待用户批准下载。"
              : "。先用papers.search查找，使用papers.fetch和papers.pages取得可核对原文。只有摘要时明确标记，不编造页码。按实际证据用read_layer_write写分层讲解、read_quiz_write出检查题、finding_record记录发现。引用必须使用本次已读资产和真实页码原句；需要审批时等待用户决定。最后简要总结结果与不确定性。"),
          limits: { maxSteps: quote.steps },
          memoryRefs: [],
        },
      };
      intent = { estimate: id, key: crypto.randomUUID(), body, unknown: true };
      try {
        const run = await ports.api("/v1/runs", body, intent.key);
        current();
        intent.accepted = run.id;
        intent.unknown = false;
        sourceVersion++;
        runId = run.id;
        emit({
          type: "run",
          run: {
            id: run.id,
            state: "queued",
            query,
            budgetCny: budget,
            spentCny: null,
          },
        });
        await refreshSerially();
      } catch {
        if (generation !== ports.generation()) return;
        try {
          await refreshSerially();
        } catch {}
        if (intent.unknown)
          emit({
            type: "run",
            run: {
              state: "failed",
              unknownCost: true,
              message: "提交结果未知，未再次派发；请先只读刷新核对原运行。",
            },
          });
      }
    },
    async cancel() {
      current();
      if (!runId) throw unavailable();
      try {
        await ports.api(
          "/v1/runs/" + runId + "/cancel",
          {},
          crypto.randomUUID()
        );
        current();
        await refreshSerially();
      } catch {
        if (generation !== ports.generation()) return;
        emit({
          type: "run",
          run: { message: "停止结果尚未核对，请刷新；不会假装已经停止。" },
        });
      }
    },
    async decide(id, approve) {
      current();
      const a = wire?.approvals.find((a) => a.id === id && a.runId === runId);
      if (
        !a ||
        a.sent ||
        a.state !== "pending" ||
        a.kind === "question" ||
        !["running", "waiting"].includes(wire?.run?.state) ||
        wire?.run?.endedAt
      )
        throw unavailable();
      try {
        await ports.decide("approval", id, {
          decision: approve ? "approve" : "reject",
          scope: "once",
        });
        current();
        await refreshSerially();
      } catch {
        if (generation !== ports.generation()) return;
        try {
          await refreshSerially();
        } catch {}
        emit({
          type: "run",
          run: { message: "审批结果尚未核对，未重复执行。" },
        });
      }
    },
    async ask(text) {
      current();
      const events: ReadEvent[] = [
        { type: "user", id: "local-user:" + crypto.randomUUID(), text },
        {
          type: "agent",
          id: "local-agent:" + crypto.randomUUID(),
          text: "追问未接入，将在第二期 P2-05 接入；这里没有生成研究回答。",
        },
      ];
      local.push(...events);
      for (const e of events) emit(e);
    },
    async grade() {
      current();
      throw Error("评分未接入，等待第二期 P2-06。");
    },
  };
}
export const liveReadAdapter = createLiveReadAdapter;
