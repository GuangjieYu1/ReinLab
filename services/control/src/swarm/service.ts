import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  BusEntry,
  Claim,
  Evidence,
  Intervention,
  InterventionKind,
  MemberLogItem,
  Review,
  SwarmMember,
  SwarmPlan,
  SwarmReport,
  SwarmRun,
  SwarmRunState,
  SwarmSnapshot,
  SwarmTask,
  BoardPost,
  Cny,
} from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import type { Database } from "../db/database";
import type { KernelService } from "../kernel/service";
import { loadFold, projectEvents } from "./project";

/** 队员累计名额：完全沿用 DSH 的 maxMembers=16（负责人之外最多 16 个队员）。 */
export const MAX_MEMBERS = 16;
/** 额度下限（12-swarm.md §3）：最少 4 轮 / 30 分钟，只做下限，不强制耗满。 */
export const MIN_ROUNDS = 4;
export const MIN_MINUTES = 30;

/** 计时中（活动时长在走）的状态。 */
const TIMED = new Set<SwarmRunState>(["running", "near_limit", "finishing"]);
/** 已经结束的状态。 */
const TERMINAL = new Set<SwarmRunState>([
  "done",
  "partial",
  "unresolved",
  "cancelled",
  "failed",
]);

export type SwarmDeps = {
  db: Database;
  kernel: KernelService;
  /** 内核用的模型名：名册要显示真实模型，而不是页面猜的。 */
  model: string;
  /** 控制面进程的启动时刻：用来认出「这次运行是上一个进程留下的」。 */
  processStartedAt?: number;
};

/** 计划里路线最少要有的样子；负责人给的不合乎契约就拒绝，不替它编。 */
function readPlan(value: unknown): SwarmPlan {
  const plan = (value ?? {}) as Partial<SwarmPlan>;
  const routes = Array.isArray(plan.routes) ? plan.routes : [];
  const roster = Array.isArray(plan.roster) ? plan.roster : [];
  if (!plan.question || typeof plan.question !== "string") throw new ApiFailure("SWARM_PLAN_INVALID", 400, "计划缺少研究问题。");
  if (!routes.length) throw new ApiFailure("SWARM_PLAN_INVALID", 400, "计划里至少要有一条路线。");
  const rounds = Number(plan.limits?.rounds ?? MIN_ROUNDS);
  const minutes = Number(plan.limits?.minutes ?? MIN_MINUTES);
  return {
    version: 0,
    question: plan.question,
    scope: typeof plan.scope === "string" ? plan.scope : "",
    qualityCriteria: Array.isArray(plan.qualityCriteria) ? plan.qualityCriteria.map(String) : [],
    routes: routes.map((route, index) => ({
      id: String(route?.id ?? `r${index + 1}`),
      title: String(route?.title ?? `路线 ${index + 1}`),
      idea: String(route?.idea ?? ""),
      differsBy: String(route?.differsBy ?? ""),
    })),
    roster: roster.length
      ? roster.map((entry) => ({
          role: (entry?.role ?? "researcher") as SwarmMember["role"],
          count: Number(entry?.count ?? 1),
          model: String(entry?.model ?? ""),
          ...(Array.isArray(entry?.routeIds) ? { routeIds: entry.routeIds.map(String) } : {}),
        }))
      : defaultRoster(),
    limits: {
      rounds: Number.isSafeInteger(rounds) && rounds >= MIN_ROUNDS ? rounds : MIN_ROUNDS,
      minutes: Number.isSafeInteger(minutes) && minutes >= MIN_MINUTES ? minutes : MIN_MINUTES,
    },
    needsConfirm: true,
  };
}

export function defaultRoster(): SwarmPlan["roster"] {
  return [
    { role: "lead", count: 1, model: "" },
    { role: "researcher", count: 3, model: "" },
    { role: "critic", count: 1, model: "" },
    { role: "verifier", count: 1, model: "" },
  ];
}

type RunRow = {
  run_id: string;
  dossier_id: string;
  question: string;
  state: SwarmRunState;
  phase: "independent" | "cross";
  round: number;
  plan_version: number;
  limit_rounds: number;
  limit_minutes: number;
  active_ms: string | number;
  active_since: Date | null;
  members_used: number;
  projected_seq: string | number;
  state_reason: string | null;
  end_reason: SwarmRun["endReason"] | null;
  delegation: SwarmRun["delegation"] | null;
  started_at: Date | null;
  ended_at: Date | null;
};

/** 一条运行的研究投影：所有接口都从这里算，页面不自己推断。 */
export class SwarmService {
  /** 已经核对过「是不是上一个进程留下的」的运行，一次进程只核一次。 */
  private readonly recovered = new Set<string>();

  constructor(private readonly dependencies: SwarmDeps) {}

  // ── 运行 ──────────────────────────────────────────

  /**
   * 发起前的写入段：同档案已有没结束的群研就返回它，否则建 run 行 + swarm_run。
   * 放进调用方的事务里，和 Idempotency-Key 的回执一起提交。
   */
  async createRun(
    client: pg.PoolClient,
    account: string,
    dossierId: string,
    question: string,
  ): Promise<{ runId: string; existing: boolean }> {
    const row = (
      await client.query(
        `select run_id from swarm_run where account_id=$1 and dossier_id=$2
           and state not in ('done','partial','unresolved','cancelled','failed')
         order by created_at desc limit 1`,
        [account, dossierId],
      )
    ).rows[0];
    if (row) return { runId: String(row.run_id), existing: true };
    const runId = randomUUID();
    await client.query(
      `insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input)
       values($1,$2,$3,'bench-swarm','swarm',$4,'queued',1,$5)`,
      [runId, account, dossierId, randomUUID(), JSON.stringify({ query: question })],
    );
    await client.query(
      `insert into swarm_run(account_id,run_id,dossier_id,question,state)
       values($1,$2,$3,$4,'clarifying')`,
      [account, runId, dossierId, question],
    );
    await client.query(
      `insert into swarm_event(account_id,run_id,dossier_id,type,data,source)
       values($1,$2,$3,'run',$4,'control')`,
      [account, runId, dossierId, JSON.stringify(await this.runOf(client, account, runId))],
    );
    return { runId, existing: false };
  }

  /** 起负责人会话进入澄清；同一档案已有未结束的群研时返回它，不新开。 */
  async start(
    account: string,
    dossierId: string,
    question: string,
  ): Promise<{ runId: string; sessionId: string; resume: boolean }> {
    const created = await this.dependencies.db.withAccount(account, (client) =>
      this.createRun(client, account, dossierId, question),
    );
    return this.begin(account, created.runId, question, created.existing);
  }

  /** 真正把这一轮跑起来（建 run 行之后调用，或接着已有的运行）。 */
  async begin(
    account: string,
    runId: string,
    question: string,
    resume = false,
  ): Promise<{ runId: string; sessionId: string; resume: boolean }> {
    if (resume) {
      // 同一档案重复发起点开的还是同一个运行。澄清阶段用户又说了一句，
      // 就按同一段会话接着澄清；已经开跑的运行不再因为一次点开就多烧一轮。
      const state = await this.dependencies.db.withAccount(account, async (client) =>
        String(
          (
            await client.query(
              "select state from swarm_run where account_id=$1 and run_id=$2",
              [account, runId],
            )
          ).rows[0]?.state ?? "",
        ),
      );
      const sessionId = await this.dependencies.db.withAccount(account, async (client) =>
        String(
          (
            await client.query(
              `select s.session_id from dsh_session s
                 join swarm_run r on r.account_id=s.account_id and r.dossier_id=s.dossier_id
                where s.account_id=$1 and r.run_id=$2 and s.mode='swarm'
                order by s.created_at desc limit 1`,
              [account, runId],
            )
          ).rows[0]?.session_id ?? "",
        ),
      );
      if (state !== "clarifying") return { runId, sessionId, resume: true };
      const started = await this.dependencies.kernel.submit(account, runId, {
        mode: "swarm",
        prompt: question,
      });
      return { runId, sessionId: started.sessionId, resume: true };
    }
    const started = await this.dependencies.kernel.submit(account, runId, {
      mode: "swarm",
      prompt: clarificationPrompt(question),
    });
    return { runId, sessionId: started.sessionId, resume: started.resume };
  }

  private async row(client: pg.PoolClient, account: string, runId: string): Promise<RunRow> {
    const row = (
      await client.query(
        `select run_id,dossier_id,question,state,phase,round,plan_version,limit_rounds,limit_minutes,
                active_ms,active_since,members_used,projected_seq,state_reason,end_reason,delegation,
                started_at,ended_at
           from swarm_run where account_id=$1 and run_id=$2`,
        [account, runId],
      )
    ).rows[0];
    if (!row) throw new ApiFailure("RUN_NOT_FOUND", 404, "这次群研不存在。");
    return row as RunRow;
  }

  /** 计时：进入计时状态开始走，离开时结账；页面只显示服务端算好的累计。 */
  private accumulate(row: RunRow, now = new Date()): number {
    const base = Number(row.active_ms ?? 0);
    if (!row.active_since || !TIMED.has(row.state)) return base;
    return base + Math.max(0, now.getTime() - new Date(row.active_since).getTime());
  }

  private async usage(client: pg.PoolClient, runId: string): Promise<{
    cost: Cny;
    tokens: number | null;
  }> {
    const row = (
      await client.query(
        `select count(*)::int requests,
                count(*) filter (where not known)::int unknown_requests,
                sum(cost_cny)::text known_cny,
                sum(input_tokens)::bigint in_tokens,
                sum(output_tokens)::bigint out_tokens,
                count(*) filter (where input_tokens is null or output_tokens is null)::int unknown_tokens
           from usage_record where run_id=$1`,
        [runId],
      )
    ).rows[0];
    const requests = Number(row.requests);
    const unknown = Number(row.unknown_requests);
    const tokensUnknown = Number(row.unknown_tokens);
    // 用量未知就是未知：不把缺的当成 0 一起加起来（12-swarm.md §3）。
    const tokens =
      requests > 0 && tokensUnknown === 0
        ? Number(row.in_tokens ?? 0) + Number(row.out_tokens ?? 0)
        : null;
    const value = requests > 0 && unknown === 0 && row.known_cny !== null ? Number(row.known_cny) : null;
    return { cost: { value, known: value !== null }, tokens };
  }

  private async runOf(client: pg.PoolClient, account: string, runId: string): Promise<SwarmRun> {
    const row = await this.row(client, account, runId);
    const usage = await this.usage(client, runId);
    return {
      id: row.run_id,
      dossierId: row.dossier_id,
      question: row.question,
      state: row.state,
      phase: row.phase,
      round: row.round,
      planVersion: row.plan_version,
      limits: { rounds: row.limit_rounds, minutes: row.limit_minutes },
      used: {
        rounds: row.round,
        activeMs: this.accumulate(row),
        cost: usage.cost,
        tokens: usage.tokens,
      },
      members: { used: row.members_used, max: MAX_MEMBERS as 16 },
      ...(row.state_reason ? { stateReason: row.state_reason } : {}),
      ...(row.end_reason ? { endReason: row.end_reason } : {}),
      delegation: row.delegation ?? null,
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    };
  }

  async run(account: string, runId: string): Promise<SwarmRun> {
    return this.dependencies.db.withAccountSnapshot(account, (client) =>
      this.runOf(client, account, runId),
    );
  }

  /** 本档案的群研运行，新的在前（契约 §2 列表）。 */
  async list(account: string, dossierId: string): Promise<{ runs: SwarmRun[] }> {
    const runs = await this.dependencies.db.withAccountSnapshot(account, async (client) => {
      const rows = (
        await client.query(
          `select s.run_id,s.question,s.state,s.round,s.plan_version,s.limit_rounds,s.limit_minutes,
                  s.active_ms,s.active_since,s.members_used,s.state_reason,s.end_reason,s.started_at,s.ended_at,
                  coalesce(u.unknown_requests,0)::int unknown_requests,
                  coalesce(u.requests,0)::int requests,
                  u.known_cny::text known_cny,
                  u.in_tokens,u.out_tokens,u.unknown_tokens
             from swarm_run s
             left join lateral (
               select count(*)::int requests,
                      count(*) filter (where not known)::int unknown_requests,
                      sum(cost_cny) known_cny,
                      sum(input_tokens)::bigint in_tokens,
                      sum(output_tokens)::bigint out_tokens,
                      count(*) filter (where input_tokens is null or output_tokens is null)::int unknown_tokens
                 from usage_record where run_id = s.run_id
             ) u on true
            where s.account_id=$1 and s.dossier_id=$2
            order by s.created_at desc limit 20`,
          [account, dossierId],
        )
      ).rows;
      return rows.map((row) => {
        const requests = Number(row.requests);
        const known = requests > 0 && Number(row.unknown_requests) === 0 && row.known_cny !== null;
        const tokens =
          requests > 0 && Number(row.unknown_tokens) === 0
            ? Number(row.in_tokens ?? 0) + Number(row.out_tokens ?? 0)
            : null;
        return {
          id: String(row.run_id),
          dossierId,
          question: String(row.question),
          state: row.state as SwarmRunState,
          phase: Number(row.round) >= 3 ? ("cross" as const) : ("independent" as const),
          round: Number(row.round),
          planVersion: Number(row.plan_version),
          limits: { rounds: Number(row.limit_rounds), minutes: Number(row.limit_minutes) },
          used: {
            rounds: Number(row.round),
            activeMs: this.accumulate({
              ...(row as unknown as RunRow),
              state: row.state as SwarmRunState,
            }),
            cost: { value: known ? Number(row.known_cny) : null, known },
            tokens,
          },
          members: { used: Number(row.members_used), max: MAX_MEMBERS as 16 },
          ...(row.state_reason ? { stateReason: String(row.state_reason) } : {}),
          ...(row.end_reason ? { endReason: row.end_reason as SwarmRun["endReason"] } : {}),
          startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
          endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
        } satisfies SwarmRun;
      });
    });
    return { runs };
  }

  // ── 计划 ──────────────────────────────────────────

  /** 负责人通过 research_plan 工具交上来的计划：入库并等用户确认。 */
  async publishPlan(
    account: string,
    runId: string,
    input: unknown,
  ): Promise<{ version: number }> {
    const plan = readPlan(input);
    return this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId);
      if (TERMINAL.has(row.state)) throw new ApiFailure("RUN_ENDED", 409, "这次群研已经结束。");
      const version = row.plan_version + 1;
      const document: SwarmPlan = {
        ...plan,
        version,
        needsConfirm: true,
        roster: plan.roster.map((entry) => ({ ...entry, model: entry.model || this.dependencies.model })),
      };
      await client.query(
        `insert into swarm_plan(account_id,run_id,version,document) values($1,$2,$3,$4)`,
        [account, runId, version, JSON.stringify(document)],
      );
      await client.query(
        `update swarm_run set plan_version=$3, limit_rounds=$4, limit_minutes=$5, state='awaiting_confirm',
           state_reason='等你确认计划', updated_at=now()
         where account_id=$1 and run_id=$2`,
        [account, runId, version, document.limits.rounds, document.limits.minutes],
      );
      await this.emitRun(client, account, runId);
      await this.emitSimple(client, account, runId, "plan", document);
      return { version };
    });
  }

  /** 确认计划：用户可改轮数/时长（不低于下限）；版本不符 409 并带最新计划。 */
  async confirmPlan(
    account: string,
    runId: string,
    input: { planVersion: number; limits?: { rounds?: number; minutes?: number } },
  ): Promise<{ run: SwarmRun }> {
    const outcome = await this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId);
      if (row.plan_version !== input.planVersion) {
        const latest = await this.planOf(client, account, runId);
        throw new ApiFailure("PLAN_STALE", 409, "计划已经有新版本，请按最新版本确认。", {
          planVersion: row.plan_version,
          plan: latest,
        });
      }
      if (row.state !== "awaiting_confirm")
        throw new ApiFailure("PLAN_NOT_PENDING", 409, "这次群研现在不在等确认计划。");
      const rounds = Number(input.limits?.rounds ?? row.limit_rounds);
      const minutes = Number(input.limits?.minutes ?? row.limit_minutes);
      if (!Number.isSafeInteger(rounds) || rounds < MIN_ROUNDS)
        throw new ApiFailure("LIMIT_TOO_LOW", 400, `轮数不能低于 ${MIN_ROUNDS} 轮。`);
      if (!Number.isSafeInteger(minutes) || minutes < MIN_MINUTES)
        throw new ApiFailure("LIMIT_TOO_LOW", 400, `时长不能低于 ${MIN_MINUTES} 分钟。`);
      await client.query(
        `update swarm_plan set confirmed_at=now() where account_id=$1 and run_id=$2 and version=$3`,
        [account, runId, row.plan_version],
      );
      await client.query(
        `update swarm_run set state='running', round=1, limit_rounds=$3, limit_minutes=$4,
           started_at=coalesce(started_at, now()), active_since=now(), state_reason=null, updated_at=now()
         where account_id=$1 and run_id=$2`,
        [account, runId, rounds, minutes],
      );
      await this.emitRun(client, account, runId);
      const plan = await this.planOf(client, account, runId);
      return { plan };
    });
    // 确认之后真正开跑：同一段会话接着干，不新建会话。
    // 澄清那一轮可能还没让出会话：重试几次；仍不行就留给人话说明，
    // 由那一轮结束时自动接上（onTurnEnd 第 1 轮会用开跑指令）。
    const kickoff = kickoffPrompt(outcome.plan);
    let started = false;
    for (let attempt = 0; attempt < 8 && !started; attempt += 1) {
      started = await this.dependencies.kernel
        .submit(account, runId, { mode: "swarm", prompt: kickoff })
        .then(() => true)
        .catch(() => false);
      if (!started) await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (!started)
      await this.dependencies.db.withAccount(account, async (client) => {
        const row = await this.row(client, account, runId);
        if (row.state !== "running") return;
        await client.query(
          "update swarm_run set state_reason=$3, updated_at=now() where account_id=$1 and run_id=$2",
          [account, runId, "负责人的上一轮还没让出会话，这一轮结束后会自动接上"],
        );
        await this.emitRun(client, account, runId);
      });
    return { run: await this.run(account, runId) };
  }

  /**
   * 进程重启后的恢复（13-swarm-contract.md §7.4）：这一轮在本次进程启动之前就结束了、
   * 而研究状态还是「在跑」，说明它是上一个进程留下的。照实标成暂停并写明原因——
   * 成员、任务、额度都不重置，继续时按 DSH 任务板接着做。
   */
  private async recoverIfInterrupted(
    client: pg.PoolClient,
    account: string,
    row: RunRow,
  ): Promise<RunRow> {
    if (this.recovered.has(row.run_id)) return row;
    this.recovered.add(row.run_id);
    const startedAt = this.dependencies.processStartedAt;
    if (!startedAt || !TIMED.has(row.state)) return row;
    if (this.dependencies.kernel.isLive(row.run_id)) return row;
    const last = (
      await client.query(
        "select max(ended_at) ended_at from dsh_turn where account_id=$1 and run_id=$2",
        [account, row.run_id],
      )
    ).rows[0]?.ended_at;
    const endedAt = last ? new Date(last).getTime() : 0;
    if (endedAt >= startedAt) return row;
    await this.settleTiming(client, account, row);
    const next = (
      await client.query(
        `update swarm_run set state='paused', active_since=null,
           state_reason='已从中断恢复：上一次进程在运行中结束了，可以继续', updated_at=now()
         where account_id=$1 and run_id=$2
         returning run_id,dossier_id,question,state,phase,round,plan_version,limit_rounds,limit_minutes,
           active_ms,active_since,members_used,projected_seq,state_reason,end_reason,delegation,
           started_at,ended_at`,
        [account, row.run_id],
      )
    ).rows[0] as RunRow;
    await this.emitRun(client, account, row.run_id);
    return next;
  }

  private async planOf(
    client: pg.PoolClient,
    account: string,
    runId: string,
  ): Promise<SwarmPlan | null> {
    const row = (
      await client.query(
        `select document from swarm_plan where account_id=$1 and run_id=$2 order by version desc limit 1`,
        [account, runId],
      )
    ).rows[0];
    return row ? (row.document as SwarmPlan) : null;
  }

  /** 这次群研还在跑吗（没到终态）。内核据此决定轮次之间怎么标 run 行。 */
  async isActive(account: string, runId: string): Promise<boolean> {
    const state = await this.dependencies.db.withAccountSnapshot(account, async (client) =>
      String(
        (
          await client.query(
            "select state from swarm_run where account_id=$1 and run_id=$2",
            [account, runId],
          )
        ).rows[0]?.state ?? "",
      ),
    );
    return state !== "" && !TERMINAL.has(state as SwarmRunState);
  }

  /** 内核挂钩：会话里又落了一条事件就折算一次。 */
  async onRunEvent(account: string, runId: string): Promise<void> {
    await this.project(account, runId);
  }

  // ── 折算 ──────────────────────────────────────────

  /**
   * 把 DSH 会话里新增的事件折算成研究事件。可以反复调用：只处理 projected_seq 之后的。
   */
  async project(account: string, runId: string): Promise<number> {
    const { db } = this.dependencies;
    return db.withAccount(account, async (client) => {
      let row = await this.row(client, account, runId);
      row = await this.recoverIfInterrupted(client, account, row);
      const cursor = Number(row.projected_seq ?? 0);
      const events = (
        await client.query(
          `select seq,action,payload from event
            where account_id=$1 and run_id=$2 and kind='dsh' and seq > $3
            order by seq limit 500`,
          [account, runId, cursor],
        )
      ).rows;
      if (!events.length) return 0;
      const state = await loadFold(client, account, runId);
      const context = {
        account,
        runId,
        dossierId: row.dossier_id,
        planVersion: row.plan_version,
        round: row.round,
        model: this.dependencies.model,
      };
      await projectEvents(client, context, events, state);
      const last = Number(events[events.length - 1].seq);
      await client.query(
        `update swarm_run set projected_seq=$3, members_used=greatest(members_used,$4), updated_at=now()
         where account_id=$1 and run_id=$2`,
        [account, runId, last, state.members.size > 0 ? state.members.size - 1 : 0],
      );
      // 名册变了就把运行行也刷新一次，页面顶栏的累计队员立刻对得上。
      if (state.members.size > 0) await this.emitRun(client, account, runId);
      return last;
    });
  }

  // ── 快照 / 时间线 / 事件 ───────────────────────────

  async snapshot(account: string, runId: string): Promise<SwarmSnapshot> {
    await this.project(account, runId);
    return this.dependencies.db.withAccountSnapshot(account, async (client) => {
      const row = await this.row(client, account, runId);
      const run = await this.runOf(client, account, runId);
      const plan = await this.planOf(client, account, runId);
      const fold = await loadFold(client, account, runId);
      const posts = await this.posts(client, account, runId);
      const interventions = await this.interventions(client, account, runId);
      const approvals = (
        await client.query(
          `select id from approval where account_id=$1 and run_id=$2 and state='pending' order by created_at`,
          [account, runId],
        )
      ).rows.map((approval) => String(approval.id));
      const cursor = Number(
        (
          await client.query(
            "select coalesce(max(seq),0)::bigint seq from swarm_event where account_id=$1 and run_id=$2",
            [account, runId],
          )
        ).rows[0]?.seq ?? 0,
      );
      const claims: Claim[] = [];
      const evidence: Evidence[] = [];
      const reviews: Review[] = [];
      // MVP-1 还没有黑板：汇总区显示「核实未接通，全部是候选」，不给正式报告。
      const report: SwarmReport | null = null;
      const routes = plan
        ? plan.routes.map((route) => ({
            id: route.id,
            title: route.title,
            idea: route.idea,
            approachFamily: route.idea.slice(0, 40),
            tags: [],
            state: "active" as const,
            taskIds: [...fold.tasks.values()].filter((task) => task.routeId === route.id).map((task) => task.id),
            memberIds: [...fold.members.values()]
              .filter((member) => member.tags.includes(route.id))
              .map((member) => member.id),
          }))
        : [];
      return {
        run,
        plan,
        members: [...fold.members.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
        tasks: [...fold.tasks.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
        routes,
        posts,
        claims,
        evidence,
        reviews,
        interventions,
        report,
        pendingApprovals: approvals,
        cursor,
      } satisfies SwarmSnapshot;
    });
  }

  async timeline(
    account: string,
    runId: string,
    after: number,
    limit: number,
  ): Promise<{ entries: BusEntry[]; next: number | null }> {
    await this.project(account, runId);
    const rows = await this.dependencies.db.withAccountSnapshot(account, (client) =>
      client.query(
        `select seq,data from swarm_event
          where account_id=$1 and run_id=$2 and type='bus' and seq > $3
          order by seq limit $4`,
        [account, runId, after, limit],
      ),
    );
    const entries = rows.rows.map((row) => ({ ...(row.data as BusEntry), seq: Number(row.seq) }));
    return {
      entries,
      next: rows.rows.length === limit ? Number(rows.rows[rows.rows.length - 1].seq) : null,
    };
  }

  /** SSE 帧来源：把 seq 之后的全部研究事件按契约的帧形状给出去（含队员记录）。 */
  async events(
    account: string,
    runId: string,
    after: number,
    limit = 200,
  ): Promise<{ seq: number; at: string; runId: string; dossierId: string; type: string; data: unknown }[]> {
    await this.project(account, runId);
    const rows = await this.dependencies.db.withAccountSnapshot(account, async (client) => {
      const run = await this.row(client, account, runId);
      const events = await client.query(
        `select seq,at,type,data from swarm_event
          where account_id=$1 and run_id=$2 and seq > $3
          order by seq limit $4`,
        [account, runId, after, limit],
      );
      return { dossierId: run.dossier_id, rows: events.rows };
    });
    return rows.rows.map((row) => ({
      seq: Number(row.seq),
      at: new Date(row.at).toISOString(),
      runId,
      dossierId: rows.dossierId,
      type: String(row.type),
      data: row.data,
    }));
  }

  async memberLog(
    account: string,
    runId: string,
    memberId: string,
    after: number,
  ): Promise<{ items: MemberLogItem[]; next: number | null }> {
    await this.project(account, runId);
    const rows = await this.dependencies.db.withAccountSnapshot(account, (client) =>
      client.query(
        `select seq,data from swarm_event
          where account_id=$1 and run_id=$2 and type='member_log' and data->>'member'=$3 and seq > $4
          order by seq limit 200`,
        [account, runId, memberId, after],
      ),
    );
    const items = rows.rows.map((row) => ({ ...(row.data as MemberLogItem), seq: Number(row.seq) }));
    return { items, next: null };
  }

  // ── 留言 ──────────────────────────────────────────

  async posts(client: pg.PoolClient, account: string, runId: string): Promise<BoardPost[]> {
    const rows = (
      await client.query(
        `select id,col,author,body,at,seq,recipient,reply_to,answered,refs,scope from swarm_post
          where account_id=$1 and run_id=$2 order by seq`,
        [account, runId],
      )
    ).rows;
    return rows.map((row) => ({
      id: String(row.id),
      col: row.col,
      by: row.author,
      text: row.body,
      at: new Date(row.at).toISOString(),
      seq: Number(row.seq),
      to: row.recipient ?? null,
      ...(row.reply_to ? { replyTo: String(row.reply_to) } : {}),
      ...(row.answered !== null ? { answered: Boolean(row.answered) } : {}),
      refs: row.refs ?? {},
      ...(row.scope ? { scope: row.scope } : {}),
    })) as BoardPost[];
  }

  /** 用户在留言板发言；带 @队员 时同时生成一条 mention 干预（契约 §2 留言）。 */
  async createPost(
    account: string,
    runId: string,
    input: { col: BoardPost["col"]; text: string; to?: string; replyTo?: string },
  ): Promise<{ post: BoardPost; intervention: Intervention | null }> {
    return this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId);
      if (TERMINAL.has(row.state) && input.col !== "question")
        throw new ApiFailure("RUN_ENDED", 409, "这次群研已经结束，只能补充提问。");
      const postId = randomUUID();
      await client.query(
        `insert into swarm_post(id,account_id,run_id,dossier_id,col,author,body,recipient,reply_to)
         values($1,$2,$3,$4,$5,'user',$6,$7,$8)`,
        [
          postId,
          account,
          runId,
          row.dossier_id,
          input.col,
          input.text,
          input.to ?? null,
          input.replyTo ?? null,
        ],
      );
      if (input.replyTo)
        await client.query(
          "update swarm_post set answered=true where account_id=$1 and id=$2",
          [account, input.replyTo],
        );
      const post = (await this.posts(client, account, runId)).find((entry) => entry.id === postId)!;
      // @队员：同时投递一条 mention 干预给指定队员，默认给负责人（回执分开显示）。
      const mentioned = /@([A-Za-z0-9_\-\u4e00-\u9fa5]+)/.exec(input.text)?.[1] ?? input.to ?? null;
      let intervention: Intervention | null = null;
      if (mentioned) {
        const id = randomUUID();
        await client.query(
          `insert into swarm_intervention(id,account_id,run_id,dossier_id,kind,text,target,state,result)
           values($1,$2,$3,$4,'mention',$5,$6,'received','已收下；负责人在下一段会看到这条。')`,
          [
            id,
            account,
            runId,
            row.dossier_id,
            input.text,
            JSON.stringify({ memberId: mentioned }),
          ],
        );
        intervention = (await this.interventions(client, account, runId)).find((entry) => entry.id === id)!;
      }
      await this.emitSimple(client, account, runId, "post", post);
      if (intervention) await this.emitSimple(client, account, runId, "intervention", intervention);
      return { post, intervention };
    });
  }

  // ── 干预 ──────────────────────────────────────────

  async interventions(client: pg.PoolClient, account: string, runId: string): Promise<Intervention[]> {
    const rows = (
      await client.query(
        `select id,kind,text,target,state,approval_id,result,at from swarm_intervention
          where account_id=$1 and run_id=$2 order by at`,
        [account, runId],
      )
    ).rows;
    return rows.map((row) => ({
      id: String(row.id),
      kind: row.kind as InterventionKind,
      ...(row.text ? { text: String(row.text) } : {}),
      ...(row.target ? { target: row.target } : {}),
      state: row.state,
      ...(row.approval_id ? { approvalId: String(row.approval_id) } : {}),
      ...(row.result ? { result: String(row.result) } : {}),
      at: new Date(row.at).toISOString(),
    }));
  }

  async createIntervention(
    account: string,
    runId: string,
    input: {
      kind: InterventionKind;
      text?: string;
      target?: { memberId?: string; routeId?: string };
      limits?: { rounds?: number; minutes?: number };
    },
  ): Promise<{ intervention: Intervention; run: SwarmRun }> {
    if (!["stop_route", "pause", "resume", "finish"].includes(input.kind))
      throw new ApiFailure("INTERVENTION_UNSUPPORTED", 409, "这种干预还没接通（靠后阶段）。");
    const intervention = await this.dependencies.db.withAccount(account, async (client) => {
      const current = await this.row(client, account, runId);
      const id = randomUUID();
      await client.query(
        `insert into swarm_intervention(id,account_id,run_id,dossier_id,kind,text,target,state)
         values($1,$2,$3,$4,$5,$6,$7,'received')`,
        [
          id,
          account,
          runId,
          current.dossier_id,
          input.kind,
          input.text ?? null,
          input.target ? JSON.stringify(input.target) : null,
        ],
      );
      await this.transition(client, account, current, input);
      const intervention = (await this.interventions(client, account, runId)).find(
        (entry) => entry.id === id,
      )!;
      await this.emitSimple(client, account, runId, "intervention", intervention);
      await this.emitRun(client, account, runId);
      return intervention;
    });
    // 暂停 / 结束要真的把这一轮停下来；继续要把同一段会话接着跑起来。
    if (input.kind === "pause" || input.kind === "finish") {
      await this.dependencies.kernel.cancel(account, runId).catch(() => "cancel_unconfirmed" as const);
      await this.dependencies.db.withAccount(account, async (client) => {
        const current = await this.row(client, account, runId);
        await client.query(
          `update swarm_intervention set state='applied', result=$3, updated_at=now()
             where account_id=$1 and id=$2`,
          [account, intervention.id, input.kind === "pause" ? "已停止派发并中断当前这一轮；产出保留。" : "已停止新增工作，保存已有结论和未完成项。"],
        );
        if (current.active_since) await this.settleTiming(client, account, current);
        await this.emitRun(client, account, runId);
      });
    } else if (input.kind === "resume") {
      await this.dependencies.db.withAccount(account, async (client) => {
        await client.query(
          `update swarm_intervention set state='applied', result=$3, updated_at=now()
             where account_id=$1 and id=$2`,
          [account, intervention.id, "已继续，先核对现状再往下走。"],
        );
      });
      // 暂停时这一轮是被中断的：先把 run 行重新打开，否则会被当成已结束。
      await this.dependencies.db.withAccount(account, async (client) => {
        await client.query(
          `update run set state='waiting', ended_at=null
            where account_id=$1 and id=$2 and state in ('cancelled','interrupted','completed','failed')`,
          [account, runId],
        );
      });
      await this.dependencies.kernel
        .submit(account, runId, {
          mode: "swarm",
          prompt: "继续。先核对任务板和名册的现状，只做还没完成的部分，不要重复已经交付过的结果。",
        })
        .catch(async () => {
          await this.dependencies.db.withAccount(account, async (client) => {
            await client.query(
              "update swarm_intervention set state='failed', result=$3 where account_id=$1 and id=$2",
              [account, intervention.id, "继续失败：会话还占着或运行已收尾。"],
            );
          });
        });
    } else {
      await this.dependencies.db.withAccount(account, async (client) => {
        await client.query(
          `update swarm_intervention set state='applied', result=$3, updated_at=now()
             where account_id=$1 and id=$2`,
          [
            account,
            intervention.id,
            input.target?.routeId
              ? `已记录停止路线 ${input.target.routeId}；具体中断由负责人处理，产出保留。`
              : "已记录停止决定。",
          ],
        );
        await this.emitRun(client, account, runId);
      });
    }
    return { intervention, run: await this.run(account, runId) };
  }

  /** 干预之后的新状态：计时与结束原因一起落库。 */
  private async transition(
    client: pg.PoolClient,
    account: string,
    row: RunRow,
    input: { kind: InterventionKind; text?: string; target?: { routeId?: string } },
  ) {
    const now = new Date();
    if (input.kind === "pause") {
      if (row.state === "paused") return;
      await this.settleTiming(client, account, { ...row, state: row.state });
      await client.query(
        `update swarm_run set state='paused', state_reason='你暂停了这次群研', active_since=null, updated_at=now()
         where account_id=$1 and run_id=$2`,
        [account, row.run_id],
      );
      return;
    }
    if (input.kind === "resume") {
      await client.query(
        `update swarm_run set state='running', state_reason=null, active_since=coalesce(active_since, now()), updated_at=now()
         where account_id=$1 and run_id=$2`,
        [account, row.run_id],
      );
      return;
    }
    if (input.kind === "finish") {
      // 用户结束：不伪装成功。核实还没接通，所以按「部分完成」收尾并写明原因。
      await this.settleTiming(client, account, row, now);
      await client.query(
        `update swarm_run set state='partial', end_reason='user_finished',
           state_reason='你结束了这次群研；已交付的产出保留，但没有经过核实的结论。',
           active_since=null, ended_at=coalesce(ended_at, now()), updated_at=now()
         where account_id=$1 and run_id=$2`,
        [account, row.run_id],
      );
      return;
    }
    // stop_route：只记录决定，任务归属由负责人显式处理（DSH 中断不释放归属）。
    await client.query(
      `update swarm_run set state_reason=$3, updated_at=now() where account_id=$1 and run_id=$2`,
      [account, row.run_id, `已停止路线 ${input.target?.routeId ?? ""}：需要新机制才能重开`],
    );
  }

  private async settleTiming(
    client: pg.PoolClient,
    account: string,
    row: RunRow,
    now = new Date(),
  ) {
    const total = this.accumulate(row, now);
    await client.query(
      "update swarm_run set active_ms=$3, active_since=null where account_id=$1 and run_id=$2",
      [account, row.run_id, total],
    );
  }

  // ── 回执 ──────────────────────────────────────────

  /**
   * 一轮结束：结算计时、按额度决定是继续下一轮还是收尾。
   * 返回是否已经安排了下一轮。
   */
  async onTurnEnd(
    account: string,
    runId: string,
    state: "completed" | "failed" | "cancelled" | "cancel_unconfirmed",
  ): Promise<{ continued: boolean }> {
    const decision = await this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId).catch(() => null);
      if (!row) return null;
      // 任何阶段这一轮真要失败，就照实标失败：不能让澄清阶段的崩溃悄悄挂着。
      if (state === "failed") {
        await client.query(
          "update swarm_run set state='failed', end_reason='error', state_reason='这一轮执行失败', active_since=null, ended_at=now(), updated_at=now() where account_id=$1 and run_id=$2",
          [account, runId],
        );
        await this.emitRun(client, account, runId);
        return null;
      }
      // 澄清和等确认这两段不算研究轮次：澄清没出计划就停在那里等用户；
      // 暂停 / 已结束 / 收尾中的运行不再自动续跑。
      if (row.state !== "running" && row.state !== "near_limit") return null;
      if (state === "cancelled" || state === "cancel_unconfirmed") return null;
      const fold = await loadFold(client, account, runId);
      const open = [...fold.tasks.values()].filter(
        (task) => task.state !== "delivered" && task.state !== "stopped",
      ).length;
      await this.settleTiming(client, account, row);
      const active = Number(
        (await client.query("select active_ms from swarm_run where account_id=$1 and run_id=$2", [account, runId]))
          .rows[0]?.active_ms ?? 0,
      );
      // 任务都交付完了，或额度到限：停下来，把阶段结果留在原地。
      if (open === 0 || row.round >= row.limit_rounds || active >= row.limit_minutes * 60_000) {
        const reason =
          open === 0
            ? "任务都交付了；核实还没接通，结论仍然是候选"
            : active >= row.limit_minutes * 60_000
              ? `到达 ${row.limit_minutes} 分钟`
              : `到达 ${row.limit_rounds} 轮`;
        await client.query(
          `update swarm_run set state='partial', state_reason=$3, end_reason=$4, active_since=null,
             ended_at=now(), updated_at=now() where account_id=$1 and run_id=$2`,
          [account, runId, reason, open === 0 ? "answered" : "limit"],
        );
        await this.emitRun(client, account, runId);
        return null;
      }
      await client.query(
        `update swarm_run set round=round+1, state='running', state_reason=null, active_since=now(), updated_at=now()
         where account_id=$1 and run_id=$2`,
        [account, runId],
      );
      await this.emitRun(client, account, runId);
      return { round: row.round + 1 };
    });
    if (!decision) return { continued: false };
    // 第 1 轮是开跑（要带上计划与编制），之后的轮次只看还差什么。
    const prompt =
      decision.round <= 1
        ? kickoffPrompt(
            await this.dependencies.db.withAccount(account, (client) =>
              this.planOf(client, account, runId),
            ),
          )
        : `第 ${decision.round} 轮。先看任务板还有哪些没交付，把没人做的分给队员，收齐之后再综合。不要重复已经交付的结果。`;
    await this.dependencies.kernel
      .submit(account, runId, { mode: "swarm", prompt })
      .catch(() => undefined);
    return { continued: true };
  }

  // ── 小工具 ────────────────────────────────────────

  private async emitSimple(
    client: pg.PoolClient,
    account: string,
    runId: string,
    type: string,
    data: unknown,
  ): Promise<number | null> {
    const row = await this.row(client, account, runId);
    const result = await client.query(
      `insert into swarm_event(account_id,run_id,dossier_id,type,data,source)
       values($1,$2,$3,$4,$5,'control') returning seq`,
      [account, runId, row.dossier_id, type, JSON.stringify(data)],
    );
    const seq = Number(result.rows[0].seq);
    // 通信条目 / 队员记录的 seq 就是全局事件序号：写进去之后再补一次。
    if ((type === "bus" || type === "member_log") && data && typeof data === "object") {
      const withSeq = { ...(data as Record<string, unknown>), seq };
      await client.query(
        "update swarm_event set data=$3 where account_id=$1 and run_id=$2 and seq=$4",
        [account, runId, JSON.stringify(withSeq), seq],
      );
    }
    return seq;
  }

  private async emitRun(client: pg.PoolClient, account: string, runId: string) {
    await this.emitSimple(client, account, runId, "run", await this.runOf(client, account, runId));
    const usage = (
      await client.query("select 1 from usage_record where run_id=$1 limit 1", [runId])
    ).rowCount;
    if (usage) {
      const run = await this.runOf(client, account, runId);
      await this.emitSimple(client, account, runId, "usage", run.used);
    }
  }

  /** 内核把队员记录上报过来时落到同一条事件流（members/:id/log 读它）。 */
  async reportMemberLog(
    account: string,
    runId: string,
    item: { member: string; to?: string | null } & MemberLogItem,
  ): Promise<{ seq: number | null }> {
    return this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId);
      // 队员发出的消息：插件知道是谁发的，按真实发送者记一条队内消息。
      if (item.kind === "message_out") {
        const bus = {
          seq: 0,
          at: new Date().toISOString(),
          type: "message",
          from: item.member,
          to: item.to ?? "lead",
          text: item.text,
          delivery: "sent",
          refs: {},
        };
        const busSeq = await this.emitSimple(client, account, runId, "bus", bus);
        return { seq: busSeq };
      }
      const seq = await this.emitSimple(client, account, runId, "member_log", item);
      // 名册上「正在做什么」也按最新一条工具记录更新，页面不用自己猜。
      if (item.tool && item.member !== "lead") {
        const prior = (
          await client.query(
            `select data from swarm_event where account_id=$1 and run_id=$2 and type='member'
               and data->>'id'=$3 order by seq desc limit 1`,
            [account, runId, item.member],
          )
        ).rows[0]?.data as SwarmMember | undefined;
        if (prior) {
          const next: SwarmMember = {
            ...prior,
            state: item.tool.state === "running" ? "running" : "idle",
            doing: { taskId: "", summary: item.text.slice(0, 120) },
          };
          await this.emitSimple(client, account, runId, "member", next);
        }
      }
      return { seq: seq ?? null };
    });
  }
}

/** 澄清阶段的输入：只写身份和底线，不写操作步骤（模型自己决定怎么问）。 */
function clarificationPrompt(question: string): string {
  return [
    `用户要在研究台上开一次「群研」，研究问题是：${question}`,
    "",
    "现在还在澄清阶段：先把问题边界、质量判据、几条不同路线、人员与模型、轮数和时长谈清楚，不要建队，也不要开始检索。",
    "澄清可以一次问清，也可以随对话推进；拿不准的、需要用户定的，用 clarify_question 问，不要替用户选。",
    "澄清够了就调用 research_plan 交一份计划（问题、边界、质量判据、路线、编制、轮数/时长）。计划交上来之后会等用户确认，确认了才开跑。",
  ].join("\n");
}

/** 确认之后的开跑输入：编制、命名、任务约定都写清楚，服务端才能如实折算。 */
function kickoffPrompt(plan: SwarmPlan | null): string {
  const rounds = plan?.limits.rounds ?? MIN_ROUNDS;
  const routes = plan?.routes.map((route) => `- ${route.id}：${route.title}（${route.idea}）`).join("\n") ?? "";
  return [
    "用户已确认计划，现在开跑。",
    plan ? `研究问题：${plan.question}` : "",
    plan ? `边界：${plan.scope}` : "",
    routes ? `路线：\n${routes}` : "",
    "",
    "按计划建队并推进：负责人（你）+ 研究员 3 名 + 反驳 1 名 + 核实 1 名。",
    "研究员必须用 fresh 上下文（spawn_teammate 的 context 不写或写 fresh），名字用 researcher-01 / researcher-02 / researcher-03，",
    "反驳用 critic-01，核实用 verifier-01；一个研究员只跟一条路线，三条路线不要用同一种做法。",
    "每个任务在 DSH 任务板上建，描述第一行写 `route=<路线id> kind=<research|review|verify|synthesis> parent=<父任务id>`，",
    "这样页面上的任务树和路线才对得上；有依赖就用 blocked_by，别让被挡住的任务被领取。",
    `这次额度是 ${rounds} 轮、${plan?.limits.minutes ?? MIN_MINUTES} 分钟。用 wait_agent 收齐产出，不要停下来等用户。`,
    "队员要用 research_files 在 team/<队员名>/ 里写自己的记录（目录会自己建出来）；不要读写别人的目录。",
    "根任务不要放进别的任务的 blocked_by：它不会被完成，团队会被自己卡死。",
    "收齐之后把哪些做了、哪些没做、还缺什么讲清楚；没有核实过的结论只说「候选」。",
  ]
    .filter(Boolean)
    .join("\n");
}
