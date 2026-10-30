import { randomUUID } from "node:crypto";
import { ApiFailure } from "../api/errors";
import { ensureAccountContainer } from "./container-lifecycle";
import { splitInjected, withDossierContext } from "../dossier/deliver";
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
  /** 容器模式下的账户执行环境；宿主模式为空。 */
  container?: {
    image: string;
    /** 容器内账户根。 */
    home: string;
    /** 容器内 DSH 会话目录。 */
    dshHome: string;
    /** 容器内档案工作区根。 */
    workspace: string;
    /** 容器内 dsh 可执行模块。 */
    dshModule: string;
    /** 容器内插件入口。 */
    pluginEntry: string;
    /** 容器内 restrict 补丁。 */
    restrictPatch: string;
  };
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
    options: { newSession?: boolean; prompt?: string; mode?: "assist" | "explore" } = {},
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
      // 只复用同一档的会话：精读和档案助手的工具配置不同，串用会让助手拿到
      // 精读的工具（模型改不了名，还以为自己在读论文）。
      // 三档会话的工具体不同，不能串用：精读 / 档案助手 / 探索规划。
      const wantedMode =
        options.mode === "assist" ? "assist" : options.mode === "explore" ? "explore" : "read";
      // 正式精读开始时，这份档案上还等着的澄清会话已经没有意义：一并收尾，
      // 免得它一直停在 waiting（用户看到的「研究台残留」就是这类）。
      if (wantedMode === "read")
        await client.query(
          `update run set state='cancelled', ended_at=coalesce(ended_at, now())
            where account_id=$1 and dossier_id=$2 and state='waiting' and id<>$3
              and mode='clarify'`,
          [account, dossierId, runId],
        );
      const existing = options.newSession
        ? undefined
        : (
            await client.query(
              `select session_id from dsh_session
                where account_id=$1 and dossier_id=$2 and mode=$3
                order by created_at desc limit 1`,
              [account, dossierId, wantedMode],
            )
          ).rows[0];
      const sessionId = existing?.session_id ?? "ds-" + randomUUID();
      await ensureSession(client, {
        account,
        dossier: dossierId,
        sessionId,
        mode: wantedMode,
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
      // 第 8 节：把这期间新增的档案操作事实随这一轮送进去（重启不会重复投递）。
      const prompt = await withDossierContext(client, {
        account,
        dossier: dossierId,
        sessionId,
        prompt: typeof options.prompt === "string" && options.prompt ? options.prompt : message,
      });
      return {
        dossierId,
        sessionId,
        message: prompt,
        resume: Boolean(existing),
        mode:
          options.mode === "assist"
            ? "assist"
            : options.mode === "explore"
              ? "explore"
              : chosenPaper
                ? "read"
                : "clarify",
      };
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
      mode: prepared.mode as "clarify" | "read" | "assist" | "explore",
      bundler: {
        shimModule: layout.shimModule,
        shimContainerModule: layout.shimContainerModule,
        dshModule: layout.dshModule,
        restrictPatch: layout.restrictPatch,
        pluginEntry: layout.pluginEntry,
      },
      ...(layout.shimMode === "docker" && layout.container
        ? {
            container: {
              home: layout.container.home,
              dshHome: layout.container.dshHome,
              workspace: layout.container.workspace,
              dshModule: layout.container.dshModule,
              pluginEntry: layout.container.pluginEntry,
              restrictPatch: layout.container.restrictPatch,
            },
          }
        : {}),
    });
    // shim 默认按宿主模式跑；容器模式必须显式告诉它，否则会在宿主上
    // 加载只有容器里才存在的内核路径。
    plan.options.env.SHIM_MODE = layout.shimMode;
    // 容器模式下 shim 要在宿主上执行 docker exec：把 daemon 地址一起给它，
    // 否则会去找默认 socket（本机 colima 不是那个路径）。
    if (layout.shimMode === "docker" && process.env.DOCKER_HOST)
      plan.options.env.DOCKER_HOST = process.env.DOCKER_HOST;
    const token = this.dependencies.auth.issue(
      { account, dossier: prepared.dossierId, run: runId },
      this.now(),
    );
    try {
      await materializeLaunch(plan, token, layout.io);
      // 容器模式：令牌与运行目录已落盘，再把这一账户的容器确保到运行状态，
      // 之后 shim 才能 docker exec 进去。容器只挂这个账户自己的两块目录。
      if (layout.shimMode === "docker" && layout.container) {
        // dsh 要在 HOME 下建 profile：先在账户卷里把它建好。
        await layout.io.mkdir(layout.home + "/accounts/" + account + "/home");
        await ensureAccountContainer({
          account,
          image: layout.container.image,
          accountRoot: layout.home + "/accounts/" + account,
          containerRoot: layout.container.home,
          dshHome: layout.home + "/dsh-home/accounts/" + account,
          containerDshHome: layout.container.dshHome,
          controlUrl: this.controlUrl(),
          tokenFile: plan.paths.tokenFile,
          // 账户卷是宿主进程建的：用宿主 uid 跑容器，容器里才写得进去。
          ...(process.getuid && process.getgid
            ? { user: process.getuid() + ":" + process.getgid() }
            : {}),
        });
      }
    } catch (error) {
      await this.failBeforeRun(account, prepared.dossierId, prepared.sessionId, runId);
      throw error;
    }

    const handle = executeRun(
      {
        factory: this.dependencies.factory,
        onEvent: async (event) => {
          // 「档案变动：…」是系统替这一轮加的上下文：记录和显示上单独成一条，
          // 不和用户自己说的话混在同一个气泡里。
          for (const payload of splitInjected(event))
            await db.withAccount(account, (client) =>
              client.query(
                `insert into event(account_id,dossier_id,run_id,role_id,kind,action,payload,dedupe_key)
                 values($1,$2,$3,'research-read','dsh',$4,$5,$6)`,
                [
                  account,
                  prepared.dossierId,
                  runId,
                  payload.type,
                  JSON.stringify(payload.data ?? {}),
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
            // 如果这张卡在轮次收尾前就已经被批准了（用户点得快），没人接着跑：
            // 这里补一次续接，批准过的事不会因为时序丢掉。
            if (next === "waiting") {
              const approved = (
                await client.query(
                  `select id from approval
                    where account_id=$1 and run_id=$2 and state='approved' and consumed_at is null
                    limit 1`,
                  [account, runId],
                )
              ).rows[0];
              if (approved)
                // 这一段还占着会话租约：等租约真正让出之后再续，别被 SESSION_BUSY 挡掉。
                setTimeout(() => {
                  void this.resumeAfterAnswer(account, runId, "继续").catch((error) =>
                    console.error(
                      JSON.stringify({
                        code: "KERNEL_RESUME_AFTER_APPROVAL_FAILED",
                        run: runId,
                        detail: String((error as Error)?.message ?? error).slice(0, 160),
                      }),
                    ),
                  );
                }, 1500);
            }
            // 任务结束了，它名下的待批卡也就没有意义：一并关掉并写明原因，
            // 免得收件箱里一直挂着点不动的旧卡。
            if (next !== "waiting") {
              const closed = await client.query(
                `update approval set state='expired'
                  where account_id=$1 and run_id=$2 and state='pending'
                  returning id`,
                [account, runId],
              );
              for (const row of closed.rows)
                await client.query(
                  `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
                   values($1::uuid,$2::uuid,$3::uuid,'approval','approval.expired',$4,$5)
                   on conflict do nothing`,
                  [
                    account,
                    prepared.dossierId,
                    runId,
                    JSON.stringify({ approvalId: row.id, reason: "run_ended" }),
                    "run-ended:" + row.id,
                  ],
                );
            }
            await this.release(client, account, prepared.dossierId, prepared.sessionId, runId, next);
          });
        },
        // 这一轮的产品承诺没兑现时，后端再提醒一次；补不回来就照实结束。
        // 不再往对话里注入「提醒」：那是系统替模型定步骤，还会以用户身份出现在
        // 页面上（纲领第 9 条）。结果照实记录在事件里，不伪装成人说的话。
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
