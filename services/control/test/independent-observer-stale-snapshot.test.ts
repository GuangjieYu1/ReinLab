import { expect, it, vi } from "vitest";
import {
  observeRuntime,
  type ObservationSnapshot,
  type ObservationSink,
} from "../src/bridge/openscience/observer";
import type { RuntimeObservationPort } from "../src/bridge/openscience/role-runtime";
const sessionID = "ses_stale_fixture",
  runID = "run_stale_fixture";
const event = (sequence: number, terminal = false) => ({
  sequence,
  sessionID,
  runID,
  time: 1,
  type: terminal ? "runtime.completed" : "message.part.delta",
  properties: terminal
    ? { messageID: "msg_fixture" }
    : {
        sessionID,
        messageID: "msg_fixture",
        partID: "part_fixture",
        field: "text",
        delta: "fixture",
      },
});
function snapshot(
  latestSequence: number,
  terminal = false,
): ObservationSnapshot {
  return {
    sessionID,
    oldestSequence: 1,
    latestSequence,
    decisionScope: "connected_runtime",
    permissions: [],
    questions: [],
    runs: [
      {
        runID,
        sessionID,
        messageID: "msg_fixture",
        state: terminal ? "completed" : "running",
        acceptedAt: 1,
        updatedAt: 2,
      },
    ],
  };
}
function fixture(fresh: ObservationSnapshot) {
  let committed = 0;
  const sequences: number[] = [];
  const sink: ObservationSink = {
    cursor: vi.fn(async () => committed),
    ingest: vi.fn(async (raw) => {
      committed = (raw as { sequence: number }).sequence;
      sequences.push(committed);
    }),
    synchronize: vi.fn(async (current) => {
      if (current.latestSequence < committed)
        throw Object.assign(Error("fixture stale snapshot"), {
          code: "CURSOR_AHEAD",
        });
    }),
    gap: vi.fn(),
    failed: vi.fn(),
  };
  const reader = {
    snapshot: vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValue(fresh),
    replay: vi.fn(async () => ({
      events: [event(1), event(2)],
      oldestSequence: 1,
      latestSequence: 2,
    })),
    subscribe: vi.fn(async function* () {
      yield event(3);
      yield event(4, true);
    }),
    messages: vi.fn(),
    getRun: vi.fn(),
    capabilities: vi.fn(),
  } as RuntimeObservationPort;
  return {
    sink,
    reader,
    sequences,
    run: () =>
      observeRuntime({
        reader,
        sink,
        sessionID,
        runID,
        signal: new AbortController().signal,
      }),
  };
}
it("replay advancing past the first snapshot refreshes before any synchronization", async () => {
  const f = fixture(snapshot(2));
  await expect(f.run()).resolves.toBeUndefined();
  expect(f.sink.synchronize).toHaveBeenCalledExactlyOnceWith(snapshot(2));
  expect(f.reader.snapshot).toHaveBeenCalledTimes(2);
  expect(f.sequences).toEqual([1, 2, 3, 4]);
  expect(f.sink.failed).not.toHaveBeenCalled();
});
it("terminal before subscribe with newer replayable history consumes all events without gap or unknown synchronization", async () => {
  const f = fixture(snapshot(4, true));
  await expect(f.run()).resolves.toBeUndefined();
  expect(f.sink.synchronize).not.toHaveBeenCalled();
  expect(f.reader.subscribe).toHaveBeenCalledWith(
    sessionID,
    2,
    expect.any(AbortSignal),
  );
  expect(f.sequences).toEqual([1, 2, 3, 4]);
  expect(f.sink.gap).not.toHaveBeenCalled();
  expect(f.sink.failed).not.toHaveBeenCalled();
});
it("a fresh snapshot actually behind the committed replay cursor remains a stable failure", async () => {
  const f = fixture(snapshot(1));
  await expect(f.run()).resolves.toBeUndefined();
  expect(f.sink.failed).toHaveBeenCalledExactlyOnceWith("CURSOR_AHEAD");
  expect(f.sink.synchronize).not.toHaveBeenCalled();
  expect(f.reader.subscribe).not.toHaveBeenCalled();
  expect(f.sequences).toEqual([1, 2]);
});
