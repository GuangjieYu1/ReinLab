import type { RuntimeObservationPort } from "./role-runtime";
import type { ObservationSink } from "./observer";

export type ReconcileReader = Pick<
  RuntimeObservationPort,
  "snapshot" | "replay"
>;
const invalid = () =>
  Object.assign(Error("恢复观察返回无效快照或游标。"), {
    code: "OS_OBSERVATION_INVALID",
  });
/** Finite, read-only recovery. No SSE/prompt/decision/cancel exists on this port. */
export async function reconcileObservation({
  reader,
  sink,
  sessionID,
}: {
  reader: ReconcileReader;
  sink: ObservationSink;
  sessionID: string;
}): Promise<{
  cursor: number;
  highWater: number;
  caughtUp: boolean;
  historyGap?: true;
}> {
  const snapshot = async () => {
    const value = await reader.snapshot(sessionID);
    if (
      value.sessionID !== sessionID ||
      !Number.isSafeInteger(value.latestSequence) ||
      value.latestSequence < 0
    )
      throw invalid();
    return value;
  };
  const committed = async () => {
    const value = await sink.cursor();
    if (!Number.isSafeInteger(value) || value < 0) throw invalid();
    return value;
  };
  const first = await snapshot(),
    highWater = first.latestSequence;
  let cursor = await committed();
  if (cursor > highWater) throw invalid();
  if (cursor < highWater) {
    let replay: Awaited<ReturnType<ReconcileReader["replay"]>>;
    try {
      replay = await reader.replay(sessionID, cursor);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "CURSOR_EXPIRED" && code !== "CURSOR_GAP") throw error;
      const latest = await snapshot();
      if (latest.latestSequence < (await committed())) throw invalid();
      await sink.gap(latest.latestSequence, code);
      await sink.synchronize(latest);
      return {
        cursor: await committed(),
        highWater: latest.latestSequence,
        caughtUp: true,
        historyGap: true,
      };
    }
    if (!Array.isArray(replay.events)) throw invalid();
    const pending = await snapshot();
    if (pending.latestSequence < highWater) throw invalid();
    // Advance at most 1000 original events. The next cron resumes the durable cursor.
    for (const raw of replay.events.slice(0, 1000)) {
      const sequence = (raw as { sequence?: number })?.sequence;
      if (!Number.isSafeInteger(sequence) || sequence! < 1) throw invalid();
      if (sequence! > highWater) break;
      if (sequence! <= cursor) continue;
      await sink.ingest(raw, pending);
      cursor = await committed();
    }
  }
  cursor = await committed();
  if (cursor > highWater) {
    // A concurrent API observer may advance farther. Never rewind its cursor.
    return { cursor, highWater, caughtUp: true };
  }
  if (cursor === highWater) {
    const latest = await snapshot();
    if (latest.latestSequence < cursor) throw invalid();
    if (latest.latestSequence === cursor) await sink.synchronize(latest);
  }
  return { cursor, highWater, caughtUp: cursor === highWater };
}
