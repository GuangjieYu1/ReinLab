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
  /** 群研这一档额外挂的研究工具插件。 */
  swarmPluginEntry?: string;
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
    /** 容器内群研插件入口。 */
    swarmPluginEntry?: string;
    /** 容器内 restrict 补丁。 */
    restrictPatch: string;
  };
  nodeModule?: string;
  io: LaunchIo;
};

/**
 * 群研的挂钩：内核只负责把「会话里又发生了什么」「这一轮结束了」告诉研究服务。
 * 用接口而不是直接依赖，免得 KernelService 和 SwarmService 互相构造。
 */
export type SwarmHooks = {
  /** 会话里新落了一条 DSH 事件：折算成研究事件（可以是空操作）。 */
  onRunEvent: (account: string, runId: string) => Promise<void>;
  /** 这一轮结束：结算计时，决定继续下一轮还是收尾。 */
  onTurnEnd: (
    account: string,
    runId: string,
    state: "completed" | "failed" | "cancelled" | "cancel_unconfirmed",
    detail?: string,
  ) => Promise<{ continued: boolean }>;
  /** 负责人的那一轮挂了：群研要转成「已暂停」并写清原因（B11）。 */
  onLeadTurnFailed: (
    account: string,
    runId: string,
    state: string,
    detail?: string,
  ) => Promise<void>;
  /** 这次群研还没结束吗？没结束的运行在轮次之间不能把 run 行置成终态。 */
  isActive: (account: string, runId: string) => Promise<boolean>;
  /**
   * 这一轮负责人最后说给用户的话。DSH 的 assistant/message 是增量流，
   * 拼不出原文；SDK 的 finalResponse 才是这一轮真正说出口的那段。
   */
  onTurnOutput: (account: string, runId: string, text: string) => Promise<void>;
};

export type KernelDependencies = {
  db: Database;
  /** 把这一轮的参考图读成可发送的图片块；没配就只发文字。 */
  /**
   * 带图开跑前的服务端读图：把这一轮附带的图写成计划的「想要的感觉」。
   * 失败不影响这一轮（读不出来就是没有感觉卡，照实空着）。
   */
  beforeRun?: (input: {
    account: string;
    dossier: string;
    runId: string;
    refIds: string[];
    images: { data: string; mimeType: string; label?: string }[];
  }) => Promise<string | null>;
  loadRefImages?: (input: {
    account: string;
    dossier: string;
    refIds: string[];
  }) => Promise<{ data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }[]>;
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
  /**
   * 一个运行名下活着的回合。真实验收里确认与「继续」并发，同一 run 上跑了两回合：
   * 后一条把前一条的 handle 覆盖掉，前一条结束又把它删掉，于是 cancel 找不到人，
   * 团队一直在后台花钱。现在按 run 收成集合，取消就是把这一 run 的回合全停掉。
   */
  private readonly handles = new Map<string, Set<RunHandle>>();
  /** 这一 run 名下活着的回合数：运行文件（令牌/补丁）要等最后一个回合结束才删。 */
  private readonly turnCounts = new Map<string, number>();
  /**
   * 正在起跑（已写 run 行、还没拿到 handle）的运行。
   * 收件箱的核对会把「不在 handles 里的 running」当成残留；起跑窗口只有几十毫秒，
   * 但页面恰好在那一刻刷收件箱就会把刚建好的运行标成中断（验收时真的发生过）。
   */
  private readonly starting = new Set<string>();
  private readonly sessions = new Map<string, string>();
  private readonly now: () => number;
  private swarm: SwarmHooks | undefined;

  constructor(private readonly dependencies: KernelDependencies) {
    this.now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** 群研服务装上来之后，群研运行的事件与轮次结束才有人接。 */
  attachSwarm(hooks: SwarmHooks) {
    this.swarm = hooks;
  }

  /** Start (or resume) the dossier's kernel session for this run. */
  async submit(
    account: string,
    runId: string,
    options: {
      newSession?: boolean;
      prompt?: string;
      mode?: "assist" | "explore" | "swarm";
    } = {},
  ): Promise<{ runId: string; sessionId: string; resume: boolean }> {
    const { db, layout } = this.dependencies;
    // 从这一刻起就算「活着」：run 行是在下面的事务里被标成 running 的，
    // 到 handles 里登记还要过 launch/materialize/容器几步。
    this.starting.add(runId);
    try {
      return await this.submitNow(account, runId, options);
    } finally {
      this.starting.delete(runId);
    }
  }

  private async submitNow(
    account: string,
    runId: string,
    options: {
      newSession?: boolean;
      prompt?: string;
      mode?: "assist" | "explore" | "swarm";
    } = {},
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
        options.mode === "assist"
          ? "assist"
          : options.mode === "explore"
            ? "explore"
            : options.mode === "swarm"
              ? "swarm"
              : "read";
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
        // 这一轮随消息带来的参考图：只在第一轮带（追补那轮不重复烧图）。
        refIds: Array.isArray(input.refIds)
          ? input.refIds.filter((id): id is string => typeof id === "string")
          : [],
        message: prompt,
        resume: Boolean(existing),
        mode:
          options.mode === "assist"
            ? "assist"
            : options.mode === "explore"
              ? "explore"
              : options.mode === "swarm"
                ? "swarm"
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
      mode: prepared.mode as "clarify" | "read" | "assist" | "explore" | "swarm",
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
              ...(layout.container.swarmPluginEntry
                ? { swarmPluginEntry: layout.container.swarmPluginEntry }
                : {}),
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
        // 这个账户还有别的任务在**真正执行**吗？有就别重建它的容器。
        // 只认 running：waiting 是停在卡片上等用户，不占容器；
        // 早先的实现把 waiting 也算忙，结果有历史遗留的 waiting 记录时容器永远不更新。
        const busy = await this.dependencies.db
          .withAccount(account, async (client) => {
            const rows = (
              await client.query(
                `select 1 from run
                  where account_id=$1 and id<>$2 and state='running' limit 1`,
                [account, runId],
              )
            ).rowCount;
            return (rows ?? 0) > 0;
          })
          .catch(() => false);
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
        }, { busy });
      }
    } catch (error) {
      await this.failBeforeRun(account, prepared.dossierId, prepared.sessionId, runId);
      throw error;
    }

    // 参考图在事务外读文件、编码，再随这一轮送进去。
    const images =
      prepared.refIds.length && this.dependencies.loadRefImages
        ? await this.dependencies.loadRefImages({
            account,
            dossier: prepared.dossierId,
            refIds: prepared.refIds,
          }).catch((error) => {
            console.error(
              JSON.stringify({
                code: "EXPLORE_REFS_UNREADABLE",
                detail: String((error as Error)?.message ?? error).slice(0, 160),
              }),
            );
            return [];
          })
        : [];

    // 带图开跑前：服务端自己读一次图，把结构化观察写成计划的「想要的感觉」。
    // 放在这里是为了不依赖模型「记得调 feel.set」；失败不影响这一轮。
    // 预读结果同时作为这一轮的上下文：不然服务端记的「柔光」和模型自己说的「硬光」
    // 会各说各的，用户看到两张嘴上打架的结论。
    const feelNote = images.length && this.dependencies.beforeRun
      ? await this.dependencies.beforeRun({
        account,
        dossier: prepared.dossierId,
        runId,
        refIds: prepared.refIds,
        images,
      }).catch((error) => {
        console.error(
          JSON.stringify({
            code: "EXPLORE_FEEL_UNAVAILABLE",
            detail: String((error as Error)?.message ?? error).slice(0, 160),
          }),
        );
        return null;
      })
      : null;

    const handle = executeRun(
      {
        factory: this.dependencies.factory,
        onEvent: async (event) => {
          // 「档案变动：…」是系统替这一轮加的上下文：记录和显示上单独成一条，
          // 不和用户自己说的话混在同一个气泡里。
          for (const payload of splitInjected(event))
            await db.withAccount(account, (client) =>
              client.query(
                `insert into event(account_id,dossier_id,run_id,role_id,kind,action,payload,dedupe_key,session_id)
                 values($1,$2,$3,'research-read','dsh',$4,$5,$6,$7)`,
                [
                  account,
                  prepared.dossierId,
                  runId,
                  payload.type,
                  JSON.stringify(payload.data ?? {}),
                  `dsh:${runId}:${randomUUID()}`,
                  event.sessionId ?? null,
                ],
              ),
            );
          // 群研：每落一条就折算成研究事件，页面才看得见名册和任务在变。
          if (prepared.mode === "swarm" && this.swarm)
            await this.swarm.onRunEvent(account, runId).catch(() => undefined);
        },
        onSession: async (sessionId, resumed) => {
          if (resumed && sessionId === prepared.sessionId) return;
          await db.withAccount(account, async (client) => {
            await ensureSession(client, {
              account,
              dossier: prepared.dossierId,
              sessionId,
              homePath: layout.home + "/dsh-home",
              mode: prepared.mode,
            });
            // 群研：第一次真正用上的负责人会话记下来，投影按它认人。
            if (prepared.mode === "swarm")
              await client.query(
                `update swarm_run set lead_session=coalesce(lead_session,$3), updated_at=now()
                  where account_id=$1 and run_id=$2`,
                [account, runId, sessionId],
              );
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
            // 群研一次运行跨很多轮：这一轮结束时如果研究还没结束，run 行要留在
            // 活动集合里（waiting），否则下一轮 submit 会被当成「已结束」拒掉。
            const swarmActive =
              prepared.mode === "swarm" && this.swarm
                ? await this.swarm.isActive(account, runId).catch(() => false)
                : false;
            const next = state === "completed" && (pending > 0 || swarmActive) ? "waiting" : state;
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
          // 群研这一轮结束了：结算计时、按额度决定继续还是收尾。
          // 会话租约刚刚让出，等它真正生效再续，不然会被 SESSION_BUSY 挡掉。
          if (prepared.mode === "swarm" && this.swarm) {
            // 负责人的运行挂了（B11/B12）：先把群研标成「已暂停」并写清原因，
            // 别让页面一直显示「运行中」。正常结束才走 onTurnEnd 的续跑判断。
            if (state !== "completed")
              void this.swarm
                .onLeadTurnFailed(account, runId, state, detail)
                .catch(() => undefined);
            setTimeout(() => {
              void this.swarm
                ?.onTurnEnd(account, runId, state, detail)
                .catch(() => undefined);
            }, 1200);
          }
        },
        // 这一轮的产品承诺没兑现时，后端再提醒一次；补不回来就照实结束。
        // 不再往对话里注入「提醒」：那是系统替模型定步骤，还会以用户身份出现在
        // 页面上（纲领第 9 条）。结果照实记录在事件里，不伪装成人说的话。
        //
        // 运行文件（令牌、补丁、凭据）是这一 run 共用的：还有回合在跑时删掉它，
        // 那边所有工具都会 ENOENT（验收里就报过 token 找不到）。
        release: async () => {
          if ((this.turnCounts.get(runId) ?? 0) > 1) return;
          await plan.release();
        },
      },
      {
        plan,
        prompt: feelNote ? `${feelNote}\n\n${prepared.message}` : prepared.message,
        resume: prepared.resume,
        token,
        ...(images.length ? { images } : {}),
      },
    );
    const live = this.handles.get(runId) ?? new Set<RunHandle>();
    live.add(handle);
    this.handles.set(runId, live);
    this.turnCounts.set(runId, (this.turnCounts.get(runId) ?? 0) + 1);
    void handle.done
      .then((outcome) => {
        const text = outcome.finalResponse?.trim();
        if (text && prepared.mode === "swarm" && this.swarm)
          return this.swarm.onTurnOutput(account, runId, text).catch(() => undefined);
        return undefined;
      })
      .catch(() => {})
      .finally(() => {
        // 只删自己这一条：别的回合还在跑就别动集合。
        const current = this.handles.get(runId);
        const remaining = Math.max(0, (this.turnCounts.get(runId) ?? 1) - 1);
        if (remaining === 0) this.turnCounts.delete(runId);
        else this.turnCounts.set(runId, remaining);
        if (!current) return;
        current.delete(handle);
        if (current.size === 0) this.handles.delete(runId);
      });
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
      // 续接要沿用这次运行原来的档位：不带 mode 会落到精读档，换了会话也换了工具
      // （探索规划批准后续接，助手拿到的是精读工具、看不到计划）。
      const mode = await this.dependencies.db.withAccount(account, async (client) =>
        (await client.query("select mode from run where id=$1 and account_id=$2", [runId, account])).rows[0]?.mode as string | undefined,
      );
      // 群研也要按原档位续接：不然回答完提问，负责人会拿到精读的工具和身份。
      await this.submit(account, runId, {
        prompt,
        ...(mode === "explore" || mode === "assist" || mode === "swarm"
          ? { mode }
          : {}),
      });
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
    if (this.starting.has(runId)) return true;
    return (this.handles.get(runId)?.size ?? 0) > 0;
  }

  /** 这一 run 名下还有几条活着的回合（群研据此判断能不能自动接下一轮）。 */
  liveTurns(runId: string): number {
    return this.handles.get(runId)?.size ?? 0;
  }

  /** Cancel one run; the session is released only when the stop is confirmed. */
  async cancel(account: string, runId: string): Promise<"cancelled" | "cancel_unconfirmed"> {
    const live = this.handles.get(runId);
    // 还挂在本进程里的回合优先：run 行可能已经被别的回合写成终态，但团队还在跑。
    if (live && live.size > 0) {
      let status: "cancelled" | "cancel_unconfirmed" = "cancelled";
      for (const handle of [...live]) {
        const result = await handle.cancel().catch(() => "cancel_unconfirmed" as const);
        if (result !== "cancelled") status = result;
      }
      return status;
    }
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
