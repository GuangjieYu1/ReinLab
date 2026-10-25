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
  },
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
  let refreshQueue = Promise.resolve();
  let quoteVersion = 0,
    sourceVersion = 0,
    createKey: string | undefined,
    creating: Promise<boolean> | undefined,
    loading: Promise<ReadSnapshot> | undefined;
  const current = () => {
    if (generation !== ports.generation()) throw unavailable();
  };
  const forThisAccount = (value: ReadSnapshot) => generation === ports.generation()
    ? value : empty('会话已变化，请重新登录后读取档案。');
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
        "新档案创建结果未知，未切回旧档案运行；请再次新建以核对同一收据。",
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
        (runId ? "?runId=" + encodeURIComponent(runId) : ""),
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
          data.cursor,
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
            cursor,
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
    stop();
    quoteVersion++;
    const expected = epoch;
    createKey ??= crypto.randomUUID();
    const work = (async () => {
      const created = await ports.api(
        "/v1/dossiers",
        { bench: "research", title: "新的精读" },
        createKey,
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
          if(generation !== ports.generation())return forThisAccount(snapshot);
          if (version !== epoch && loading && loading !== work)
            return forThisAccount(await loading);
          if (version === epoch && sourceVersion !== before) return forThisAccount(snapshot);
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
          "/v1/dossiers/" + dossier + "/harness?view=read",
        );
        current();
        if (
          version !== quoteVersion ||
          dossier !== expected ||
          harness.version !== "1.1.0"
        )
          throw Error("旧工作台档案请新建精读，不会静默升级。");
        const role = harness.entrypoints.read,
          steps = harness.roles[role].steps;
        const value = await ports.api(
          "/v1/runs/estimate",
          { dossierId: dossier, mode: "read" },
          crypto.randomUUID(),
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
          note: "这是预估，不是实际结算；未知用量不会记成零。",
        };
        quote = {
          view,
          query,
          expires: Date.parse(value.expiresAt),
          role,
          steps,
          dossier: dossier!,
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
          query,
          question:
            "请精读以下论文查询：" +
            query +
            "。先用papers.search查找，使用papers.fetch和papers.pages取得可核对原文。只有摘要时明确标记，不编造页码。按实际证据用read_layer_write写分层讲解、read_quiz_write出检查题、finding_record记录发现。引用必须使用本次已读资产和真实页码原句；需要审批时等待用户决定。最后简要总结结果与不确定性。",
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
        await refresh();
      } catch {
        if (generation !== ports.generation()) return;
        try {
          await refresh();
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
          crypto.randomUUID(),
        );
        current();
        await refresh();
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
        await refresh();
      } catch {
        if (generation !== ports.generation()) return;
        try {
          await refresh();
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
