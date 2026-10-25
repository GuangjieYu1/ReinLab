import { it, expect, vi } from "vitest";
import { reconcileObservation } from "../src/bridge/openscience/reconcile";

it("finite recovery never touches mutation/subscribe capabilities while history keeps growing", async () => {
  let cursor = 0, snapshots = 0, forbidden = 0;
  const reader = new Proxy({
    async snapshot() { return { sessionID: "session", latestSequence: ++snapshots === 1 ? 3 : 12, runs: [], permissions: [], questions: [] }; },
    async replay() { return { events: Array.from({ length: 12 }, (_, i) => ({ sequence: i + 1 })) }; },
  }, { get(target, key) { if (["subscribe", "prompt", "decide", "cancel"].includes(String(key))) { forbidden++; throw Error("FORBIDDEN_RECOVERY_CAPABILITY"); } return Reflect.get(target, key); } });
  const ingested: number[] = [], synchronize = vi.fn();
  const sink = { cursor: async () => cursor, ingest: async (raw: any) => { cursor = raw.sequence; ingested.push(cursor); }, synchronize, gap: vi.fn(), failed: vi.fn() };
  expect(await reconcileObservation({ reader: reader as never, sink, sessionID: "session" })).toEqual({ cursor: 3, highWater: 3, caughtUp: true });
  expect(ingested).toEqual([1, 2, 3]); expect(synchronize).not.toHaveBeenCalled(); expect(forbidden).toBe(0);
});

it("sink failure cannot advance a durable cursor or cause a read-only retry to skip history", async () => {
  let cursor = 0, fail = true; const committed: number[] = [], requested: number[] = [];
  const reader = {
    async snapshot() { return { sessionID: "session", latestSequence: 3, runs: [], permissions: [], questions: [] }; },
    async replay(_session: string, after: number) { requested.push(after); return { events: [1, 2, 3].filter(n => n > after).map(sequence => ({ sequence })) }; },
  };
  const sink = { cursor: async () => cursor, ingest: async (raw: any) => { if (raw.sequence === 2 && fail) { fail = false; throw Error("SYNTHETIC_PRECOMMIT_FAILURE"); } cursor = raw.sequence; committed.push(cursor); }, synchronize: vi.fn(), gap: vi.fn(), failed: vi.fn() };
  await expect(reconcileObservation({ reader: reader as never, sink, sessionID: "session" })).rejects.toThrow("SYNTHETIC_PRECOMMIT_FAILURE");
  expect(cursor).toBe(1);
  expect((await reconcileObservation({ reader: reader as never, sink, sessionID: "session" })).cursor).toBe(3);
  expect(requested).toEqual([0, 1]); expect(committed).toEqual([1, 2, 3]);
});
