import { it, expect, vi } from "vitest";
import { createLiveInboxAdapter } from "../../../src/data/inbox-live";
const source = { bench: "research", dossierId: "dossier-a", dossierTitle: "A", runId: "run-a", roleId: "research-read" };
const promotion = { id: "promotion-a", target: "L4.knowledge", items: [{ key: "fact", value: "new", evidence: ["event:17"], supersedes: "memory-a" }], reason: "fixture", createdAt: "2026-10-24T00:00:00Z", expiresAt: "2026-10-25T00:00:00Z", source };
const event = { ref: "event:17", event: { dossierId: source.dossierId, runId: source.runId, kind: "message", payload: { text: "source A" }, at: "2026-10-24T00:00:00Z" } };

it("adapter rejects evidence responses that disagree with the loaded promotion source", async () => {
  for (const changed of [{ dossierId: "foreign-dossier" }, { runId: "foreign-run" }]) {
    const adapter = createLiveInboxAdapter({ generation: () => 1, decide: vi.fn(), inbox: async () => ({ promotions: [promotion], approvals: [] }), api: vi.fn(async () => ({ ...event, event: { ...event.event, ...changed } })) } as never);
    await adapter.load(); await expect(adapter.evidence("event:17")).rejects.toThrow();
  }
});

it("adapter rejects a superseded response for a different item or key", async () => {
  for (const value of [{ id: "memory-other", key: "fact", value: "foreign" }, { id: "memory-a", key: "other", value: "foreign" }]) {
    const adapter = createLiveInboxAdapter({ generation: () => 1, decide: vi.fn(), inbox: async () => ({ promotions: [promotion], approvals: [] }), api: vi.fn(async () => value) } as never);
    await adapter.load(); await expect(adapter.superseded("memory-a")).rejects.toThrow();
  }
});

it("adapter refuses any already-sent approval even if a stale DTO still says pending", async () => {
  const decide = vi.fn();
  const adapter = createLiveInboxAdapter({ generation: () => 1, decide, api: vi.fn(), inbox: async () => ({ promotions: [], approvals: [{ id: "sent", kind: "permission", state: "pending", sent: true }] }) } as never);
  const loaded = await adapter.load(); expect(loaded.approvals[0].state === "indeterminate").toBe(true);
  await expect(adapter.decideApproval("sent", "approve")).rejects.toThrow(); expect(decide).not.toHaveBeenCalled();
});

it("in-flight evidence and superseded reads cannot return an earlier account's values", async () => {
  for (const method of ["evidence", "superseded"] as const) {
    let generation = 1, release!: (value: unknown) => void;
    const adapter = createLiveInboxAdapter({ generation: () => generation, decide: vi.fn(), inbox: async () => ({ promotions: [promotion], approvals: [] }), api: vi.fn(() => new Promise(resolve => { release = resolve; })) } as never);
    await adapter.load(); const pending = method === "evidence" ? adapter.evidence("event:17") : adapter.superseded("memory-a");
    const refused = expect(pending).rejects.toThrow(); generation = 2;
    release(method === "evidence" ? event : { id: "memory-a", key: "fact", value: "earlier account" }); await refused;
  }
});

it("an old in-flight load cannot replace a newer account cache", async () => {
  let generation = 1, resolveOld!: (v: unknown) => void;
  const newer = { ...promotion, id: "promotion-b", source: { ...source, dossierId: "dossier-b", runId: "run-b" }, items: [{ ...promotion.items[0], evidence: ["event:18"] }] };
  const inbox = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce({ promotions: [newer], approvals: [] });
  const api = vi.fn(async () => ({ ref: "event:18", event: { ...event.event, dossierId: "dossier-b", runId: "run-b" } }));
  const adapter = createLiveInboxAdapter({ generation: () => generation, decide: vi.fn(), inbox, api } as never);
  const old = adapter.load().catch(() => undefined); generation = 2; await adapter.load(); resolveOld({ promotions: [promotion], approvals: [] }); await old;
  await expect(adapter.evidence("event:17")).rejects.toThrow(); expect(api).not.toHaveBeenCalled();
  await adapter.evidence("event:18"); expect(api).toHaveBeenCalledTimes(1);
});
