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
  private readonly sessions = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly dependencies: KernelDependencies) {
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Start (or resume) the dossier's kernel session for this run. */
  async submit(
    account: string,
    runId: string,
    options: { newSession?: boolean; prompt?: string } = {},
  ): Promise<{ runId: string; sessionId: string; resume: boolean }> {
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
        options.prompt ??
        (typeof input.query === "string" && input.query.trim() !== ""
          ? input.query
          : "请开始这段精读。");
      const existing = options.newSession
        ? undefined
        : (
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
      const chosenPaper =
        typeof input.chosenPaperId === "string" && input.chosenPaperId !== "";
      return { dossierId, sessionId, message, resume: Boolean(existing), mode: chosenPaper ? "read" : "clarify" };
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
      mode: prepared.mode as "clarify" | "read",
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
    try {
      await materializeLaunch(plan, token, layout.io);
    } catch (error) {
      await this.failBeforeRun(account, prepared.dossierId, prepared.sessionId, runId);
      throw error;
    }

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
        onSession: async (sessionId, resumed) => {
          if (resumed && sessionId === prepared.sessionId) return;
          await db.withAccount(account, async (client) => {
            await ensureSession(client, {
              account,
              dossier: prepared.dossierId,
              sessionId,
              homePath: layout.home + "/dsh-home",
            });
            await leaseSession(client, {
              account,
              dossier: prepared.dossierId,
              sessionId,
              run: runId,
            });
            await confirmRelease(client, {
              account,
              dossier: prepared.dossierId,
              sessionId: prepared.sessionId,
              run: runId,
            });
          });
          prepared.sessionId = sessionId;
        },
        onState: async (state, detail) => {
          await db.withAccount(account, async (client) => {
            await client.query(
              "update dsh_turn set state=$2, error_code=$3, ended_at=now() where run_id=$1 and state='running'",
              [runId, state, detail ?? null],
            );
            // 这一轮结束了，但还有等用户处理的请求时任务没结束：记成 waiting，
            // 把执行段让出去，等人回答后再按同一会话续上。
            const pending = Number(
              (
                await client.query(
                  "select count(*)::int n from approval where account_id=$1 and run_id=$2 and state='pending'",
                  [account, runId],
                )
              ).rows[0]?.n ?? 0,
            );
            const next = state === "completed" && pending > 0 ? "waiting" : state;
            await client.query(
              `update run set state=$2,
                 ended_at = case when $2 in ('completed','failed','cancelled','interrupted') then now() else null end
               where id=$1 and state not in ('completed','failed','cancelled','interrupted')`,
              [runId, next],
            );
            await this.release(client, account, prepared.dossierId, prepared.sessionId, runId, next);
          });
        },
        // 这一轮的产品承诺没兑现时，后端再提醒一次；补不回来就照实结束。
        followUp:
          prepared.mode === "read"
            ? {
                code: "KERNEL_LAYERS_SHORT",
                detail: async () =>
                  "layers=" +
                  (await KernelService.countEvents(this.dependencies.db, account, runId, "card_created", "payload->>'cardType'='layer'")),
                reminder: async () => {
                  const have = await KernelService.countEvents(this.dependencies.db, account, runId, "card_created", "payload->>'cardType'='layer'");
                  if (have >= 5) return null;
                  return `讲解卡现在只有 ${have} 层，还没到 5 层。请只补写讲解：用 card_layer 继续写第 ${have + 1} 到第 5 层（参数是 card 对象，含 no/title/en/body[{text,refs}]），写完就停，不要重复已写的层，不要再检索，也不要总结。`;
                },
              }
            : {
                code: "KERNEL_PICK_MISSING",
                detail: async () =>
                  "searches=" +
                  (await KernelService.countEvents(this.dependencies.db, account, runId, "tool/call", "payload->>'name'='papers_search'")),
                reminder: async () => {
                  // 候选必须由用户点选：检索过却还没把候选交给用户时，补一次。
                  const cards = await KernelService.countEvents(
                    this.dependencies.db,
                    account,
                    runId,
                    "tool/call",
                    "payload->>'name'='clarify_question' and payload->>'arguments' like '%candidates%'",
                  );
                  if (cards > 0) return null;
                  const searches = await KernelService.countEvents(
                    this.dependencies.db,
                    account,
                    runId,
                    "tool/call",
                    "payload->>'name'='papers_search'",
                  );
                  if (searches === 0) return null;
                  return "这一轮检索到了候选，但用户还没看到可选列表。请调用 clarify_question，带 kind=paper_pick 和 candidates（用检索到的真实候选），让用户自己选。";
                },
              },
        release: plan.release,
      },
      { plan, prompt: prepared.message, resume: prepared.resume, token },
    );
    this.handles.set(runId, handle);
    void handle.done.catch(() => {}).finally(() => this.handles.delete(runId));
    return { runId, sessionId: prepared.sessionId, resume: prepared.resume };
  }

  /**
   * 用户回答/批准之后接着跑同一段任务：把回答作为这一轮的输入送进原会话，
   * 不新建空会话，也不伪造上一个工具调用的结果。
   */
  async resumeAfterAnswer(
    account: string,
    runId: string,
    prompt: string,
  ): Promise<{ started: boolean }> {
    try {
      await this.submit(account, runId, { prompt });
      return { started: true };
    } catch (error) {
      // 会话还被占着或这一段已经收尾：如实留给用户，不静默假装续上。
      const code = (error as { code?: string })?.code ?? "RESUME_FAILED";
      console.error(JSON.stringify({ code: "KERNEL_RESUME_FAILED", run: runId, detail: code }));
      return { started: false };
    }
  }

  /** 这一段执行此刻是否还挂在本进程里（残留判定用）。 */
  isLive(runId: string): boolean {
    return this.handles.has(runId);
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

  /** Count this run's events matching one action (and an optional predicate). */
  private static async countEvents(
    db: Database,
    account: string,
    run: string,
    action: string,
    predicate: string,
  ): Promise<number> {
    return Number(
      (
        await db.withAccount(account, (client) =>
          client.query(
            `select count(*)::int n from event where run_id=$1 and action=$2 and (${predicate})`,
            [run, action],
          ),
        )
      ).rows[0]?.n ?? 0,
    );
  }

  /** A launch failure must not leave the session leased or the run "running". */
  private async failBeforeRun(
    account: string,
    dossier: string,
    sessionId: string,
    runId: string,
  ) {
    await this.dependencies.db
      .withAccount(account, async (client) => {
        await client.query(
          "update dsh_turn set state='failed', ended_at=now() where run_id=$1 and state='running'",
          [runId],
        );
        await client.query(
          "update run set state='failed', ended_at=now() where id=$1 and state in ('queued','running')",
          [runId],
        );
        await confirmRelease(client, { account, dossier, sessionId, run: runId });
      })
      .catch(() => {});
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
    // `host.docker.internal` only resolves inside the account container; a host
    // kernel reaches the control plane on loopback.
    return this.dependencies.layout.shimMode === "host"
      ? url.replace(/host\.docker\.internal/g, "127.0.0.1")
      : url;
  }
}
