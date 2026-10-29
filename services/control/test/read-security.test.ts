import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveReadAdapter } from "../../../src/data/read-live";

/** 审批只对「这一轮」有效：不做乐观决定，也不让别的运行借卡片 id 被点掉。 */
const routes = (
  handler: (path: string, body?: any, key?: string) => unknown,
  decide?: (kind: string, id: string, body: any) => Promise<unknown>,
) => ({
  api: vi.fn(async (path: string, body?: unknown, key?: string) =>
    handler(path, body as any, key as string | undefined),
  ),
  decide: vi.fn(decide ?? (async () => ({}))),
  generation: () => 1,
});

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
});

const fetchCall = {
  seq: 1,
  action: "tool/call",
  payload: { name: "papers_fetch", callId: "call-fetch", arguments: JSON.stringify({ paperId: "arxiv:2302.04761v1" }) },
};

describe("精读适配器审批（kernel 协议）", () => {
  it("待办里只有别的运行的审批时，点这张卡不会替别人做决定", async () => {
    const ports = routes((path) => {
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
      if (path.startsWith("/v1/kernel/runs/run-1/events")) return { events: [fetchCall] };
      if (path === "/v1/kernel/runs/run-1") return { state: "running", usage: { known: false } };
      if (path === "/v1/approvals?state=pending")
        return { items: [{ id: "approval-other", runId: "run-other", title: "下载论文全文" }] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    off = adapter.subscribe(() => {});
    await adapter.load();
    await adapter.decide("call-fetch", true);
    expect(ports.decide).not.toHaveBeenCalled();
  });

  it("后端没确认批准就不写已批准，驳回才照实收尾", async () => {
    const ports = routes(
      (path) => {
        if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-1", state: "running" }] };
        if (path.startsWith("/v1/kernel/runs/run-1/events")) return { events: [fetchCall] };
        if (path === "/v1/kernel/runs/run-1") return { state: "running", usage: { known: false } };
        if (path === "/v1/approvals?state=pending")
          return { items: [{ id: "00000000-0000-4000-8000-000000000001", runId: "run-1", title: "下载论文全文" }] };
        throw Error("UNEXPECTED_ROUTE " + path);
      },
      async () => {
        throw Error("HTTP_500");
      },
    );
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    const events: any[] = [];
    off = adapter.subscribe((event) => events.push(event));
    await adapter.load();
    await expect(adapter.decide("call-fetch", true)).rejects.toThrow();
    expect(events.filter((event) => event.type === "approval" && event.state !== "pending")).toEqual([]);
  });

  it("取消只发给当前这一轮，不碰上一段精读", async () => {
    const cancelled: string[] = [];
    const ports = routes((path) => {
      if (path === "/v1/kernel/dossiers/dossier-1/runs") return { runs: [{ id: "run-2", state: "running" }] };
      if (path.startsWith("/v1/kernel/runs/run-2/events")) return { events: [] };
      if (path === "/v1/kernel/runs/run-2") return { state: "running", usage: { known: false } };
      if (path.endsWith("/cancel")) {
        cancelled.push(path);
        return { state: "cancelled" };
      }
      if (path === "/v1/approvals?state=pending") return { items: [] };
      throw Error("UNEXPECTED_ROUTE " + path);
    });
    const adapter = createLiveReadAdapter("dossier-1", ports as never);
    off = adapter.subscribe(() => {});
    await adapter.load();
    await adapter.cancel();
    expect(cancelled).toEqual(["/v1/kernel/runs/run-2/cancel"]);
  });
});
