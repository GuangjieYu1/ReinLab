import { randomUUID } from "node:crypto";
import { ApiFailure } from "../api/errors";
import type { Database } from "../db/database";
import type { KernelAuth } from "./auth";
import { launchPlan, materializeLaunch, type LaunchIo } from "./dsh/launch";
import { executeRun, type RunHandle } from "./dsh/pipeline";
import type { HarnessFactory } from "./dsh/session";
import {
  confirmRelease,
  ensureSession,
  leaseSession,
  markReleaseUnconfirmed,
} from "../run/session";

export type KernelLayout = {
  /** Root of the per-account volume. */
  home: string;
  shimModule: string;
  shimContainerModule: string;
  dshModule: string;
  restrictPatch: string;
  pluginEntry: string;
  /** Container transport ("docker") or local ("host"). */
  shimMode: "docker" | "host";
  nodeModule?: string;
  io: LaunchIo;
};

export type KernelDependencies = {
  db: Database;
  auth: KernelAuth;
  layout: KernelLayout;
  factory: HarnessFactory;
  model: string;
  maxTokens: number;
  /** Control-plane base URL the run's kernel reaches for tools and the model. */
  controlUrl: string;
  now?: () => number;
};

const ACTIVE_SESSION_STATE = new Set(["queued", "running", "waiting"]);

/**
 * DB-backed run service: one kernel child per run, one writer per session.
 * It records business events and terminal state and never writes usage — the
 * model endpoint owns the single usage write.
 */
export class KernelService {
  private readonly handles = new Map<string, RunHandle>();
  private readonly now: () => number;

  constructor(private readonly dependencies: KernelDependencies) {
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Start (or resume) the dossier's kernel session for this run. */
  async submit(account: string, runId: string): Promise<{ runId: string; sessionId: string; resume: boolean }> {
    const { db, layout } = this.dependencies;
    const prepared = await db.withAccount(account, async (client) => {
      const run = (
        await client.query(
          "select id,dossier_id,state,input from run where id=$1 and account_id=$2",
          [runId, account],
        )
      ).rows[0];
      if (!run) throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
      if (!ACTIVE_SESSION_STATE.has(run.state))
        throw new ApiFailure("RUN_NOT_STARTABLE", 409, "该运行已结束，无法重新开始。");
      const dossierId = run.dossier_id as string;
      const input = (run.input ?? {}) as Record<string, unknown>;
      const message =
        typeof input.query === "string" && input.query.trim() !== ""
          ? input.query
          : "请开始这段精读。";
      const existing = (
        await client.query(
          "select session_id from dsh_session where account_id=$1 and dossier_id=$2 order by created_at desc limit 1",
          [account, dossierId],
        )
      ).rows[0];
      const sessionId = existing?.session_id ?? "ds-" + randomUUID();
      await ensureSession(client, {
        account,
        dossier: dossierId,
        sessionId,
        homePath: layout.home + "/dsh-home",
      });
      const leased = await leaseSession(client, { account, dossier: dossierId, sessionId, run: runId });
      if (!leased)
        throw new ApiFailure("SESSION_BUSY", 409, "这段会话还在被上一次运行占用，请稍后再试。");
      await client.query("update run set state='running' where id=$1 and account_id=$2", [runId, account]);
      await client.query(
        "insert into dsh_turn(account_id,dossier_id,run_id,session_id,state) values($1,$2,$3,$4,'running')",
        [account, dossierId, runId, sessionId],
      );
      return { dossierId, sessionId, message, resume: Boolean(existing) };
    });

    const plan = launchPlan({
      account,
      dossier: prepared.dossierId,
      run: runId,
      sessionId: prepared.sessionId,
      controlUrl: this.controlUrl(),
      model: this.dependencies.model,
      maxTokens: this.dependencies.maxTokens,
      home: layout.home,
      bundler: {
        shimModule: layout.shimModule,
        shimContainerModule: layout.shimContainerModule,
        dshModule: layout.dshModule,
        restrictPatch: layout.restrictPatch,
        pluginEntry: layout.pluginEntry,
      },
    });
    if (layout.shimMode === "host") plan.options.env.SHIM_MODE = "host";
    const token = this.dependencies.auth.issue(
      { account, dossier: prepared.dossierId, run: runId },
      this.now(),
    );
    await materializeLaunch(plan, token, layout.io);

    const handle = executeRun(
      {
        factory: this.dependencies.factory,
        onEvent: async (event) => {
          await db.withAccount(account, (client) =>
            client.query(
              `insert into event(account_id,dossier_id,run_id,role_id,kind,action,payload,dedupe_key)
               values($1,$2,$3,'research-read','dsh',$4,$5,$6)`,
              [
                account,
                prepared.dossierId,
                runId,
                event.type,
                JSON.stringify(event.data ?? {}),
                `dsh:${runId}:${randomUUID()}`,
              ],
            ),
          );
        },
        onState: async (state) => {
          await db.withAccount(account, async (client) => {
            await client.query(
              "update dsh_turn set state=$2, ended_at=now() where run_id=$1 and state='running'",
              [runId, state],
            );
            await client.query(
              "update run set state=$2, ended_at=now() where id=$1 and state not in ('completed','failed','cancelled','interrupted')",
              [runId, state],
            );
            await this.release(client, account, prepared.dossierId, prepared.sessionId, runId, state);
          });
        },
        release: plan.release,
      },
      { plan, prompt: prepared.message, resume: prepared.resume, token },
    );
    this.handles.set(runId, handle);
    void handle.done.catch(() => {}).finally(() => this.handles.delete(runId));
    return { runId, sessionId: prepared.sessionId, resume: prepared.resume };
  }

  /** Cancel one run; the session is released only when the stop is confirmed. */
  async cancel(account: string, runId: string): Promise<"cancelled" | "cancel_unconfirmed"> {
    const handle = this.handles.get(runId);
    if (!handle) {
      const state = await this.dependencies.db.withAccount(account, async (client) => {
        return (
          await client.query("select state from run where id=$1 and account_id=$2", [runId, account])
        ).rows[0]?.state as string | undefined;
      });
      if (!state) throw new ApiFailure("RUN_NOT_FOUND", 404, "运行不存在。");
      if (!ACTIVE_SESSION_STATE.has(state))
        throw new ApiFailure("RUN_NOT_CANCELLABLE", 409, "该运行已经结束。");
      throw new ApiFailure("RUN_NOT_ATTACHED", 409, "这次运行不在当前进程里，无法确认停止。");
    }
    return handle.cancel();
  }

  private async release(
    client: import("pg").PoolClient,
    account: string,
    dossier: string,
    sessionId: string,
    runId: string,
    state: string,
  ) {
    const key = { account, dossier, sessionId, run: runId };
    if (state === "cancelled") await confirmRelease(client, key);
    else if (state === "cancel_unconfirmed") await markReleaseUnconfirmed(client, key);
    else await confirmRelease(client, key);
  }

  private controlUrl(): string {
    const url = this.dependencies.controlUrl;
    if (typeof url !== "string" || url.trim() === "")
      throw new ApiFailure("KERNEL_CONTROL_URL_REQUIRED", 503, "控制面地址未配置。");
    return url;
  }
}
