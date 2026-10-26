import { it, expect, vi } from "vitest";
import { createLiveReadAdapter } from "../../../src/data/read-live";
import { projectReading } from "../../../src/data/read-projection";
const dossier = "11111111-1111-4111-8111-111111111111",
  run = "22222222-2222-4222-8222-222222222222";
const idle = () => ({
  dossier: { id: dossier, title: "fixture" },
  cursor: 0,
  run: null,
  papers: [],
  pages: [],
  approvals: [],
});
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const estimate = () => ({
  id: "estimate",
  model: "deepseek/deepseek-v4-flash",
  estimatedCny: "0.050000",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});
const harness = {
  version: "1.1.0",
  entrypoints: { read: "research-read" },
  roles: { "research-read": { steps: 48 } },
};
it('first account without dossiers subscribes when estimate explicitly creates its first dossier',async()=>{
 const api=vi.fn(async(p:string,b?:unknown)=>{if(p==='/v1/dossiers?view=read')return{items:[]};if(p==='/v1/dossiers'&&b)return{id:dossier,title:'created'};if(p.includes('/harness'))return harness;if(p==='/v1/runs/estimate')return estimate();if(p.includes('/read-state'))return idle();throw Error('unexpected '+p);});
 const stream=vi.fn(async()=>new Response(new ReadableStream()));const a=createLiveReadAdapter(undefined,{api,generation:()=>1,decide:vi.fn(),stream} as any);await a.load();const off=a.subscribe(()=>{});expect(stream).not.toHaveBeenCalled();await a.estimate('first actual query',5);expect(stream).toHaveBeenCalledTimes(1);expect(stream.mock.calls[0][0]).toContain(dossier+'/events?view=read&after=0');off();
});
it('logout after a newer run snapshot cannot return cached prior-account data to a delayed load',async()=>{
 const gate=deferred<any>();let generation=1,hold=false,accepted=false;
 const privateState=()=>({...idle(),dossier:{id:dossier,title:'PRIVATE_PRIOR_ACCOUNT'},run:{id:accepted?run:'old-run',state:accepted?'queued':'completed',budgetCny:5,spentCny:null}});
 const api=vi.fn(async(p:string)=>{if(p.includes('/read-state')){if(hold){hold=false;return gate.promise;}return privateState();}if(p.includes('/harness'))return harness;if(p==='/v1/runs/estimate')return estimate();if(p==='/v1/runs'){accepted=true;return{id:run};}throw Error('unexpected');});
 const a=createLiveReadAdapter(dossier,{api,generation:()=>generation,decide:vi.fn(),stream:vi.fn()} as any);await a.load();const q=await a.estimate('query',5);hold=true;const earlier=a.load();await vi.waitFor(()=>expect(api.mock.calls.filter(c=>c[0].includes('/read-state'))).toHaveLength(2));await a.start(q.id,5);generation++;gate.resolve(privateState());expect(JSON.stringify(await earlier)).not.toContain('PRIVATE_PRIOR_ACCOUNT');
});
it("unknown dossier creation cannot silently estimate on the previous dossier", async () => {
  const api = vi.fn(async (p: string) => {
    if (p === "/v1/dossiers") throw Error("lost create");
    if (p.includes("/read-state")) return idle();
    throw Error("unexpected estimate on old dossier");
  });
  const a = createLiveReadAdapter(dossier, {
    api,
    generation: () => 1,
    decide: vi.fn(),
    stream: vi.fn(),
  } as any);
  await a.load();
  await a.newReading();
  const s = await a.load();
  expect(s.run.state).toBe("failed");
  expect(s.run.message).toMatch(/新档案.*未知/);
  await expect(a.estimate("query", 5)).rejects.toThrow();
  expect(api.mock.calls.some((c) => c[0].includes("/harness"))).toBe(false);
});
it("unknown confirmed submission is never reposted or replaced by another dossier", async () => {
  const calls: any[] = [];
  const api = vi.fn(async (p: string, b?: any) => {
    calls.push({ p, b });
    if (p.includes("/read-state")) return idle();
    if (p.includes("/harness")) return harness;
    if (p === "/v1/runs/estimate") return estimate();
    if (p === "/v1/runs") throw Error("unknown response");
    throw Error("unexpected");
  });
  const a = createLiveReadAdapter(dossier, {
    api,
    generation: () => 1,
    decide: vi.fn(),
    stream: vi.fn(),
  } as any);
  await a.load();
  const q = await a.estimate("actual query", 5);
  await a.start(q.id, 5);
  await a.start(q.id, 5);
  await a.newReading();
  await expect(a.estimate("different", 5)).rejects.toThrow();
  expect(calls.filter((c) => c.p === "/v1/runs")).toHaveLength(1);
  expect(calls.filter((c) => c.p === "/v1/dossiers")).toHaveLength(0);
});
it("SSE split UTF8 frames, reconnect cursor and replay only refresh committed snapshots; unsubscribe cancels", async () => {
  let data: any = idle(),
    sink!: ReadableStreamDefaultController<Uint8Array>,
    signal!: AbortSignal;
  const api = vi.fn(async (p: string) =>
    p.includes("/read-state")
      ? structuredClone(data)
      : {
          items: [{ seq: 1, dossierId: dossier, runId: run, payload: {} }],
          cursor: 1,
          done: true,
        },
  );
  const stream = vi.fn(async (_p: string, s: AbortSignal) => {
    signal = s;
    return new Response(
      new ReadableStream({
        start(c) {
          sink = c;
        },
        cancel() {},
      }),
    );
  });
  const a = createLiveReadAdapter(dossier, {
    api,
    generation: () => 1,
    decide: vi.fn(),
    stream,
  } as any);
  await a.load();
  const events: any[] = [];
  const off = a.subscribe((e) => events.push(e));
  await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  data = {
    ...idle(),
    cursor: 1,
    run: {
      id: run,
      state: "running",
      query: "中文查询",
      budgetCny: 5,
      spentCny: null,
    },
  };
  const frame = new TextEncoder().encode(
    "id: 1\r\nevent: ledger\r\ndata: " +
      JSON.stringify({
        seq: 1,
        dossierId: dossier,
        payload: { text: "中文" },
      }) +
      "\r\n\r\n",
  );
  sink.enqueue(frame.slice(0, frame.length - 4));
  sink.enqueue(frame.slice(frame.length - 4));
  await vi.waitFor(() =>
    expect(
      events.some((e) => e.type === "run" && e.run.query === "中文查询"),
    ).toBe(true),
  );
  const count = api.mock.calls.length;
  sink.enqueue(frame);
  await new Promise((r) => setTimeout(r, 20));
  expect(api.mock.calls.length).toBe(count);
  sink.close();
  await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2), {
    timeout: 2000,
  });
  expect(stream.mock.calls[1][0]).toContain("after=1");
  off();
  expect(signal.aborted).toBe(true);
});
it("a late snapshot from an earlier load cannot replace the newer load", async () => {
  const first = deferred<any>();
  let n = 0;
  const api = vi.fn(async () =>
    ++n === 1
      ? first.promise
      : { ...idle(), dossier: { id: dossier, title: "newer" } },
  );
  const a = createLiveReadAdapter(dossier, {
    api,
    generation: () => 1,
    decide: vi.fn(),
    stream: vi.fn(),
  } as any);
  const old = a.load();
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  const newer = a.load();
  expect((await newer).dossier.title).toBe("newer");
  first.resolve({ ...idle(), dossier: { id: dossier, title: "stale" } });
  expect((await old).dossier.title).toBe("newer");
});
it("logout during an in-flight snapshot and mutation cannot publish prior-account data", async () => {
  const gate = deferred<any>();
  let generation = 1;
  const a = createLiveReadAdapter(dossier, {
    api: vi.fn(() => gate.promise),
    generation: () => generation,
    decide: vi.fn(),
    stream: vi.fn(),
  } as any);
  const pending = a.load();
  generation++;
  gate.resolve({
    ...idle(),
    dossier: { id: dossier, title: "private prior account" },
  });
  expect(JSON.stringify(await pending)).not.toContain("private prior account");
  await expect(a.ask("later")).rejects.toThrow();
});
it("sent, question, expired and indeterminate approvals never expose approve, and no decision is optimistic", async () => {
  const data: any = {
    ...idle(),
    run: { id: run, state: "waiting", budgetCny: 5, spentCny: null },
    approvals: ["sent", "question", "expired", "indeterminate", "valid"].map(
      (id, i) => ({
        id,
        runId: run,
        kind: i === 1 ? "question" : "permission",
        state: i === 2 ? "expired" : i === 3 ? "indeterminate" : "pending",
        sent: i === 0,
        title: id,
        effects: ["once"],
        risk: "write",
      }),
    ),
  };
  const decision = vi.fn(async () => {
    throw Error("lost decision");
  });
  const a = createLiveReadAdapter(dossier, {
    api: vi.fn(async () => data),
    generation: () => 1,
    decide: decision,
    stream: vi.fn(),
  } as any);
  const snap = await a.load();
  expect(
    snap.history.filter((e) => e.type === "approval").map((e) => e.id),
  ).toEqual(["valid"]);
  for (const id of ["sent", "question", "expired", "indeterminate"])
    await expect(a.decide(id, true)).rejects.toThrow();
  expect(decision).not.toHaveBeenCalled();
  await a.decide("valid", true);
  expect(decision).toHaveBeenCalledWith("approval", "valid", {
    decision: "approve",
    scope: "once",
  });
  expect(
    (await a.load()).history.some(
      (e) => e.type === "approval" && e.state === "approved",
    ),
  ).toBe(false);
  data.run.state = "completed";
  expect(
    (await a.load()).history.some(
      (e) => e.type === "approval" && e.state === "pending",
    ),
  ).toBe(false);
  await expect(a.decide("valid", true)).rejects.toThrow();
});
it("different assets with page 1 cannot share cards or page references, and intermediate model text is hidden", () => {
  const data: any = {
    ...idle(),
    run: { id: run, state: "running", budgetCny: 5, spentCny: null },
    papers: [
      { id: "A", runId: run, access: "full" },
      { id: "B", runId: run, access: "full" },
    ],
    pages: [
      { assetId: "A", page: 1, quote: "A original" },
      { assetId: "B", page: 1, quote: "B original" },
    ],
  };
  const events: any[] = [
    {
      seq: 1,
      runId: run,
      kind: "card",
      action: "card_created",
      payload: {
        cardId: "bad",
        cardType: "layer",
        card: {
          paperId: "A",
          no: "1",
          title: "mixed",
          en: "BAD",
          body: [
            {
              text: "mixed",
              refs: [{ paperId: "B", page: 1, quote: "B original" }],
            },
          ],
        },
      },
    },
    {
      seq: 2,
      runId: run,
      payload: { properties: { info: { id: "message", role: "assistant" } } },
    },
    {
      seq: 3,
      runId: run,
      payload: {
        properties: {
          part: {
            id: "part",
            messageID: "message",
            type: "text",
            text: "intermediate",
          },
        },
      },
    },
  ];
  const snap = projectReading(data, events);
  expect(snap.layers).toEqual([]);
  expect(snap.paper?.sections[0].gist).toEqual(["A original"]);
  expect(snap.history.filter((e) => e.type === "agent")).toEqual([]);
  data.run.state = "completed";
  expect(
    projectReading(data, events).history.some(
      (e) => e.type === "agent" && e.text === "intermediate",
    ),
  ).toBe(true);
});
it("ended runs carry the reason the UI writes as the title", () => {
  const base = (over: Record<string, unknown>) =>
    ({
      ...idle(),
      run: { id: run, query: "q", budgetCny: 5, spentCny: 0.01, ...over },
    } as any);
  const ended = { endedAt: "2026-10-27T00:00:00.000Z", state: "completed" };
  // 没拿到全文：状态是 completed，但界面要写「没拿到全文」
  expect(
    projectReading(
      {
        ...base(ended),
        papers: [{ id: "A", runId: run, access: "abstract_only" }],
        pages: [],
      },
      []
    ).run.endReason
  ).toBe("abstract_only");
  // 拒绝下载：审批被驳回
  const rejected = base(ended);
  rejected.approvals = [
    { id: "ap", runId: run, kind: "permission", action: "papers.fetch", state: "rejected" },
  ];
  expect(projectReading(rejected, []).run.endReason).toBe("rejected");
  // 预算暂停且已结束：终态是「已停止」，原因是预算
  const paused = projectReading(
    base({ state: "paused_budget", endedAt: ended.endedAt }),
    []
  ).run;
  expect(paused.state).toBe("cancelled");
  expect(paused.endReason).toBe("budget");
  // 还在跑：不给结束原因
  expect(
    projectReading(base({ state: "running", endedAt: null }), []).run.endReason
  ).toBeUndefined();
  // 正常读完
  expect(projectReading(base(ended), []).run.endReason).toBe("completed");
});
it("clarification spend and cap survive projection even when the clarify run ended cancelled", () => {
  const snap = projectReading(
    {
      ...idle(),
      clarification: {
        chosen: null,
        spentCny: 0.013354,
        capCny: 0.5,
        unknownCost: false,
        history: [],
        selectionRevision: 2,
      },
      run: {
        id: run,
        query: "q",
        state: "cancelled",
        budgetCny: 5,
        spentCny: null,
        endedAt: "2026-10-27T00:00:00.000Z",
      },
    } as any,
    []
  );
  expect(snap.run.clarifySpentCny).toBe(0.013354);
  expect(snap.run.clarifyCapCny).toBe(0.5);
  expect(snap.run.endReason).toBe("cancelled");
});
it("creating a dossier with an unknown response retains exactly the same idempotency key", async () => {
  const keys: string[] = [];
  let count = 0;
  const api = vi.fn(async (p: string, _b: any, key: string) => {
    if (p === "/v1/dossiers") {
      keys.push(key);
      if (++count === 1) throw Error("lost");
      return { id: dossier, title: "created" };
    }
    if (p.includes("/read-state")) return idle();
    return { items: [] };
  });
  const a = createLiveReadAdapter(undefined, {
    api,
    generation: () => 1,
    decide: vi.fn(),
    stream: vi.fn(),
  } as any);
  await a.load();
  await a.newReading();
  await a.newReading();
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect((await a.load()).dossier.id).toBe(dossier);
});
it.each(["garbage", new Date(Date.now() - 10000).toISOString()])(
  "invalid or expired estimate %s cannot be confirmed",
  async (expiresAt) => {
    const api = vi.fn(async (p: string) =>
      p.includes("/read-state")
        ? idle()
        : p.includes("/harness")
          ? harness
          : { ...estimate(), expiresAt },
    );
    const a = createLiveReadAdapter(dossier, {
      api,
      generation: () => 1,
      decide: vi.fn(),
      stream: vi.fn(),
    } as any);
    await a.load();
    await expect(a.estimate("query", 5)).rejects.toThrow();
    await expect(a.start("estimate", 5)).rejects.toThrow();
    expect(api.mock.calls.filter((c) => c[0] === "/v1/runs")).toHaveLength(0);
  },
);
