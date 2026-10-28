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
      if (path === "/v1/kernel/runs/run-1") return { state: "running", usage: { known: false } };
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
      if (path === "/v1/kernel/runs/run-1") return { state: "running", usage: { known: false } };
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
    const layer = (seq: number, no: number) => ({
      seq,
      action: "tool/call",
      payload: {
        name: "card_layer",
        callId: "layer-" + no,
        arguments: JSON.stringify({
          card: { no: String(no), title: "第 " + no + " 层", en: "Layer " + no, body: [{ text: "讲解正文", refs: [] }] },
        }),
      },
    });
    const ports = routes((path) => {
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "completed" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events"))
        return {
          events: [
            layer(1, 1),
            layer(2, 2),
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
