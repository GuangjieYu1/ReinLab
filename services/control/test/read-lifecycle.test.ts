import { afterEach, describe, expect, it } from "vitest";
import { createLiveReadAdapter } from "../../../src/data/read-live";

/** 刷新、重试、换账号这三件事不能把同一段精读搞成两段，也不能读回上一段。 */
const routes = (
  handler: (path: string, body?: any, key?: string) => unknown,
  generation = () => 1,
) => ({
  api: Object.assign(
    async (path: string, body?: unknown, key?: string) =>
      handler(path, body as any, key as string | undefined),
    {},
  ),
  decide: async () => ({}),
  generation,
});

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
});

describe("精读生命周期（kernel 协议）", () => {
  it("同一次开始重试复用同一个幂等键，不会开出第二次运行", async () => {
    const keys: Array<string | undefined> = [];
    const ports = routes((path) => {
      if (path === "/v1/dossiers?view=read") return { items: [{ id: "dossier-1", title: "精读档案" }] };
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [] };
      if (path === "/v1/kernel/runs") return { id: "run-1", sessionId: "ds-1" };
      if (path === "/v1/kernel/runs/run-1")
        return { state: "running", usage: { known: false } };
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const first = ports.api;
    let attempts = 0;
    ports.api = (async (path: string, body?: unknown, key?: string) => {
      if (path === "/v1/kernel/runs") {
        keys.push(key);
        attempts += 1;
        // 第一次的响应在路上丢了，用户点了重试。
        if (attempts === 1) throw Error("HTTP_504");
      }
      return (first as any)(path, body, key);
    }) as never;
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    off = adapter.subscribe(() => {});
    await expect(adapter.start("kernel-estimate", 2.5)).rejects.toThrow();
    await adapter.start("kernel-estimate", 2.5);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("刷新后从这一轮的事件把对话恢复出来", async () => {
    const ports = routes((path) => {
      if (path === "/v1/dossiers?view=read") return { items: [{ id: "dossier-1", title: "精读档案" }] };
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events"))
        return {
          events: [
            { seq: 1, action: "user/message", payload: { id: "u-1", text: "我想读 Toolformer" } },
            { seq: 2, action: "assistant/message", payload: { message: { id: "m-1", content: [{ type: "text", text: "先检索一下。" }] } } },
          ],
        };
      if (path === "/v1/kernel/runs/run-1")
        return { state: "running", usage: { known: false } };
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    off = adapter.subscribe(() => {});
    const snapshot = await adapter.load();
    expect(snapshot.history.slice(0, 2).map((event) => event.type)).toEqual(["user", "agent"]);
    expect(snapshot.history[0]).toMatchObject({ type: "user", text: "我想读 Toolformer" });
    expect(snapshot.history[1]).toMatchObject({ type: "agent", text: "先检索一下。" });
  });

  it("会话已经变了就不再读旧档案的数据", async () => {
    let generation = 1;
    const ports = routes((path) => {
      if (path === "/v1/dossiers?view=read") return { items: [{ id: "dossier-1", title: "精读档案" }] };
      throw Error("UNEXPECTED_ROUTE " + path);
    }, () => generation);
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    generation = 2;
    await expect(adapter.load()).rejects.toThrow(/会话已变化/);
  });

  it("讲不满 5 层刷新后照实写层数，不写已完成", async () => {
    const layer = (seq: number, no: number) => [
      {
        seq,
        action: "tool/call",
        payload: {
          name: "card_layer",
          callId: "layer-" + no,
          arguments: JSON.stringify({
            card: { no: String(no), title: "第 " + no + " 层", en: "Layer " + no, body: [{ text: "讲解正文", refs: [] }] },
          }),
        },
      },
      // 卡片写成功才有回执；没有回执的卡片不算写进去。
      {
        seq: seq + 100,
        action: "tool/result",
        payload: {
          callId: "layer-" + no,
          message: { content: [{ text: JSON.stringify({ cardId: "card-" + no }) }] },
        },
      },
    ];
    const ports = routes((path) => {
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "completed" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events"))
        return {
          events: [
            ...layer(1, 1),
            ...layer(2, 2),
            { seq: 3, action: "turn/end", payload: { reason: { kind: "completed" } } },
          ],
        };
      if (path === "/v1/kernel/runs/run-1") return { state: "completed", usage: { known: true, knownCny: "0.01" } };
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    off = adapter.subscribe(() => {});
    const snapshot = await adapter.load();
    expect(snapshot.layers).toHaveLength(2);
    expect(snapshot.run.state).toBe("done");
    expect(snapshot.run.message).toBe("讲解只生成了 2 层");
  });
});

describe("下载审批只出一张卡", () => {
  it("工具调用和轮询同时说同一件事时只推一个审批事件", async () => {
    const fetchCall = (seq: number) => ({
      seq,
      action: "tool/call",
      payload: { name: "papers_fetch", callId: "call-" + seq, arguments: JSON.stringify({ paperId: "arxiv:2302.04761" }) },
    });
    const ports = routes((path) => {
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events")) return { events: [fetchCall(1)] };
      if (path === "/v1/kernel/runs/run-1")
        return { state: "running", usage: { known: false } };
      if (path === "/v1/approvals?state=pending")
        return { items: [{ id: "00000000-0000-4000-8000-0000000000aa", runId: "run-1", kind: "permission", title: "下载论文全文" }] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    const events: any[] = [];
    off = adapter.subscribe((event) => events.push(event));
    await adapter.load();
    const approvals = events.filter((event) => event.type === "approval");
    expect(approvals).toHaveLength(1);
  });
});

describe("审批卡落定后消失", () => {
  it("approval.decided 之后不再留一张待批的卡", async () => {
    const events = [
      { seq: 1, action: "tool/call", payload: { name: "papers_fetch", callId: "call-1", arguments: JSON.stringify({ paperId: "arxiv:2302.04761" }) } },
      { seq: 2, action: "approval.decided", payload: { approvalId: "00000000-0000-4000-8000-0000000000bb", decision: "approve", scope: "once" } },
    ];
    const ports = routes((path) => {
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events")) return { events };
      if (path === "/v1/kernel/runs/run-1")
        return { state: "running", usage: { known: false } };
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    const seen: any[] = [];
    off = adapter.subscribe((event) => seen.push(event));
    const snapshot = await adapter.load();
    const approvals = snapshot.history.filter((event) => event.type === "approval");
    expect(approvals.map((event) => (event as any).state)).toEqual(["pending", "approved"]);
    expect(seen.filter((event) => event.type === "approval").map((event) => (event as any).state)).toEqual(["pending", "approved"]);
  });
});

describe("点卡片落地", () => {
  it("同一档案里上一轮留下的下载卡也能点（面板显示的是它）", async () => {
    const decided: Array<{ kind: string; id: string; body: any }> = [];
    const ports = {
      api: Object.assign(
        async (path: string) => {
          if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
          if (path.startsWith("/v1/kernel/runs/run-1/events")) return { events: [] };
          if (path === "/v1/kernel/runs/run-1")
        return { state: "running", usage: { known: false } };
          if (path === "/v1/approvals?state=pending")
            return {
              items: [
                {
                  id: "00000000-0000-4000-8000-0000000000cc",
                  runId: "run-old",
                  kind: "permission",
                  title: "下载论文全文",
                  source: { dossierId: "dossier-1" },
                },
              ],
            };
          throw Error("UNEXPECTED_ROUTE " + path);
        },
        {},
      ),
      decide: async (kind: string, id: string, body: any) => {
        decided.push({ kind, id, body });
        return {};
      },
      generation: () => 1,
    };
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    off = adapter.subscribe(() => {});
    await adapter.load();
    await adapter.decide("call-anything", true);
    expect(decided).toHaveLength(1);
    expect(decided[0].id).toBe("00000000-0000-4000-8000-0000000000cc");
  });
});

describe("审批卡不会在用户看到之前消失", () => {
  it("待办还没同步过来时继续显示卡片；过期后写「审批已过期」而不是拒绝", { timeout: 20000 }, async () => {
    const fetchCall = {
      seq: 1,
      action: "tool/call",
      payload: { name: "papers_fetch", callId: "call-1", arguments: JSON.stringify({ paperId: "arxiv:2302.04761" }) },
    };
    let expire = false,
      finished = false;
    const ports = routes((path) => {
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events"))
        return {
          events: expire
            ? [fetchCall, { seq: 2, action: "approval.expired", payload: { approvalId: "00000000-0000-4000-8000-0000000000dd" } }]
            : [fetchCall],
        };
      if (path === "/v1/kernel/runs/run-1")
        return { state: finished ? "completed" : "running", usage: { known: false } };
      // 审批行还没建好（或还没同步过来）：列表是空的。
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    const seen: any[] = [];
    off = adapter.subscribe((event) => seen.push(event));
    await adapter.load();
    // 一个轮询周期之后，空列表不能把卡收掉。
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const approvals = seen.filter((event) => event.type === "approval");
    expect(approvals.filter((event) => event.state === "pending")).toHaveLength(1);
    expect(approvals.some((event) => event.state === "approved")).toBe(false);

    // 后端说它过期了：卡片收起，但运行条要说明是过期，不是「你拒绝了」。
    expire = true;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const expired = seen.filter((event) => event.type === "approval" && event.state === "expired");
    expect(expired).toHaveLength(1);
    const messages = seen.filter((event) => event.type === "run").map((event: any) => event.run.message);
    expect(messages).toContain("审批已过期，可以重新开始");
    // 这一轮后来结束了，也不能把「过期」改成「讲解只生成了 0 层」。
    finished = true;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const lastRun = seen.filter((event) => event.type === "run").at(-1) as any;
    expect(lastRun.run.message ?? "").toBe("审批已过期，可以重新开始");
  });
});
