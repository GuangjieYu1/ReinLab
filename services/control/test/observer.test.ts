import { afterEach, expect, it, vi } from "vitest";
import {
  observeRuntime,
  type ObservationSnapshot,
  type ObservationSink,
} from "../src/bridge/openscience/observer";
import type { RuntimeObservationPort } from "../src/bridge/openscience/role-runtime";

const sessionID = "ses_observer_fixture",
  runID = "run_observer_fixture";
const event = (sequence: number, type = "message.part.delta", run = runID) => ({
  sessionID,
  runID: run,
  sequence,
  time: 1,
  type,
  properties:
    type === "runtime.completed"
      ? { messageID: "msg_fixture" }
      : type === "runtime.failed"
        ? { message: "fixture failure" }
        : type === "runtime.cancelled"
          ? { source: "user" }
          : {
              sessionID,
              messageID: "msg_fixture",
              partID: "part_fixture",
              field: "text",
              delta: "fixture",
            },
});
function snapshot(terminal = false, run = runID): ObservationSnapshot {
  return {
    sessionID,
    oldestSequence: 1,
    latestSequence: 9,
    decisionScope: "connected_runtime",
    permissions: [],
    questions: [],
    runs: [
      {
        runID: run,
        sessionID,
        messageID: "msg_fixture",
        state: terminal ? "completed" : "running",
        acceptedAt: 1,
        updatedAt: 2,
      },
    ],
  };
}
function fixture() {
  const calls: string[] = [],
    controller = new AbortController();
  let committed = 0;
  const sink: ObservationSink = {
    cursor: vi.fn(async () => {
      calls.push("cursor:" + committed);
      return committed;
    }),
    ingest: vi.fn(async (raw) => {
      const e = raw as ReturnType<typeof event>;
      calls.push("ingest:" + e.sequence);
      committed = e.sequence;
    }),
    gap: vi.fn(async (latest) => {
      calls.push("gap:" + latest);
      committed = latest;
    }),
    failed: vi.fn(async (code) => {
      calls.push("failed:" + code);
    }),
    synchronize: vi.fn(async () => {
      calls.push("synchronize");
    }),
  };
  const reader = {
    snapshot: vi.fn(async () => {
      calls.push("snapshot");
      return { ...snapshot(), latestSequence: committed };
    }),
    replay: vi.fn(async (_session: string, cursor: number) => {
      calls.push("replay:" + cursor);
      return {
        events: [event(cursor + 1)],
        oldestSequence: 1,
        latestSequence: cursor + 1,
      };
    }),
    subscribe: vi.fn(async function* (
      _session: string,
      cursor: number,
      _signal: AbortSignal,
    ) {
      calls.push("subscribe:" + cursor);
      yield event(cursor + 1, "runtime.completed");
    }),
    messages: vi.fn(),
    getRun: vi.fn(),
    capabilities: vi.fn(),
  } satisfies RuntimeObservationPort;
  const run = () =>
    observeRuntime({
      reader,
      sink,
      sessionID,
      runID,
      signal: controller.signal,
    });
  return {
    calls,
    controller,
    reader,
    sink,
    run,
    currentCursor: () => committed,
  };
}
afterEach(() => {
  vi.useRealTimers();
});
it("snapshots before replay and subscribes from the successfully committed cursor", async () => {
  const f = fixture();
  await f.run();
  expect(f.calls).toEqual([
    "snapshot",
    "cursor:0",
    "replay:0",
    "ingest:1",
    "snapshot",
    "cursor:1",
    "synchronize",
    "subscribe:1",
    "ingest:2",
  ]);
  expect(f.sink.ingest).toHaveBeenCalledWith(
    event(1),
    expect.objectContaining({ sessionID }),
  );
  expect(f.sink.failed).not.toHaveBeenCalled();
});
it("awaits each ingest transaction before advancing or opening subscription", async () => {
  const f = fixture();
  let release!: () => void;
  vi.mocked(f.sink.ingest).mockImplementationOnce(async (raw) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    f.calls.push("commit:" + (raw as { sequence: number }).sequence);
  });
  const running = f.run();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(f.reader.subscribe).not.toHaveBeenCalled();
  expect(f.sink.synchronize).not.toHaveBeenCalled();
  release();
  await running;
  expect(f.calls.indexOf("commit:1")).toBeLessThan(
    f.calls.findIndex((c) => c.startsWith("subscribe:")),
  );
});
it.each(["runtime.completed", "runtime.failed", "runtime.cancelled"])(
  "stops after committing replay terminal %s",
  async (type) => {
    const f = fixture();
    f.reader.replay.mockResolvedValue({
      events: [event(1, type), event(2)],
      oldestSequence: 1,
      latestSequence: 2,
    });
    await f.run();
    expect(f.sink.ingest).toHaveBeenCalledTimes(1);
    expect(f.reader.subscribe).not.toHaveBeenCalled();
  },
);
it("does not mistake another run terminal for this run ending", async () => {
  const f = fixture();
  f.reader.replay.mockResolvedValue({
    events: [event(1, "runtime.completed", "other_run")],
    oldestSequence: 1,
    latestSequence: 1,
  });
  await f.run();
  expect(f.reader.subscribe).toHaveBeenCalledTimes(1);
  expect(f.sink.ingest).toHaveBeenCalledTimes(2);
});
it("does not stop on malformed terminal properties that mapping rejects", async () => {
  const f = fixture();
  f.reader.replay.mockResolvedValue({
    events: [{ ...event(1, "runtime.completed"), properties: {} }],
    oldestSequence: 1,
    latestSequence: 1,
  });
  await f.run();
  expect(f.reader.subscribe).toHaveBeenCalledTimes(1);
});
it("synchronizes matching snapshot terminal without manufacturing an event sequence", async () => {
  const f = fixture();
  vi.mocked(f.sink.cursor).mockResolvedValue(9);
  f.reader.snapshot.mockResolvedValue(snapshot(true));
  f.reader.replay.mockResolvedValue({
    events: [],
    oldestSequence: 1,
    latestSequence: 9,
  });
  await f.run();
  expect(f.sink.synchronize).toHaveBeenCalledWith(snapshot(true));
  expect(f.sink.ingest).not.toHaveBeenCalled();
  expect(f.reader.subscribe).not.toHaveBeenCalled();
});
it("another run terminal snapshot does not terminate this observer", async () => {
  const f = fixture();
  f.reader.snapshot.mockResolvedValue(snapshot(true, "other_run"));
  await f.run();
  expect(f.reader.subscribe).toHaveBeenCalledTimes(1);
});
it("EOF reconnects at most three times with 500/1000ms backoff and committed replay", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.reader.subscribe.mockImplementation(async function* (_s, cursor) {
    f.calls.push("eof:" + cursor);
  });
  const running = f.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.reader.snapshot).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(499);
  expect(f.reader.snapshot).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.reader.snapshot).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(999);
  expect(f.reader.snapshot).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(f.reader.snapshot).toHaveBeenCalledTimes(6);
  expect(f.reader.replay.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
  expect(f.sink.failed).toHaveBeenCalledExactlyOnceWith("OS_STREAM_CLOSED");
});
it.each(["replay", "subscribe"] as const)(
  "expired %s uses new snapshot and transactional gap cursor before retry",
  async (stage) => {
    vi.useFakeTimers();
    const f = fixture();
    f.reader.snapshot.mockImplementation(async () => ({
      ...snapshot(),
      latestSequence: Math.max(9, f.currentCursor()),
    }));
    const expired = Object.assign(
      new Error("fixture raw text must not persist"),
      { code: "CURSOR_EXPIRED" },
    );
    if (stage === "replay") f.reader.replay.mockRejectedValueOnce(expired);
    else
      f.reader.subscribe.mockImplementationOnce(async function* () {
        throw expired;
      });
    const running = f.run();
    await vi.runAllTimersAsync();
    await running;
    expect(f.sink.gap).toHaveBeenCalledExactlyOnceWith(9, "CURSOR_EXPIRED");
    expect(f.reader.snapshot).toHaveBeenCalledTimes(stage === "replay" ? 4 : 5);
    expect(f.reader.replay.mock.calls.at(-1)?.[1]).toBe(9);
    expect(f.sink.failed).not.toHaveBeenCalled();
    expect(f.calls.indexOf("gap:9")).toBeGreaterThan(
      f.calls.indexOf("snapshot"),
    );
  },
);
it.each(["replay", "subscribe"] as const)(
  "cursor ahead from %s stops without gap or cursor rollback",
  async (stage) => {
    const f = fixture(),
      error = Object.assign(new Error("fixture"), { code: "CURSOR_AHEAD" });
    if (stage === "replay") f.reader.replay.mockRejectedValueOnce(error);
    else
      f.reader.subscribe.mockImplementationOnce(async function* () {
        throw error;
      });
    await f.run();
    expect(f.sink.failed).toHaveBeenCalledExactlyOnceWith("CURSOR_AHEAD");
    expect(f.sink.gap).not.toHaveBeenCalled();
    expect(f.reader.snapshot).toHaveBeenCalledTimes(stage === "replay" ? 1 : 2);
  },
);
it("ordinary reader exceptions retry with stable code and never expose error text", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.reader.snapshot.mockRejectedValue(new Error("fixture_sensitive_message"));
  const running = f.run();
  await vi.runAllTimersAsync();
  await running;
  expect(f.reader.snapshot).toHaveBeenCalledTimes(3);
  expect(f.sink.failed).toHaveBeenCalledExactlyOnceWith("OS_UNAVAILABLE");
});
it("sink transaction failure stops without replaying or treating it as a reader retry", async () => {
  const f = fixture();
  vi.mocked(f.sink.ingest).mockRejectedValue(
    new Error("fixture persistence failure"),
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "OBSERVATION_SINK_FAILED",
  });
  expect(f.reader.snapshot).toHaveBeenCalledTimes(1);
  expect(f.reader.subscribe).not.toHaveBeenCalled();
});
it("already aborted observer does no work", async () => {
  const f = fixture();
  f.controller.abort();
  await f.run();
  expect(f.reader.snapshot).not.toHaveBeenCalled();
  expect(f.sink.failed).not.toHaveBeenCalled();
});
it("aborting backoff ends promptly without recording a service fault", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.reader.snapshot.mockRejectedValue(new Error("fixture disconnect"));
  const running = f.run();
  await vi.advanceTimersByTimeAsync(0);
  f.controller.abort();
  await running;
  expect(f.reader.snapshot).toHaveBeenCalledTimes(1);
  expect(f.sink.failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["replay", "subscribe"] as const)(
  "refreshes pending snapshot immediately before every %s asked event",
  async (stage) => {
    const f = fixture(),
      fresh = { ...snapshot(), latestSequence: 20 };
    f.reader.snapshot
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValue(fresh);
    const asked = event(1, "permission.asked");
    if (stage === "replay")
      f.reader.replay.mockResolvedValue({
        events: [asked],
        oldestSequence: 1,
        latestSequence: 1,
      });
    else
      f.reader.subscribe.mockImplementationOnce(async function* () {
        yield asked;
        yield event(2, "runtime.completed");
      });
    await f.run();
    expect(f.reader.snapshot).toHaveBeenCalledTimes(3);
    expect(f.sink.ingest).toHaveBeenCalledWith(asked, fresh);
    // The observer confirms pending state; there is no decision/approval write port.
    expect(f.sink.failed).not.toHaveBeenCalled();
  },
);
it("question asked also refreshes pending snapshot and replay synchronization uses the fresh value", async () => {
  const f = fixture(),
    fresh = { ...snapshot(), latestSequence: 1 };
  f.reader.snapshot.mockResolvedValueOnce(snapshot()).mockResolvedValue(fresh);
  const asked = event(1, "question.asked");
  f.reader.replay.mockResolvedValue({
    events: [asked],
    oldestSequence: 1,
    latestSequence: 1,
  });
  await f.run();
  expect(f.sink.ingest).toHaveBeenCalledWith(asked, fresh);
  expect(f.sink.synchronize).toHaveBeenCalledWith(fresh);
});
it("does not roll a committed cursor backwards even if a gap recovery snapshot is older", async () => {
  const f = fixture();
  vi.mocked(f.sink.cursor).mockResolvedValue(20);
  f.reader.replay.mockRejectedValue(
    Object.assign(new Error("fixture"), { code: "CURSOR_EXPIRED" }),
  );
  await f.run();
  expect(f.sink.gap).not.toHaveBeenCalled();
  expect(f.sink.failed).toHaveBeenCalledExactlyOnceWith("CURSOR_AHEAD");
});
it("snapshot terminal for the same run ID but another session does not terminate observation", async () => {
  const f = fixture(),
    current = snapshot(true);
  current.runs[0].sessionID = "foreign_session";
  f.reader.snapshot.mockResolvedValue(current);
  await f.run();
  expect(f.reader.subscribe).toHaveBeenCalledTimes(1);
});
it("wrong session snapshot is a stable failure without ingestion or retry", async () => {
  const f = fixture();
  f.reader.snapshot.mockResolvedValue({
    ...snapshot(),
    sessionID: "foreign_session",
  });
  await f.run();
  expect(f.sink.failed).toHaveBeenCalledExactlyOnceWith(
    "OS_OBSERVATION_INVALID",
  );
  expect(f.reader.replay).not.toHaveBeenCalled();
});
it("aborting after a completed ingest prevents further replay and subscription work", async () => {
  const f = fixture();
  f.reader.replay.mockResolvedValue({
    events: [event(1), event(2)],
    oldestSequence: 1,
    latestSequence: 2,
  });
  vi.mocked(f.sink.ingest).mockImplementationOnce(async () => {
    f.controller.abort();
  });
  await f.run();
  expect(f.sink.ingest).toHaveBeenCalledTimes(1);
  expect(f.reader.subscribe).not.toHaveBeenCalled();
  expect(f.sink.failed).not.toHaveBeenCalled();
});
it.each(["CURSOR_GAP", "CURSOR_EXPIRED"] as const)(
  "trusted ingestion %s recovers only through fresh snapshot and durable gap",
  async (code) => {
    vi.useFakeTimers();
    const f = fixture();
    f.reader.snapshot.mockImplementation(async () => ({
      ...snapshot(),
      latestSequence: Math.max(9, f.currentCursor()),
    }));
    vi.mocked(f.sink.ingest).mockRejectedValueOnce(
      Object.assign(new Error("fixture trusted cursor gap"), { code }),
    );
    const running = f.run();
    await vi.runAllTimersAsync();
    await running;
    expect(f.sink.gap).toHaveBeenCalledExactlyOnceWith(9, code);
    expect(f.reader.replay.mock.calls.map((c) => c[1])).toEqual([0, 9]);
    expect(f.sink.failed).not.toHaveBeenCalled();
  },
);
