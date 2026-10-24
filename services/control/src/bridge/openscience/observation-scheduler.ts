import type { Database } from "../../db/database";
import { denied } from "../../api/errors";
import { bindingRow } from "./binding-store";
import type { RoleRuntime, RuntimeObservationPort } from "./role-runtime";
import { observeRuntime, type ObservationSink } from "./observer";
import { reconcileObservation } from "./reconcile";

export interface ObservationTarget {
  accountId: string;
  runId: string;
  sessionID: string;
  runtimeRunID: string;
}
export interface ObservationAccess {
  binding(accountId: string, runId: string): Promise<ObservationTarget | null>;
  recoverable(accountId: string): Promise<readonly string[]>;
  reader(accountId: string, runId: string): Promise<RuntimeObservationPort>;
}
export type ObservationSinkFactory = (
  accountId: string,
  runId: string
) => ObservationSink;
export interface ObservationSchedulerOptions {
  maxConcurrent?: number;
  onFailure?: (code: string) => void;
}
/** Recovery queries are tenant scoped. This adapter never enumerates other accounts. */
export function createObservationAccess(
  db: Database,
  bridge: {
    runtime(
      accountId: string,
      runId: string
    ): Promise<Pick<RoleRuntime, "reader">>;
  }
): ObservationAccess {
  const binding = (accountId: string, runId: string) =>
    db.withAccount(accountId, async (client) => {
      const stored = await bindingRow(client, runId);
      const run = (
        await client.query("select state,ended_at from run where id=$1", [
          runId,
        ])
      ).rows[0];
      if (stored.accountId !== accountId || !run) throw denied();
      if (
        stored.phase !== "accepted" ||
        !stored.receipt ||
        !["running", "waiting", "paused_budget"].includes(run.state) ||
        run.ended_at !== null
      )
        return null;
      return {
        accountId,
        runId,
        sessionID: stored.sessionId,
        runtimeRunID: stored.receipt.runID,
      };
    });
  return Object.freeze({
    binding,
    recoverable: (accountId: string) =>
      db.withAccount(accountId, async (client) => {
        const rows = await client.query(
          `select b.run_id from os_binding b join run r on r.id=b.run_id and r.account_id=b.account_id
        where b.account_id=$1 and b.phase='accepted' and b.receipt is not null and r.state in ('running','waiting','paused_budget') and r.ended_at is null order by b.created_at,b.run_id`,
          [accountId]
        );
        return rows.rows.map((row) => row.run_id as string);
      }),
    reader: async (accountId: string, runId: string) => {
      if (!(await binding(accountId, runId))) throw denied();
      // Drop the mutation-capable runtime immediately; only the frozen reader escapes.
      return (await bridge.runtime(accountId, runId)).reader();
    },
  });
}
type Job = {
  key: string;
  accountId: string;
  runId: string;
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
};
/** In-process observation ownership only; global unattended recovery belongs to P1-13. */
export class ObservationScheduler {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private readonly maximum: number;
  private active = 0;
  private closed = false;
  constructor(
    private readonly access: ObservationAccess,
    private readonly sinkFactory: ObservationSinkFactory,
    private readonly options: ObservationSchedulerOptions = {}
  ) {
    this.maximum = options.maxConcurrent ?? 4;
    if (
      !Number.isInteger(this.maximum) ||
      this.maximum < 1 ||
      this.maximum > 32
    )
      throw new Error("INVALID_OBSERVATION_CONCURRENCY");
  }
  start(accountId: string, runId: string): boolean {
    const key = accountId + ":" + runId;
    if (this.closed || this.jobs.has(key)) return false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      key,
      accountId,
      runId,
      controller: new AbortController(),
      done,
      finish,
    };
    this.jobs.set(key, job);
    this.queue.push(job);
    this.drain();
    return true;
  }
  async recoverAccount(accountId: string): Promise<number> {
    if (this.closed) return 0;
    const runs = await this.access.recoverable(accountId);
    let started = 0;
    for (const run of runs) if (this.start(accountId, run)) started++;
    return started;
  }
  recoverable(accountId: string) {
    return this.access.recoverable(accountId);
  }
  async reconcileRun(accountId: string, runId: string) {
    if (this.closed) throw Error("RECOVERY_CLOSED");
    const target = await this.access.binding(accountId, runId);
    if (!target) return { skipped: true };
    if (target.accountId !== accountId || target.runId !== runId)
      throw denied();
    const reader = await this.access.reader(accountId, runId);
    return reconcileObservation({
      reader: { snapshot: reader.snapshot, replay: reader.replay },
      sink: this.sinkFactory(accountId, runId),
      sessionID: target.sessionID,
    });
  }
  private drain() {
    while (!this.closed && this.active < this.maximum && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void this.observe(job);
    }
  }
  private async observe(job: Job) {
    try {
      const target = await this.access.binding(job.accountId, job.runId);
      if (!target || job.controller.signal.aborted) return;
      if (
        target.accountId !== job.accountId ||
        target.runId !== job.runId ||
        !target.sessionID ||
        !target.runtimeRunID
      )
        throw denied();
      const reader = await this.access.reader(job.accountId, job.runId);
      if (job.controller.signal.aborted) return;
      const sink = this.sinkFactory(job.accountId, job.runId);
      await observeRuntime({
        reader,
        sessionID: target.sessionID,
        runID: target.runtimeRunID,
        signal: job.controller.signal,
        sink,
      });
    } catch {
      if (!job.controller.signal.aborted) {
        // No raw exception or kernel payload is logged or retried by the outer scheduler.
        try {
          if (this.options.onFailure)
            this.options.onFailure("OBSERVATION_SCHEDULER_FAILED");
          else
            console.error(
              JSON.stringify({ code: "OBSERVATION_SCHEDULER_FAILED" })
            );
        } catch {
          /* A logging callback cannot orphan ownership. */
        }
      }
    } finally {
      this.jobs.delete(job.key);
      this.active--;
      job.finish();
      this.drain();
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    const pending = [...this.jobs.values()];
    for (const job of pending) job.controller.abort();
    for (const job of this.queue.splice(0)) {
      this.jobs.delete(job.key);
      job.finish();
    }
    await Promise.all(pending.map((job) => job.done));
  }
}
