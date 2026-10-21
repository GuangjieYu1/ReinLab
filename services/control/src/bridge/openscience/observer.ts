import type { RuntimeObservationPort } from "./role-runtime";
import { mapRuntimeEvent } from "./mapping";

export type ObservationSnapshot = Awaited<
  ReturnType<RuntimeObservationPort["snapshot"]>
>;
export interface ObservationSink {
  cursor(): Promise<number>;
  ingest(raw: unknown, pendingSnapshot?: ObservationSnapshot): Promise<void>;
  gap(latest: number, reason: "CURSOR_EXPIRED" | "CURSOR_GAP"): Promise<void>;
  failed(code: string): Promise<void>;
  synchronize(snapshot: ObservationSnapshot): Promise<void>;
}
export interface RuntimeObservationOptions {
  reader: RuntimeObservationPort;
  sessionID: string;
  runID: string;
  signal: AbortSignal;
  sink: ObservationSink;
}
class SinkFailure extends Error {
  readonly code = "OBSERVATION_SINK_FAILED";
  constructor() {
    super("观察结果未能持久化，需要按已提交游标恢复。");
  }
}
const failure = (code: string) =>
  Object.assign(new Error("执行观察暂时不可用。"), { code });
function stableCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return typeof code === "string" &&
    [
      "CURSOR_EXPIRED",
      "CURSOR_GAP",
      "CURSOR_AHEAD",
      "OS_STREAM_CLOSED",
      "OS_NOT_FOUND",
      "SCOPE_DENIED",
      "OS_OBSERVATION_INVALID",
    ].includes(code)
    ? code
    : "OS_UNAVAILABLE";
}
async function persist<T>(
  work: () => Promise<T>,
  allowGap = false,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = stableCode(error);
    if (allowGap && (code === "CURSOR_GAP" || code === "CURSOR_EXPIRED"))
      throw failure(code);
    throw new SinkFailure();
  }
}
function backoff(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}
const terminalStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
/** A read-port consumer only. All durable cursor changes belong to the sink transaction. */
export async function observeRuntime({
  reader,
  sessionID,
  runID,
  signal,
  sink,
}: RuntimeObservationOptions): Promise<void> {
  const snapshot = async () => {
    const current = await reader.snapshot(sessionID);
    if (
      !current ||
      current.sessionID !== sessionID ||
      !Array.isArray(current.runs) ||
      !Number.isSafeInteger(current.latestSequence) ||
      current.latestSequence < 0
    )
      throw failure("OS_OBSERVATION_INVALID");
    return current;
  };
  const cursor = async () => {
    const committed = await persist(() => sink.cursor());
    if (!Number.isSafeInteger(committed) || committed < 0)
      throw new SinkFailure();
    return committed;
  };
  const snapshotTerminal = (current: ObservationSnapshot) =>
    current.runs.some(
      (run) =>
        run &&
        run.sessionID === sessionID &&
        run.runID === runID &&
        terminalStates.has(run.state),
    );
  const pendingSnapshot = async (
    raw: unknown,
    current: ObservationSnapshot,
  ) => {
    const type =
      raw && typeof raw === "object" && "type" in raw ? raw.type : undefined;
    return type === "permission.asked" || type === "question.asked"
      ? snapshot()
      : current;
  };
  const ingest = async (raw: unknown, current: ObservationSnapshot) => {
    await persist(() => sink.ingest(raw, current), true);
    if (
      !raw ||
      typeof raw !== "object" ||
      !("sessionID" in raw) ||
      raw.sessionID !== sessionID ||
      !("runID" in raw) ||
      raw.runID !== runID
    )
      return false;
    const state = mapRuntimeEvent(raw, { toolGrants: {} }).runState;
    return state !== undefined && terminalStates.has(state);
  };
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    try {
      let current = await snapshot();
      if (signal.aborted) return;
      const committed = await cursor();
      if (signal.aborted) return;
      const replay = await reader.replay(sessionID, committed);
      if (signal.aborted) return;
      if (!replay || !Array.isArray(replay.events))
        throw failure("OS_OBSERVATION_INVALID");
      for (const raw of replay.events) {
        if (signal.aborted) return;
        current = await pendingSnapshot(raw, current);
        if (signal.aborted) return;
        if (await ingest(raw, current)) return;
      }
      if (signal.aborted) return;
      // Replay may outpace the first snapshot. Only a fresh, cursor-aligned
      // snapshot can reconcile state; newer history must be consumed as events.
      current = await snapshot();
      if (signal.aborted) return;
      const after = await cursor();
      if (signal.aborted) return;
      if (current.latestSequence < after) throw failure("CURSOR_AHEAD");
      if (current.latestSequence === after) {
        await persist(() => sink.synchronize(current));
        if (signal.aborted || snapshotTerminal(current)) return;
      }
      for await (const raw of reader.subscribe(sessionID, after, signal)) {
        if (signal.aborted) return;
        current = await pendingSnapshot(raw, current);
        if (signal.aborted) return;
        if (await ingest(raw, current)) return;
      }
      if (signal.aborted) return;
      throw failure("OS_STREAM_CLOSED");
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof SinkFailure) throw error;
      let code = stableCode(error);
      if (code === "CURSOR_AHEAD" || code === "OS_OBSERVATION_INVALID") {
        await persist(() => sink.failed(code));
        return;
      }
      if (code === "CURSOR_EXPIRED" || code === "CURSOR_GAP") {
        const reason = code;
        try {
          const latest = await snapshot();
          if (signal.aborted) return;
          const committed = await cursor();
          if (signal.aborted) return;
          if (latest.latestSequence < committed) {
            await persist(() => sink.failed("CURSOR_AHEAD"));
            return;
          }
          await persist(() => sink.gap(latest.latestSequence, reason));
          if (signal.aborted) return;
          await persist(() => sink.synchronize(latest));
          if (signal.aborted || snapshotTerminal(latest)) return;
        } catch (recoveryError) {
          if (signal.aborted) return;
          if (recoveryError instanceof SinkFailure) throw recoveryError;
          code = stableCode(recoveryError);
          if (code === "CURSOR_AHEAD" || code === "OS_OBSERVATION_INVALID") {
            await persist(() => sink.failed(code));
            return;
          }
        }
      }
      if (attempt === 2) {
        await persist(() => sink.failed(code));
        return;
      }
      await backoff(attempt === 0 ? 500 : 1000, signal);
    }
  }
}
