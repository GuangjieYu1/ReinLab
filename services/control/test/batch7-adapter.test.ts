import { it, expect, vi } from "vitest";
import { createLiveReadAdapter } from "../../../src/data/read-live";
const d = "11111111-1111-4111-8111-111111111111",
  p = "22222222-2222-4222-8222-222222222222",
  pick = "33333333-3333-4333-8333-333333333333";
function wire() {
  return {
    dossier: { id: d, title: "实际档案", benchVersion: "1.2.0" },
    cursor: 0,
    run: null,
    papers: [],
    pages: [],
    approvals: [],
    clarification: {
      chosen: null as any,
      spentCny: 0.0123,
      capCny: 0.05,
      unknownCost: false,
      history: [
        {
          type: "pick",
          id: pick,
          query: "请选择",
          candidates: [
            {
              id: p,
              title: "实际候选",
              authors: "实际作者",
              venue: "实际来源",
              access: "full",
              pages: 12,
            },
          ],
          state: "pending",
        },
      ],
    },
  };
}
it("live clarification and human choice use receipt projection; estimate passes candidate only and confirmation never asks for another search", async () => {
  const data = wire(),
    calls: any[] = [];
  const api = vi.fn(async (path: string, body?: any, key?: string) => {
    calls.push({ path, body, key });
    if (path.endsWith("/read-state")) return structuredClone(data);
    if (path.endsWith("/read/clarify")) return { accepted: true };
    if (path.endsWith("/read/pick")) {
      data.clarification.chosen = {
        ...data.clarification.history[0].candidates[0],
      };
      return { accepted: true };
    }
    if (path.endsWith("/harness?view=read"))
      return {
        version: "1.2.0",
        entrypoints: { read: "research-read" },
        roles: { "research-read": { steps: 48 } },
      };
    if (path === "/v1/runs/estimate")
      return {
        id: "quote",
        estimatedCny: "1.000000",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        model: "deepseek/deepseek-v4-flash",
      };
    if (path === "/v1/runs") return { id: "actual-run" };
    if (path.endsWith("/read/unchoose")) {
      data.clarification.chosen = null;
      return { cleared: true };
    }
    throw Error("UNEXPECTED_API");
  });
  const a = createLiveReadAdapter(d, {
    api,
    decide: vi.fn(),
    generation: () => 1,
    stream: vi.fn(),
  } as any);
  let view = await a.load();
  expect(view.run.chosen).toBeUndefined();
  expect(view.run.clarifySpentCny).toBe(0.0123);
  expect(view.history[0].type).toBe("pick");
  await expect(a.estimate(p, 5)).rejects.toBeDefined();
  expect(calls.some((c) => c.path === "/v1/runs/estimate")).toBe(false);
  await a.clarify("先说明研究方向");
  await a.pick(pick, p);
  view = await a.load();
  expect(view.run.chosen?.id).toBe(p);
  const quote = await a.estimate(p, 5);
  expect(quote.note).toContain("12 页");
  view = await a.load();
  expect(view.run.state).toBe("confirm");
  expect(view.run.estimate?.id).toBe(quote.id);
  expect(calls.find((c) => c.path === "/v1/runs/estimate").body).toEqual({
    dossierId: d,
    mode: "read",
    candidateId: p,
  });
  await a.start(quote.id, 5);
  const admitted = calls.find((c) => c.path === "/v1/runs");
  expect(admitted.body.input.chosenCandidateId).toBe(p);
  expect(admitted.body.input.question).not.toContain("papers.search");
});
it("unknown clarify POST retains its idempotency key, blocks another intent and never retries automatically", async () => {
  const data = wire(),
    keys: string[] = [];
  const api = vi.fn(async (path: string, _body?: any, key?: string) => {
    if (path.endsWith("/read-state")) return data;
    if (path.endsWith("/read/clarify")) {
      keys.push(key!);
      throw Error("LOST_RESPONSE");
    }
    throw Error("UNEXPECTED_API");
  });
  const a = createLiveReadAdapter(d, {
    api,
    decide: vi.fn(),
    generation: () => 1,
    stream: vi.fn(),
  } as any);
  await a.load();
  await a.clarify("原要求");
  expect(keys).toHaveLength(1);
  await a.clarify("不同要求");
  expect(keys).toHaveLength(1);
  await a.clarify("原要求");
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
});
it("clarify waits for an in-flight new dossier and cannot submit to the previous dossier", async () => {
  let finish!: (v: any) => void;
  const created = new Promise((r) => (finish = r)),
    calls: string[] = [];
  const next = "44444444-4444-4444-8444-444444444444";
  const api = vi.fn(async (path: string) => {
    if (path === "/v1/dossiers") return created;
    if (path.endsWith('/read/cancel-clarify')) return {accepted:true};
    if (path.includes("/read/clarify")) {
      calls.push(path);
      return { accepted: true };
    }
    if (path.endsWith("/read-state"))
      return {
        ...wire(),
        dossier: { id: path.includes(next) ? next : d, title: "档案" },
      };
    throw Error("UNEXPECTED_API");
  });
  const a = createLiveReadAdapter(d, {
    api,
    decide: vi.fn(),
    generation: () => 1,
    stream: vi.fn(),
  } as any);
  await a.load();
  const creating = a.newReading!(),
    clarifying = a.clarify("新档案要求");
  await Promise.resolve();
  expect(calls).toEqual([]);
  finish({ id: next, title: "新档案" });
  await creating;
  await clarifying;
  expect(calls).toEqual(["/v1/dossiers/" + next + "/read/clarify"]);
});

it("pending clarification text replies to the same question/run rather than admitting another run", async()=>{
 const data:any=wire();data.clarification.pendingQuestion={approvalId:pick,runId:p};data.clarification.activeRunId=p;
 const calls:any[]=[];const api=async(path:string,body?:any)=>{if(path.endsWith('/read-state'))return structuredClone(data);calls.push({path,body});return {accepted:true,runId:p};};
 const a=createLiveReadAdapter(d,{api,decide:vi.fn(),generation:()=>1,stream:vi.fn()} as any);
 await a.load();await a.clarify('补充：Toolformer');
 expect(calls).toEqual([{path:'/v1/dossiers/'+d+'/read/clarify',body:{text:'补充：Toolformer',approvalId:pick}}]);
});
it("new reading closes old clarification first and exposes the explicit cancel port",async()=>{
 const data:any=wire();data.clarification.activeRunId=p;data.clarification.unknownCost=true;
 const order:string[]=[];const api=async(path:string)=>{if(path.endsWith('/read-state'))return structuredClone(data);order.push(path);if(path.endsWith('/read/cancel-clarify')){data.clarification.activeRunId=null;return{accepted:true};}if(path==='/v1/dossiers'){data.dossier={id:p,title:'新档案'};return data.dossier;}throw Error('unexpected');};
 const a=createLiveReadAdapter(d,{api,decide:vi.fn(),generation:()=>1,stream:vi.fn()}as any);
 const before=await a.load();expect(before.run.clarifySpentCny).toBe(.0123);expect(before.run.unknownCost).toBe(true);expect(before.run.clarifyUnknownCost).toBe(true);
 expect(typeof a.cancelClarify).toBe('function');await a.newReading!();expect(order).toEqual(['/v1/dossiers/'+d+'/read/cancel-clarify','/v1/dossiers']);
});
it("definitively rejected clarification does not permanently fence the next text",async()=>{
 const data=wire();let posts=0;const api=async(path:string)=>{if(path.endsWith('/read-state'))return structuredClone(data);if(++posts===1)throw Object.assign(Error('rejected'),{status:409});return{accepted:true};};
 const a=createLiveReadAdapter(d,{api,decide:vi.fn(),generation:()=>1,stream:vi.fn()}as any);await a.load();await a.clarify('第一句');await a.clarify('新的补充');expect(posts).toBe(2);
});

it("an accepted reply is not reported as rejected when only its read refresh fails",async()=>{
 const data:any=wire();data.clarification.pendingQuestion={approvalId:pick,runId:p};let posted=false;const events:any[]=[];
 const api=async(path:string)=>{if(path.endsWith('/read-state')){if(posted)throw Error('read unavailable');return structuredClone(data);}posted=true;return{accepted:true,runId:p};};
 const a=createLiveReadAdapter(d,{api,decide:vi.fn(),generation:()=>1,stream:vi.fn()}as any);await a.load();const off=a.subscribe(e=>events.push(e));await a.clarify('Toolformer');off();
 expect(events.some(e=>e.type==='agent'&&e.text.includes('澄清已受理'))).toBe(true);expect(events.some(e=>e.type==='agent'&&e.text.includes('澄清未受理'))).toBe(false);
});
