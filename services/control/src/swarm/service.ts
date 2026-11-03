import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  MemberRole,
  SwarmRoute,
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
import { labelOf, loadFold, projectEvents } from "./project";
import {
  cardLabel,
  createSwarmCard,
  readSwarmCard,
  requireLiveCard,
  type SwarmCardKind,
} from "./cards";
import {
  buildReport,
  contextPacket,
  claimEvidenceIds,
  claimRow,
  evidenceRow,
  findSubmission,
  latestClaims,
  loadApproaches,
  loadClaim,
  loadEvidence,
  MAX_EVIDENCE_PER_SUBMISSION,
  putApproach,
  putClaim,
  putEvidence,
  readApproach,
  readClaim,
  readEvidence,
  recordSubmission,
  loadReviews,
  readReview,
  reviewClaim,
  type SubmissionResult,
} from "./blackboard";

/** 队员累计名额：完全沿用 DSH 的 maxMembers=16（负责人之外最多 16 个队员）。 */
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const MAX_MEMBERS = 16;
/** 额度下限（12-swarm.md §3）：最少 4 轮 / 30 分钟，只做下限，不强制耗满。 */
export const MIN_ROUNDS = 4;
export const MIN_MINUTES = 30;

/** MVP-3 第二批接通的全部干预（契约 §2：1 的三种 + 3 的四种）。 */
export const INTERVENTIONS_READY: InterventionKind[] = [
  "stop_route",
  "pause",
  "resume",
  "finish",
  "mention",
  "redirect",
  "add_member",
  "extend",
];

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
  kickoff_at: Date | null;
  lead_session: string | null;
  projected_seq: string | number;
  state_reason: string | null;
  end_reason: SwarmRun["endReason"] | null;
  delegation: SwarmRun["delegation"] | null;
  started_at: Date | null;
  ended_at: Date | null;
  /** 用户改过方向、等负责人交新版本计划：交了就直接接着做，不再等确认。 */
  redirect_pending?: boolean;
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
                active_ms,active_since,members_used,kickoff_at,lead_session,projected_seq,
                state_reason,end_reason,delegation,started_at,ended_at,redirect_pending
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
  /** 改方向之后负责人交了新版本计划、问题本身变了：要用户批一次范围（契约 §5 swarm_scope）。 */
  private async maybeScopeCard(
    client: pg.PoolClient,
    account: string,
    runId: string,
  ): Promise<void> {
    const row = (
      await client.query(
        `select plan_version, dossier_id, state from swarm_run where account_id=$1 and run_id=$2`,
        [account, runId],
      )
    ).rows[0];
    if (!row || Number(row.plan_version) < 2) return;
    // 比的是两份计划文档里的问题：run.question 是发起时那句，改方向后要看新版本。
    const previous = (
      await client.query(
        `select document->>'question' question from swarm_plan
          where account_id=$1 and run_id=$2 and version=$3`,
        [account, runId, Number(row.plan_version) - 1],
      )
    ).rows[0];
    const current = (
      await client.query(
        `select document->>'question' question from swarm_plan
          where account_id=$1 and run_id=$2 and version=$3`,
        [account, runId, Number(row.plan_version)],
      )
    ).rows[0];
    const before = String(previous?.question ?? "");
    const after = String(current?.question ?? "");
    if (!before || !after || before === after) return;
    // 只有「问题本身变了」才要批：只是措辞调整（互相包含）不算扩大范围。
    const normalize = (text: string) => text.replace(/\s+/g, "").replace(/[，。、；：]/g, "");
    const a = normalize(before);
    const b = normalize(after);
    if (a && b && (a.includes(b) || b.includes(a))) return;
    const card = await createSwarmCard(client, {
      account,
      runId,
      dossierId: String(row.dossier_id),
      kind: "swarm_scope",
      title: "问题范围变了，需要你确认",
      payload: {
        from: Number(row.plan_version) - 1,
        to: Number(row.plan_version),
        changes: [`原问题：${before.slice(0, 100)}`, `新问题：${after.slice(0, 100)}`],
      },
    });
    if (card.created)
      await client.query(
        `update swarm_run set state='awaiting_confirm', state_reason=$3, updated_at=now()
         where account_id=$1 and run_id=$2 and state in ('running','near_limit')`,
        [account, runId, "问题范围变了，等你确认新版本计划"],
      );
  }

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
      // 改方向之后交上来的新版本：直接接着做；只有问题范围变了才要用户批一次（swarm_scope）。
      const afterRedirect = Boolean(row.redirect_pending);
      await client.query(
        `update swarm_run set plan_version=$3, limit_rounds=$4, limit_minutes=$5,
           state=$6, state_reason=$7, redirect_pending=false, question=$8, updated_at=now()
         where account_id=$1 and run_id=$2`,
        [
          account,
          runId,
          version,
          document.limits.rounds,
          document.limits.minutes,
          afterRedirect ? "running" : "awaiting_confirm",
          afterRedirect ? null : "等你确认计划",
          document.question,
        ],
      );
      if (afterRedirect) await this.maybeScopeCard(client, account, runId);
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
      // 用户点确认时负责人可能刚说完「还在待确认」：那句在当时不算错，但用户读到就过期了。
      // 确认落库之后立刻补一条系统说明，别让人以为卡住了（E8）。
      const staleDelivers = (
        await client.query(
          `select seq, data from swarm_event
            where account_id=$1 and run_id=$2 and type='bus'
              and data->>'type'='deliver' and data->>'from'='lead'
              and source='control'
              and (data->>'text') ~ '(待确认|还没确认|未被确认|不能建队)'
              and seq > coalesce((select max(seq) from swarm_event
                                   where account_id=$1 and run_id=$2 and type='bus'
                                     and data->>'type'='system'), 0)
            order by seq desc limit 1`,
          [account, runId],
        )
      ).rows[0];
      if (staleDelivers)
        await this.emitSimple(client, account, runId, "bus", {
          seq: 0,
          at: new Date().toISOString(),
          type: "system",
          from: "system",
          to: "user",
          text: "（上一条「计划还卡在待确认」已经过期：计划已确认，团队已开跑。）",
          refs: {},
        } satisfies BusEntry);
      await this.emitRun(client, account, runId);
      const plan = await this.planOf(client, account, runId);
      // 路线是确认后才真正建出来的：立刻推 route 事件，页面不用等刷新（E6）。
      for (const route of plan?.routes ?? []) {
        const existing = (
          await client.query(
            "select 1 from swarm_approach where account_id=$1 and run_id=$2 and route_id=$3",
            [account, runId, route.id],
          )
        ).rowCount;
        if (!existing)
          await client.query(
            `insert into swarm_approach(account_id,run_id,route_id,title,idea,approach_family,tags,state)
             values($1,$2,$3,$4,$5,$6,'[]','active')`,
            [account, runId, route.id, route.title, route.idea, route.idea.slice(0, 40)],
          );
        await this.emitSimple(client, account, runId, "route", {
          id: route.id,
          title: route.title,
          idea: route.idea,
          approachFamily: route.idea.slice(0, 40),
          tags: [],
          state: "active",
          taskIds: [],
          memberIds: [],
        } satisfies SwarmRoute);
      }
      return { plan };
    });
    // 确认之后真正开跑：同一段会话接着干，不新建会话。
    // 澄清那一轮可能还没让出会话：重试几次；仍不行就留给人话说明，
    // 由那一轮结束时自动接上（onTurnEnd 第 1 轮会用开跑指令）。
    //
    // 开跑指令只发一次：真实验收里确认与「继续」并发，同一句「用户已确认计划」
    // 进了两遍（时间线 seq 5806、5807），一个运行同时跑两回合，后一条把前一条的
    // handle 顶掉，于是「结束」停不住团队。
    const kickoff = kickoffPrompt(outcome.plan);
    let started = false;
    for (let attempt = 0; attempt < 8 && !started; attempt += 1) {
      started = await this.dependencies.kernel
        .submit(account, runId, { mode: "swarm", prompt: kickoff })
        .then(() => true)
        .catch(() => false);
      if (!started) await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (started)
      await this.dependencies.db.withAccount(account, (client) =>
        client.query(
          "update swarm_run set kickoff_at=coalesce(kickoff_at, now()), updated_at=now() where account_id=$1 and run_id=$2",
          [account, runId],
        ),
      );
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

  /**
   * 这一轮负责人对用户说的话：一条「负责人 → 用户」的通信 + 负责人记录里的正文。
   * 不开出口的话，开跑之后负责人的话在页面上就没了（验收里的 E4）。
   */
  async onTurnOutput(account: string, runId: string, text: string): Promise<void> {
    await this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId).catch(() => null);
      const trimmed = text.slice(0, 4000);
      // 计划已经确认、团队已经开跑，负责人却还在说「计划还卡在待确认」：
      // 那是它上一回合的旧印象，照实纠正成一条系统说明，别当成它现在说的话。
      const stale = /待确认|还没确认|未被确认|未确认/.test(trimmed) && row && row.state !== "awaiting_confirm";
      if (stale) {
        await this.emitSimple(client, account, runId, "bus", {
          seq: 0,
          at: new Date().toISOString(),
          type: "system",
          from: "system",
          to: "user",
          text: "负责人刚才那句「计划还没确认」是上一回合的旧印象：计划已经确认，团队已经开跑。",
          refs: {},
        } satisfies BusEntry);
        return;
      }
      await this.emitSimple(client, account, runId, "bus", {
        seq: 0,
        at: new Date().toISOString(),
        type: "deliver",
        from: "lead",
        to: "user",
        text: trimmed,
        refs: {},
      } satisfies BusEntry);
      await this.emitSimple(client, account, runId, "member_log", {
        member: "lead",
        kind: "output",
        text: trimmed,
        at: new Date().toISOString(),
      });
    });
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
      // 快到额度：一回合可能跑很久（负责人一次派完所有任务），不能等他这一轮结束
      // 才标 near_limit——到了 80% 时长就切过去，页面才有机会给追加建议。
      if (row.state === "running") {
        const active = this.accumulate(row);
        if (active >= row.limit_minutes * 60_000 * 0.8) {
          const updated = (
            await client.query(
              `update swarm_run set state='near_limit',
                 state_reason=$3, updated_at=now()
               where account_id=$1 and run_id=$2 and state='running'
               returning run_id,dossier_id,question,state,phase,round,plan_version,limit_rounds,limit_minutes,
                 active_ms,active_since,members_used,kickoff_at,lead_session,projected_seq,
                 state_reason,end_reason,delegation,started_at,ended_at`,
              [
                account,
                runId,
                `快到额度了（已用 ${Math.round(active / 60_000)} 分钟 / ${row.limit_minutes} 分钟）`,
              ],
            )
          ).rows[0] as RunRow | undefined;
          if (updated) {
            row = updated;
            await this.emitReport(client, account, runId, row.plan_version, row.state_reason);
            await this.emitRun(client, account, runId);
          }
        }
      }
      const cursor = Number(row.projected_seq ?? 0);
      const events = (
        await client.query(
          `select seq,action,payload,session_id from event
            where account_id=$1 and run_id=$2 and kind='dsh' and seq > $3
            order by seq limit 500`,
          [account, runId, cursor],
        )
      ).rows.map((row) => ({
        seq: row.seq,
        action: row.action,
        payload: row.payload,
        // pg 给的是 session_id：折算层要的是 sessionId，别在这里断了归属。
        sessionId: row.session_id ?? null,
      }));
      if (!events.length) return 0;
      const state = await loadFold(client, account, runId);
      const plan = await this.planOf(client, account, runId);
      const leadSession =
        row.lead_session ??
        (
          await client.query(
            `select session_id from dsh_session
              where account_id=$1 and dossier_id=$2 and mode='swarm'
              order by created_at desc limit 1`,
            [account, row.dossier_id],
          )
        ).rows[0]?.session_id ??
        null;
      state.leadSession = leadSession ? String(leadSession) : null;
      const context = {
        account,
        runId,
        dossierId: row.dossier_id,
        planVersion: row.plan_version,
        round: row.round,
        model: this.dependencies.model,
        leadSession: state.leadSession,
        routeIds: (plan?.routes ?? []).map((route) => route.id),
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
      // 名册上的「在干什么」按真实活动算，不按上一次采样：
      // 队员在跑工具就显示运行中，安静下来才算空闲（验收里一直是 idle 的就在这）。
      const activity = (
        await client.query(
          `select data->>'member' member, max(at) last_at
             from swarm_event where account_id=$1 and run_id=$2 and type='member_log'
            group by 1`,
          [account, runId],
        )
      ).rows;
      const lastActive = new Map<string, number>(
        activity.map((entry) => [String(entry.member), new Date(entry.last_at).getTime()]),
      );
      const live = this.dependencies.kernel.isLive(runId);
      const active = TIMED.has(run.state);
      const now = Date.now();
      const members = [...fold.members.values()];
      // 开跑前也要有负责人这一行（E5）：DSH 不给负责人成员事件，按负责人会话补上。
      if (!members.some((member) => member.id === "lead") && row.lead_session)
        members.unshift({
          id: "lead",
          role: "lead",
          label: labelOf("lead"),
          tags: [],
          model: this.dependencies.model,
          context: "fresh",
          state: live ? "running" : "idle",
          sessionId: String(row.lead_session),
        });
      for (const member of members) {
        if (member.state === "failed" || member.state === "creating") continue;
        if (member.id === "lead") {
          member.state = live ? "running" : "idle";
          continue;
        }
        const last = lastActive.get(member.id);
        const busy = active && last !== undefined && now - last < 120_000;
        member.state = busy ? "running" : member.state === "running" ? "idle" : member.state;
      }

      // 黑板：结论 + 证据 + 阶段结果（核实没接通，所以没有 verified）。
      const claims: Claim[] = await latestClaims(client, account, runId, { limit: 200 });
      const evidence: Evidence[] = await loadEvidence(client, account, runId);
      const report: SwarmReport | null = await buildReport(client, {
        account,
        runId,
        version: row.plan_version,
        stateReason: row.state_reason,
        runState: run.state,
        limits: run.limits,
        used: { rounds: run.used.rounds, activeMs: run.used.activeMs },
      });
      const reviews: Review[] = await loadReviews(client, account, runId);
      // 路线状态按最后一条 route 事件走（运行结束时会发 stopped），没有事件才用默认。
      const routeEvents = (
        await client.query(
          `select distinct on (data->>'id') data from swarm_event
            where account_id=$1 and run_id=$2 and type='route'
            order by data->>'id', seq desc`,
          [account, runId],
        )
      ).rows.map((row) => row.data as SwarmRoute);
      const knownRoutes = new Map(routeEvents.map((route) => [route.id, route]));
      const registered = await loadApproaches(client, account, runId);
      const registeredById = new Map(registered.map((route) => [route.id, route]));
      const tasksOf = (routeId: string) =>
        [...fold.tasks.values()].filter((task) => task.routeId === routeId).map((task) => task.id);
      const membersOf = (routeId: string) =>
        [...fold.members.values()]
          .filter((member) => member.tags.includes(routeId))
          .map((member) => member.id);
      const planRoutes = (plan?.routes ?? []).map((route) => {
        const settled = knownRoutes.get(route.id);
        const approach = registeredById.get(route.id);
        return {
          id: route.id,
          title: approach?.title ?? route.title,
          idea: approach?.idea || route.idea,
          approachFamily: approach?.approachFamily || route.idea.slice(0, 40),
          tags: approach?.tags ?? settled?.tags ?? [],
          state: approach?.state ?? settled?.state ?? ("active" as const),
          ...(approach?.gap ?? settled?.gap ? { gap: approach?.gap ?? settled?.gap } : {}),
          ...(approach?.blockedReason ?? settled?.blockedReason
            ? { blockedReason: approach?.blockedReason ?? settled?.blockedReason }
            : {}),
          ...(approach?.reopenReason ?? settled?.reopenReason
            ? { reopenReason: approach?.reopenReason ?? settled?.reopenReason }
            : {}),
          taskIds: tasksOf(route.id),
          memberIds: membersOf(route.id),
        };
      });
      // 插件新登记、计划里没有的路线也要出现（同义不新开，新开就是真新路线）。
      const extraRoutes = registered
        .filter((route) => !planRoutes.some((entry) => entry.id === route.id))
        .map((route) => ({
          ...route,
          taskIds: tasksOf(route.id),
          memberIds: membersOf(route.id),
        }));
      const routes = [...planRoutes, ...extraRoutes];
      return {
        run,
        plan,
        members: members.sort((a, b) => (a.role === "lead" ? -1 : b.role === "lead" ? 1 : a.id < b.id ? -1 : 1)),
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
      role?: MemberRole;
      target?: { memberId?: string; routeId?: string };
      limits?: { rounds?: number; minutes?: number };
    },
  ): Promise<{ intervention: Intervention; run: SwarmRun }> {
    if (!INTERVENTIONS_READY.includes(input.kind))
      throw new ApiFailure("INTERVENTION_UNSUPPORTED", 409, "这种干预还没接通（靠后阶段）。");
    if ((input.kind === "mention" || input.kind === "redirect") && !input.text?.trim())
      throw new ApiFailure("INTERVENTION_TEXT_REQUIRED", 400, "这句话要先写出来。");
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
      await this.emitInterventionBus(client, account, runId, intervention);
      await this.emitRun(client, account, runId);
      return intervention;
    });
    // 说话（mention）与改方向（redirect）要真的到人 / 真的改：都在事务外提交一轮。
    if (input.kind === "mention" || input.kind === "redirect") {
      let settled = intervention;
      settled = await this.dependencies.db.withAccount(account, async (client) => {
        const current = await this.row(client, account, runId);
        const target = input.target?.memberId ?? null;
        if (input.kind === "redirect")
          await client.query(
            "update swarm_run set redirect_pending=true, updated_at=now() where account_id=$1 and run_id=$2",
            [account, runId],
          );
        await client.query(
          `update swarm_intervention set state='delivered', result=$3, updated_at=now()
             where account_id=$1 and id=$2`,
          [
            account,
            intervention.id,
            input.kind === "mention"
              ? `已投递给 ${target ?? "负责人"}，等它回应。`
              : "已改方向：受影响的任务停下、旧证据保留，负责人会出新的计划版本再继续。",
          ],
        );
        const applied = (await this.interventions(client, account, runId)).find(
          (entry) => entry.id === intervention.id,
        )!;
        await this.emitSimple(client, account, runId, "intervention", applied);
        await this.emitInterventionBus(client, account, runId, applied);
        if (current.state === "paused") {
          await client.query(
            `update swarm_run set state='running', state_reason=null,
               active_since=coalesce(active_since, now()), updated_at=now()
             where account_id=$1 and run_id=$2`,
            [account, runId],
          );
        }
        await this.emitRun(client, account, runId);
        return applied;
      });
      const prompt =
        input.kind === "mention"
          ? `用户对 ${input.target?.memberId ?? "负责人"} 说：「${input.text!.trim()}」。把这句话转达给它，让它回应，再按它的回应往下做。`
          : `用户改方向：「${input.text!.trim()}」。受影响的任务停下，旧证据保留；先出新的计划版本（计划里写清改了什么），再继续往下做。`;
      await this.dependencies.kernel.submit(account, runId, { mode: "swarm", prompt }).catch(() => undefined);
      return { intervention: settled, run: await this.run(account, runId) };
    }
    if (input.kind === "add_member" || input.kind === "extend") {
      await this.dependencies.db.withAccount(account, async (client) => {
        const current = await this.row(client, account, runId);
        const members = await loadFold(client, account, runId);
        const used = members.members.size;
        const card =
          input.kind === "add_member"
            ? await createSwarmCard(client, {
                account,
                runId,
                dossierId: current.dossier_id,
                kind: "swarm_add_member" as SwarmCardKind,
                title: "中途加人",
                payload: {
                  role: input.role ?? "researcher",
                  routeId: input.target?.routeId ?? null,
                  model: this.dependencies.model,
                  count: 1,
                  membersAfter: used + 1,
                  max: MAX_MEMBERS,
                },
              })
            : await createSwarmCard(client, {
                account,
                runId,
                dossierId: current.dossier_id,
                kind: "swarm_extend" as SwarmCardKind,
                title: "临近额度，要不要追加",
                payload: {
                  findings: await this.verifiedFindings(client, account, runId),
                  gaps: await this.openGaps(client, account, runId),
                  suggest: { rounds: 2, minutes: 15 },
                  used: {
                    rounds: current.round,
                    minutes: Math.round(Number(current.active_ms ?? 0) / 60_000),
                  },
                },
              });
        await client.query(
          `update swarm_intervention set state='pending_approval', approval_id=$3,
             result=$4, updated_at=now()
           where account_id=$1 and id=$2`,
          [
            account,
            intervention.id,
            card.id,
            `等你在收件箱处理${
              cardLabel(input.kind === "add_member" ? "swarm_add_member" : "swarm_extend")
            }。`,
          ],
        );
        const pending = (await this.interventions(client, account, runId)).find(
          (entry) => entry.id === intervention.id,
        )!;
        await this.emitSimple(client, account, runId, "intervention", pending);
        await this.emitInterventionBus(client, account, runId, pending);
        await this.emitRun(client, account, runId);
      });
      return {
        intervention: await this.dependencies.db.withAccount(account, async (client) =>
          (await this.interventions(client, account, runId)).find(
            (entry) => entry.id === intervention.id,
          )!,
        ),
        run: await this.run(account, runId),
      };
    }

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
        const applied = (await this.interventions(client, account, runId)).find(
          (entry) => entry.id === intervention.id,
        )!;
        await this.emitSimple(client, account, runId, "intervention", applied);
        await this.emitInterventionBus(client, account, runId, applied);
        await this.emitRun(client, account, runId);
      });
    } else if (input.kind === "resume") {
      await this.dependencies.db.withAccount(account, async (client) => {
        await client.query(
          `update swarm_intervention set state='applied', result=$3, updated_at=now()
             where account_id=$1 and id=$2`,
          [account, intervention.id, "已继续，先核对现状再往下走。"],
        );
        const applied = (await this.interventions(client, account, runId)).find(
          (entry) => entry.id === intervention.id,
        )!;
        await this.emitSimple(client, account, runId, "intervention", applied);
        await this.emitInterventionBus(client, account, runId, applied);
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
        const applied = (await this.interventions(client, account, runId)).find(
          (entry) => entry.id === intervention.id,
        )!;
        await this.emitSimple(client, account, runId, "intervention", applied);
        await this.emitInterventionBus(client, account, runId, applied);
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
      // 用户结束：不伪装成功，但说明要按实际情况写——有已核实的就别写成「没有经过核实」。
      await this.settleTiming(client, account, row, now);
      const counts = (
        await client.query(
          `select
             count(*) filter (
               where c.verified_version = c.version and c.status='verified'
                 and c.version = (select max(c2.version) from swarm_claim c2
                                   where c2.account_id=c.account_id and c2.run_id=c.run_id and c2.id=c.id)
             )::int verified,
             count(*) filter (
               where c.version = (select max(c2.version) from swarm_claim c2
                                   where c2.account_id=c.account_id and c2.run_id=c.run_id and c2.id=c.id)
                 and c.status in ('candidate','awaiting_refute','awaiting_verify','disputed','insufficient')
             )::int pending
           from swarm_claim c where c.account_id=$1 and c.run_id=$2`,
          [account, row.run_id],
        )
      ).rows[0];
      const verifiedCount = Number(counts?.verified ?? 0);
      const pendingCount = Number(counts?.pending ?? 0);
      const reason =
        verifiedCount > 0
          ? `你结束了这次群研：已核实 ${verifiedCount} 条，另有 ${pendingCount} 条候选/有争议；已交付的产出保留。`
          : pendingCount > 0
            ? `你结束了这次群研：${pendingCount} 条结论没有通过核实，仍是候选；已交付的产出保留。`
            : "你结束了这次群研；已交付的产出保留。";
      await client.query(
        `update swarm_run set state='partial', end_reason='user_finished',
           state_reason=$3, active_since=null, ended_at=coalesce(ended_at, now()), updated_at=now()
         where account_id=$1 and run_id=$2`,
        [account, row.run_id, reason],
      );
      await this.settleTerminal(client, account, row.run_id, reason);
      return;
    }
    // stop_route：只记录决定，任务归属由负责人显式处理（DSH 中断不释放归属）。
    await client.query(
      `update swarm_run set state_reason=$3, updated_at=now() where account_id=$1 and run_id=$2`,
      [account, row.run_id, `已停止路线 ${input.target?.routeId ?? ""}：需要新机制才能重开`],
    );
  }

  /**
   * 运行结束时把四处一起收尾（E2）：名册上的人不再显示在跑，根任务和路线不再
   * 显示「开放 / 进行中」。这些是服务端算出来的状态，页面只照着显示。
   */
  async settleTerminal(
    client: pg.PoolClient,
    account: string,
    runId: string,
    reason: string,
  ): Promise<void> {
    const fold = await loadFold(client, account, runId);
    for (const member of fold.members.values()) {
      const next = { ...member, state: "idle" as const, doing: null };
      if (next.state === member.state && member.state === "idle" && !member.doing) continue;
      await this.emitSimple(client, account, runId, "member", next);
    }
    for (const task of fold.tasks.values()) {
      if (task.state === "delivered" || task.state === "stopped") continue;
      // 根任务和还在做的任务都停在「已停止」：这次群研结束了，没人再往下做。
      const next = {
        ...task,
        state: "stopped" as const,
        blockedBy: task.blockedBy ?? null,
      };
      await this.emitSimple(client, account, runId, "task", {
        ...next,
        board: next.board,
        updatedAt: new Date().toISOString(),
      });
    }
    const plan = await this.planOf(client, account, runId);
    // 路线状态的唯一真源是 swarm_approach（插件登记的那份）：收尾要落库，
    // 只推事件的话快照仍会按库里的 active 显示成「进行中」。
    await client.query(
      `update swarm_approach
         set state='stopped',
             blocked_reason=coalesce(blocked_reason, $3),
             version=version+1,
             updated_at=now()
       where account_id=$1 and run_id=$2 and state in ('active','reopened')`,
      [account, runId, "这次群研结束时，这条路线的任务还没全部交付"],
    );
    await this.emitReport(client, account, runId, (await this.row(client, account, runId)).plan_version, reason);
    const settledRoutes = await loadApproaches(client, account, runId);
    for (const route of plan?.routes ?? []) {
      const settled = settledRoutes.find((entry) => entry.id === route.id);
      await this.emitSimple(client, account, runId, "route", {
        id: route.id,
        title: route.title,
        idea: route.idea,
        approachFamily: settled?.approachFamily ?? route.idea.slice(0, 40),
        tags: settled?.tags ?? [],
        state: (settled?.state ?? "stopped") as SwarmRoute["state"],
        blockedReason: settled?.blockedReason ?? reason,
        taskIds: [...fold.tasks.values()]
          .filter((task) => task.routeId === route.id)
          .map((task) => task.id),
        memberIds: [...fold.members.values()]
          .filter((member) => member.tags.includes(route.id))
          .map((member) => member.id),
      });
    }
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
    detail?: string,
  ): Promise<{ continued: boolean }> {
    // 同一运行上还有别的回合在跑时，绝不能自己再起一回合：
    // 验收里确认与「继续」并发跑了两个回合，后一个把前一个的 handle 顶掉，
    // 「结束」就停不住团队了。谁来接下一轮，只认最后一个回合的结束。
    if (this.dependencies.kernel.isLive(runId)) return { continued: false };
    const decision = await this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId).catch(() => null);
      if (!row) return null;
      // 任何阶段这一轮真要失败，就照实标出来：不能让崩溃悄悄挂着。
      if (state === "failed") {
        // 会话读不回来不能当成「研究失败」：队伍和产出还在，标成暂停由用户决定。
        const restoreFailed = /KERNEL_SESSION_RESTORE_FAILED/.test(detail ?? "");
        const nextState = restoreFailed ? "paused" : "failed";
        const quota = /QUOTA|Insufficient Balance|insufficient_quota|402/i.test(detail ?? "");
        // 网络抖动（模型转发 fetch failed / 上游 5xx / 超时）不是研究失败：
        // 转成暂停、写清原因、保留名册与已有产出，用户点继续就能接着跑。
        const transient =
          /MODEL_UPSTREAM_UNAVAILABLE|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network|503|502|504/i.test(
            detail ?? "",
          );
        // 结算这一段的活动时长：失败也要如实记上，不能清零。
        await this.settleTiming(client, account, row);
        const state = restoreFailed || transient ? "paused" : "failed";
        const reason = restoreFailed
          ? "这一段会话读不回来，为避免重复建队没有继续；产出和名册都还在，可以稍后再试"
          : quota
            ? "模型账户额度不足（QUOTA），这一轮没法继续；已交的结论和证据都还在"
            : transient
              ? "模型服务暂时连不上（网络抖动或上游 5xx，已重试过），这一轮停在这里；恢复后点继续就能接着跑"
              : "这一轮执行失败";
        await client.query(
          `update swarm_run set state=$3, end_reason=$4, state_reason=$5, active_since=null,
             ended_at=case when $3='failed' then now() else ended_at end, updated_at=now()
           where account_id=$1 and run_id=$2`,
          [account, runId, state, state === "failed" ? "error" : null, reason],
        );
        if (state === "failed") await this.settleTerminal(client, account, runId, reason);
        await this.emitRun(client, account, runId);
        return null;
      }
      // 澄清和等确认这两段不算研究轮次：澄清没出计划就停在那里等用户；
      // 暂停 / 已结束 / 收尾中的运行不再自动续跑。
      if (row.state !== "running" && row.state !== "near_limit") return null;
      if (state === "cancelled" || state === "cancel_unconfirmed") return null;
      const fold = await loadFold(client, account, runId);
      const tasks = [...fold.tasks.values()];
      const delivered = tasks.filter((task) => task.state === "delivered").length;
      const open = tasks.length - delivered - tasks.filter((task) => task.state === "stopped").length;
      await this.settleTiming(client, account, row);
      const active = Number(
        (await client.query("select active_ms from swarm_run where account_id=$1 and run_id=$2", [account, runId]))
          .rows[0]?.active_ms ?? 0,
      );
      const outOfTime = active >= row.limit_minutes * 60_000;
      const outOfRounds = row.round >= row.limit_rounds;
      // 结论的核实情况决定「能不能收尾」：负责人交完一批（哪怕发了最终答复）但还有
      // 候选 / 待核实 / 待反驳的结论时，按 PRD §3 不满足提前收尾，由服务端推进下一轮，
      // 把这些未核实的结论当缺口交回去（用户 2026-11-03 定）。
      const claims = await latestClaims(client, account, runId, { limit: 200 });
      const pending = claims.filter(
        (claim) =>
          claim.status === "candidate" ||
          claim.status === "awaiting_refute" ||
          claim.status === "awaiting_verify" ||
          claim.status === "disputed" ||
          claim.status === "insufficient",
      );
      const verifiedCount = Number(
        (
          await client.query(
            `select count(*)::int n from swarm_claim c
              where c.account_id=$1 and c.run_id=$2
                and c.verified_version = c.version and c.status='verified'
                and c.version = (select max(c2.version) from swarm_claim c2
                                  where c2.account_id=c.account_id and c2.run_id=c.run_id and c2.id=c.id)`,
            [account, runId],
          )
        ).rows[0]?.n ?? 0,
      );
      const routes = await loadApproaches(client, account, runId);
      // PRD §3 的三种提前收尾：问题已回答且通过核实；剩余路线全阻塞且没有新机制；用户要求结束（另一条路径）。
      const answered = pending.length === 0 && (verifiedCount > 0 || claims.length > 0);
      const allBlocked =
        routes.length > 0 &&
        routes.every((route) => ["blocked", "stopped", "merged"].includes(route.state));
      if (answered || allBlocked || outOfTime || outOfRounds) {
        // 报告前还有分歧就进 awaiting_review（等人看分歧），不硬写成完成或部分完成。
        const disputed = Number(
          (
            await client.query(
              `select count(*)::int n from swarm_claim
                where account_id=$1 and run_id=$2 and version=(
                  select max(version) from swarm_claim c2
                   where c2.account_id=$1 and c2.run_id=$2 and c2.id=swarm_claim.id
                ) and status in ('disputed','falsified')`,
              [account, runId],
            )
          ).rows[0]?.n ?? 0,
        );
        // 结束说明按实际情况写：有已核实的就不能说「没有经过核实的结论」。
        const head =
          verifiedCount > 0
            ? `已核实 ${verifiedCount} 条，还有 ${pending.length} 条候选/待核实`
            : pending.length > 0
              ? `没有通过核实的结论，${pending.length} 条仍是候选或待核实`
              : "这一轮没有交出可核实的结论";
        const reason = disputed
          ? `${head}；报告前还有分歧，先看你决定按「有争议」写入还是再查一轮`
          : answered
            ? `问题已回答并通过核实（${verifiedCount} 条）`
            : allBlocked
              ? `${head}；剩余路线全部阻塞，没有实质新机制`
              : outOfTime
                ? `到达 ${row.limit_minutes} 分钟：${head}`
                : `${head}；到达 ${row.limit_rounds} 轮`;
        await client.query(
          `update swarm_run set state=$3, state_reason=$4, end_reason=$5, active_since=null,
             ended_at=case when $3='awaiting_review' then ended_at else now() end, updated_at=now()
           where account_id=$1 and run_id=$2`,
          [account, runId, disputed ? "awaiting_review" : "partial", reason, answered ? "answered" : "limit"],
        );
        if (!disputed) await this.settleTerminal(client, account, runId, reason);
        if (disputed)
          await createSwarmCard(client, {
            account,
            runId,
            dossierId: row.dossier_id,
            kind: "swarm_divergence",
            title: "报告前还有分歧",
            payload: {
              claims: (
                await latestClaims(client, account, runId, { limit: 50 })
              )
                .filter((claim) => claim.status === "disputed" || claim.status === "falsified")
                .slice(0, 8)
                .map((claim) => ({
                  id: claim.id,
                  text: claim.text.slice(0, 120),
                  sides: ["主张方", "反驳方"],
                })),
            },
          });
        await this.emitReport(client, account, runId, row.plan_version, reason);
        await this.emitRun(client, account, runId);
        return null;
      }
      // 第 1 轮还没开跑（承诺过只有一次）：先补开跑指令，不要当第二轮推进。
      if (row.round <= 1 && !row.kickoff_at) {
        await client.query(
          "update swarm_run set kickoff_at=now(), state='running', state_reason=null, active_since=coalesce(active_since, now()), updated_at=now() where account_id=$1 and run_id=$2",
          [account, runId],
        );
        await this.emitRun(client, account, runId);
        return { round: 1, kickoff: true };
      }
      // 轮次和阶段由服务端推进：前 2 轮独立，第 3 轮起交叉。
      const nextRound = row.round + 1;
      const phase = nextRound >= 3 ? "cross" : "independent";
      // 临近额度：时长到 80%，或者下一轮就是最后一轮，都算「快到额度」。
      // 进 near_limit 后仍在跑，报告里给追加建议（PRD §3）。
      const near =
        active >= row.limit_minutes * 60_000 * 0.8 || nextRound >= row.limit_rounds;
      await client.query(
        `update swarm_run set round=$3, phase=$4, state=$5, state_reason=$6,
           active_since=now(), updated_at=now()
         where account_id=$1 and run_id=$2`,
        [
          account,
          runId,
          nextRound,
          phase,
          near ? "near_limit" : "running",
          near ? `快到额度了（已用 ${Math.round(active / 60_000)} 分钟 / ${row.limit_minutes} 分钟）` : null,
        ],
      );
      await this.emitReport(client, account, runId, row.plan_version, row.state_reason);
      await this.emitRun(client, account, runId);
      return {
        round: nextRound,
        kickoff: false,
        phase,
        // 未核实的结论当缺口交给负责人：只给 id、一句话和状态，不教它怎么分轮。
        gaps: pending.slice(0, 12).map((claim) => ({
          id: claim.id,
          status: claim.status,
          text: claim.text.slice(0, 120),
        })),
      };
    });
    if (!decision) return { continued: false };
    // 第 1 轮是开跑（要带上计划与编制）；第 3 轮起附精简的 Context Packet。
    const packet = decision.kickoff
      ? ""
      : await this.dependencies.db.withAccount(account, (client) =>
          decision.round >= 3 ? contextPacket(client, { account, runId }) : Promise.resolve(""),
        );
    const gapLines =
      decision.gaps && decision.gaps.length
        ? [
            "这些结论还没有通过独立核实，是这一批要补的缺口（补齐后才算交付）：",
            ...decision.gaps.map(
              (gap, index) =>
                `${index + 1}. [${gap.status}] ${gap.text}（${gap.id}）`,
            ),
            "已经核实的不必重做；也不要重复已经交付过的结果。",
          ].join("\n")
        : "";
    const prompt = decision.kickoff
      ? kickoffPrompt(
          await this.dependencies.db.withAccount(account, (client) =>
            this.planOf(client, account, runId),
          ),
        )
      : ["继续推进这一批任务。先看任务板还有哪些没交付，把没人做的分给队员，收齐之后再综合。", gapLines, packet]
          .filter(Boolean)
          .join("\n\n");
    await this.dependencies.kernel
      .submit(account, runId, { mode: "swarm", prompt })
      .catch(() => undefined);
    return { continued: true };
  }

  /**
   * 收件箱里群研卡的决定（契约 §5）。不是群研卡就返回 null，交回原来的审批流程。
   * 批准 = 真的做下去（加人 / 追加额度 / 接受扩大范围 / 再查一轮），驳回 = 收尾或维持原样。
   */
  async decideCard(
    account: string,
    approvalId: string,
    body: { decision?: unknown; answers?: unknown },
  ): Promise<{ state: string; runId: string; note: string } | null> {
    const decision = body.decision === "reject" ? "reject" : "approve";
    const answers =
      body.answers && typeof body.answers === "object"
        ? (body.answers as Record<string, unknown>)
        : {};
    const card = await this.dependencies.db.withAccount(account, (client) =>
      readSwarmCard(client, account, approvalId),
    );
    if (!card) return null;
    if (card.state !== "pending")
      throw new ApiFailure("APPROVAL_CONFLICT", 409, `这张${cardLabel(card.kind)}已经处理过了，请刷新。`);

    if (card.kind === "swarm_divergence") {
      // 批准 = 再查一轮；驳回 = 按「有争议」写入报告。
      await this.dependencies.db.withAccount(account, async (client) => {
        await client.query(
          "update approval set state=$3, decided_at=now(), decided_scope='once' where account_id=$1 and id=$2",
          [account, approvalId, decision === "approve" ? "approved" : "rejected"],
        );
        await this.closeInterventionForCard(client, account, approvalId);
      });
      if (decision === "approve") {
        await this.dependencies.db.withAccount(account, async (client) => {
          const row = await this.row(client, account, card.runId);
          await client.query(
            `update swarm_run set state='running', state_reason=null, end_reason=null, ended_at=null,
               round=round+1, phase=case when round+1 >= 3 then 'cross' else phase end,
               active_since=now(), updated_at=now()
             where account_id=$1 and run_id=$2`,
            [account, row.run_id],
          );
          await this.emitRun(client, account, row.run_id);
        });
        await this.dependencies.kernel
          .submit(account, card.runId, {
            mode: "swarm",
            prompt: `用户希望把分歧再查一轮。先看还有哪些结论停留在「有争议」，针对它们继续找证据或改主张，再重新核实一遍。`,
          })
          .catch(() => undefined);
        return { state: "approved", runId: card.runId, note: "已再查一轮。" };
      }
      return { state: "rejected", runId: card.runId, note: "按「有争议」写入报告，不再查。" };
    }

    await this.dependencies.db.withAccount(account, async (client) => {
      await client.query(
        "update approval set state=$3, decided_at=now(), decided_scope='once' where account_id=$1 and id=$2",
        [account, approvalId, decision === "approve" ? "approved" : "rejected"],
      );
      await this.closeInterventionForCard(client, account, approvalId);
      const row = await this.row(client, account, card.runId);
      if (decision === "reject") {
        await this.emitSimple(client, account, card.runId, "bus", {
          seq: 0,
          at: new Date().toISOString(),
          type: "system",
          from: "system",
          to: "user",
          text: `（${cardLabel(card.kind)}已驳回，维持原样。）`,
          refs: {},
        } satisfies BusEntry);
      } else if (card.kind === "swarm_extend") {
        // 追加额度：按卡上的建议或用户在 answers 里改的数值延长，然后继续。
        const suggest = (card.payload.suggest ?? {}) as { rounds?: number; minutes?: number };
        const rounds = Math.max(1, Number(answers.rounds ?? suggest.rounds ?? 2));
        const minutes = Math.max(5, Number(answers.minutes ?? suggest.minutes ?? 15));
        await client.query(
          `update swarm_run set limit_rounds=limit_rounds+$3, limit_minutes=limit_minutes+$4,
             state='running', state_reason=null, end_reason=null, ended_at=null,
             active_since=coalesce(active_since, now()), updated_at=now()
           where account_id=$1 and run_id=$2`,
          [account, card.runId, rounds, minutes],
        );
        await this.emitSimple(client, account, card.runId, "bus", {
          seq: 0,
          at: new Date().toISOString(),
          type: "system",
          from: "system",
          to: "user",
          text: `（已追加 ${rounds} 轮 / ${minutes} 分钟，继续往下做。）`,
          refs: {},
        } satisfies BusEntry);
        await this.emitRun(client, account, card.runId);
      } else if (card.kind === "swarm_add_member") {
        await this.emitSimple(client, account, card.runId, "bus", {
          seq: 0,
          at: new Date().toISOString(),
          type: "system",
          from: "system",
          to: "user",
          text: "（加人已批准，负责人会按卡的设置补一名队员。）",
          refs: {},
        } satisfies BusEntry);
      } else if (card.kind === "swarm_scope") {
        // 扩大范围获批：计划已经由负责人交上来了，这里只负责让它继续。
        await client.query(
          `update swarm_run set state='running', state_reason=null, end_reason=null, ended_at=null,
             active_since=coalesce(active_since, now()), updated_at=now()
           where account_id=$1 and run_id=$2`,
          [account, row.run_id],
        );
        await this.emitRun(client, account, row.run_id);
      }
    });

    if (decision === "approve") {
      const prompt =
        card.kind === "swarm_extend"
          ? "用户批准追加额度，继续往下做：先把还没核实的结论补齐，再更新汇总。"
          : card.kind === "swarm_add_member"
            ? `用户批准加人（${
                (card.payload.role as string) ?? "researcher"
              }${card.payload.routeId ? "，路线 " + String(card.payload.routeId) : ""}）。用 research_spawn 建一名新队员，派给还没做完的部分。`
            : "扩大范围已获批准，按新版本计划继续。";
      await this.dependencies.kernel
        .submit(account, card.runId, { mode: "swarm", prompt })
        .catch(() => undefined);
      return { state: "approved", runId: card.runId, note: `已批准${cardLabel(card.kind)}，继续往下做。` };
    }
    return { state: "rejected", runId: card.runId, note: `已驳回${cardLabel(card.kind)}。` };
  }

  /** 卡一决定，就把发起它的那条干预收到终态。 */
  private async closeInterventionForCard(
    client: pg.PoolClient,
    account: string,
    approvalId: string,
  ): Promise<void> {
    const row = (
      await client.query(
        `update swarm_intervention set state='applied', updated_at=now()
          where account_id=$1 and approval_id=$2 and state='pending_approval'
          returning id,run_id`,
        [account, approvalId],
      )
    ).rows[0];
    if (!row) return;
    const updated = (await this.interventions(client, account, String(row.run_id))).find(
      (entry) => entry.id === String(row.id),
    );
    if (updated) await this.emitSimple(client, account, String(row.run_id), "intervention", updated);
  }

  /** 已核实结论的原文（追加卡上「新发现」用）。 */
  private async verifiedFindings(
    client: pg.PoolClient,
    account: string,
    runId: string,
    limit = 5,
  ): Promise<string[]> {
    const rows = (
      await client.query(
        `select c.text from swarm_claim c
          where c.account_id=$1 and c.run_id=$2 and c.verified_version=c.version and c.status='verified'
            and c.version = (select max(c2.version) from swarm_claim c2
                              where c2.account_id=c.account_id and c2.run_id=c.run_id and c2.id=c.id)
          order by c.created_at limit $3`,
        [account, runId, limit],
      )
    ).rows;
    return rows.map((row) => String(row.text).slice(0, 120));
  }

  /** 还没解决的缺口：未核实的结论 + 路线自己记的缺口（合并说明不算缺口）。 */
  private async openGaps(
    client: pg.PoolClient,
    account: string,
    runId: string,
    limit = 6,
  ): Promise<string[]> {
    const claims = await latestClaims(client, account, runId, { limit: 200 });
    const pending = claims
      .filter((claim) =>
        ["candidate", "awaiting_refute", "awaiting_verify", "disputed", "insufficient"].includes(
          claim.status,
        ),
      )
      .map((claim) => `${claim.status}：${claim.text.slice(0, 80)}`);
    const routes = await loadApproaches(client, account, runId);
    const routeGaps = routes
      .filter((route) => route.state !== "merged")
      .map((route) => route.gap ?? route.blockedReason)
      .filter((text): text is string => typeof text === "string" && text.trim() !== "")
      .map((text) => text.slice(0, 80));
    return [...new Set([...pending, ...routeGaps])].slice(0, limit);
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
      const withSeq = {
        ...(type === "member_log" ? { at: new Date().toISOString() } : {}),
        ...(data as Record<string, unknown>),
        seq,
      };
      await client.query(
        "update swarm_event set data=$3 where account_id=$1 and run_id=$2 and seq=$4",
        [account, runId, JSON.stringify(withSeq), seq],
      );
    }
    return seq;
  }

  /** 干预落一条通信：通信面和对话框看到的是同一条回执。 */
  private async emitInterventionBus(
    client: pg.PoolClient,
    account: string,
    runId: string,
    intervention: Intervention,
  ) {
    const labels: Partial<Record<Intervention["kind"], string>> = {
      pause: "暂停了这次群研",
      resume: "继续这次群研",
      finish: "结束了这次群研",
      stop_route: `停止路线${intervention.target?.routeId ? " " + intervention.target.routeId : ""}`,
      mention: `@${intervention.target?.memberId ?? "队员"}`,
      redirect: "改了研究方向",
      add_member: "要求加人",
      extend: "追加额度",
    };
    const text = labels[intervention.kind] ?? intervention.kind;
    await this.emitSimple(client, account, runId, "bus", {
      seq: 0,
      at: new Date().toISOString(),
      type: "system",
      from: "user",
      to: intervention.target?.memberId ?? "lead",
      text: `${text}（${intervention.state}）${intervention.result ? "：" + intervention.result : ""}`,
      refs: { interventionId: intervention.id },
    } satisfies BusEntry);
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

  /**
   * 插件登记研究语义（B3）：任务挂哪条路线、父任务是谁、成员是什么角色和显示名。
   * 登记完立刻把当前那条成员/任务重发一遍，页面不用等下一次任务变化。
   */
  async registerMeta(
    account: string,
    runId: string,
    input: { kind: "task" | "member"; refId: string; data: Record<string, unknown> },
  ): Promise<{ ok: true }> {
    if (input.kind !== "task" && input.kind !== "member")
      throw new ApiFailure("INVALID_INPUT", 400, "只能登记任务或成员。");
    return this.dependencies.db.withAccount(account, async (client) => {
      await this.row(client, account, runId);
      await client.query(
        `insert into swarm_meta(account_id,run_id,kind,ref_id,data) values($1,$2,$3,$4,$5)
         on conflict (account_id,run_id,kind,ref_id) do update set data=swarm_meta.data || excluded.data`,
        [account, runId, input.kind, input.refId, JSON.stringify(input.data)],
      );
      const fold = await loadFold(client, account, runId);
      if (input.kind === "member") {
        const member = fold.members.get(input.refId);
        const role = typeof input.data.role === "string" ? (input.data.role as SwarmMember["role"]) : member?.role;
        const routeId = typeof input.data.routeId === "string" ? input.data.routeId : null;
        const label =
          typeof input.data.label === "string" && input.data.label.trim() !== ""
            ? input.data.label
            : member?.label ?? (role ? labelOf(input.refId, role) : labelOf(input.refId));
        if (member && role) {
          await this.emitSimple(client, account, runId, "member", {
            ...member,
            role,
            label,
            tags: routeId ? [routeId] : member.tags,
          } satisfies SwarmMember);
        }
      } else {
        const task = fold.tasks.get(input.refId);
        const kinds = new Set([
          "root",
          "route",
          "research",
          "review",
          "verify",
          "synthesis",
          "other",
        ]);
        const kind =
          typeof input.data.kind === "string" && kinds.has(input.data.kind)
            ? (input.data.kind as SwarmTask["kind"])
            : task?.kind;
        if (task) {
          await this.emitSimple(client, account, runId, "task", {
            ...task,
            kind: kind ?? task.kind,
            routeId:
              typeof input.data.routeId === "string" ? input.data.routeId : task.routeId,
            parentId:
              typeof input.data.parentId === "string" ? input.data.parentId : task.parentId,
            updatedAt: new Date().toISOString(),
          } satisfies SwarmTask);
        }
      }
      return { ok: true } as const;
    });
  }

  // ── 黑板：提交 / 查询 / 路线登记 ────────────────────

  /** 成员的研究身份：名字 → 角色与路线（插件建人时登记过）。 */
  private async memberOf(
    client: pg.PoolClient,
    account: string,
    runId: string,
    name: string,
  ): Promise<{ id: string; role: MemberRole; routeId: string | null }> {
    if (name === "lead") return { id: "lead", role: "lead", routeId: null };
    const meta = (
      await client.query(
        "select data from swarm_meta where account_id=$1 and run_id=$2 and kind='member' and ref_id=$3",
        [account, runId, name],
      )
    ).rows[0]?.data as { role?: string; routeId?: string | null } | undefined;
    const fold = await loadFold(client, account, runId);
    const member = fold.members.get(name);
    if (!meta && !member)
      throw new ApiFailure("MEMBER_NOT_FOUND", 404, `名单里没有「${name}」这名队员。`);
    const role = (meta?.role as MemberRole | undefined) ?? member?.role ?? "researcher";
    return {
      id: name,
      role,
      routeId: meta?.routeId ?? member?.tags?.[0] ?? null,
    };
  }

  /**
   * 提交（research_submit）：先落库再完成任务。按 submission_id 幂等，重试不会记两遍。
   * 结论必须引用至少一条证据，或者写成负结果（找过什么、没找到什么）。
   */
  async submitResearch(
    account: string,
    runId: string,
    input: {
      kind?: unknown;
      submissionId?: unknown;
      member?: unknown;
      taskId?: unknown;
      routeId?: unknown;
      claim?: unknown;
      negative?: unknown;
      text?: unknown;
      evidence?: unknown;
      post?: unknown;
      answerTo?: unknown;
    },
  ): Promise<SubmissionResult> {
    const kind = typeof input.kind === "string" ? input.kind : "";
    if (!["claim", "negative", "evidence", "question", "answer", "help", "decision"].includes(kind))
      throw new ApiFailure(
        "SUBMIT_KIND_INVALID",
        400,
        "提交类型只能是 claim / negative / evidence / question / answer / help / decision。",
      );
    const submissionId =
      typeof input.submissionId === "string" && input.submissionId.trim() !== ""
        ? input.submissionId.trim().slice(0, 200)
        : randomUUID();
    const memberName =
      typeof input.member === "string" && input.member.trim() !== "" ? input.member.trim() : "lead";
    return this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId);
      // 幂等：同一份产出重试时原样返回第一次的结果。
      const repeated = await findSubmission(client, account, runId, submissionId);
      if (repeated) return repeated;
      if (TERMINAL.has(row.state))
        throw new ApiFailure("RUN_ENDED", 409, "这次群研已经结束，不再接收提交。");
      const member = await this.memberOf(client, account, runId, memberName);
      const taskId = typeof input.taskId === "string" ? input.taskId : null;
      const fold = await loadFold(client, account, runId);
      const task = taskId ? fold.tasks.get(taskId) : undefined;
      const routeId =
        (typeof input.routeId === "string" ? input.routeId : null) ??
        member.routeId ??
        task?.routeId ??
        null;

      const result: SubmissionResult = {
        submissionId,
        claimIds: [],
        evidenceIds: [],
        postIds: [],
      };

      // 1) 证据先落库（同来源 + 同版本 + 同定位只记一条，引用关系另记）。
      const evidenceInput = Array.isArray(input.evidence)
        ? input.evidence
        : input.evidence
          ? [input.evidence]
          : [];
      if (evidenceInput.length > MAX_EVIDENCE_PER_SUBMISSION)
        throw new ApiFailure("EVIDENCE_TOO_MANY", 400, "一次最多交 20 条证据。");
      for (const raw of evidenceInput) {
        const parsed = readEvidence(raw);
        const stored = await putEvidence(client, {
          account,
          runId,
          submissionId,
          evidence: parsed,
        });
        result.evidenceIds.push(stored.id);
        if (stored.created)
          await this.emitSimple(client, account, runId, "evidence", stored.evidence);
      }

      // 2) 结论（或负结果）：要么引用证据，要么是负结果。
      if (kind === "claim" || kind === "negative") {
        const claimInput =
          kind === "negative"
            ? readClaim({
                ...(input.claim as Record<string, unknown> | undefined),
                text:
                  (input.claim as Record<string, unknown> | undefined)?.text ??
                  input.text ??
                  "负结果：这一路没有找到能支撑结论的证据",
                negative:
                  (input.claim as Record<string, unknown> | undefined)?.negative ?? input.negative,
              })
            : readClaim(input.claim);
        if (claimInput.negative && !result.evidenceIds.length) claimInput.negative = claimInput.negative;
        const stored = await putClaim(client, {
          account,
          runId,
          submissionId,
          member: member.id,
          taskId,
          routeId,
          round: row.round,
          claim: claimInput,
          evidenceIds: result.evidenceIds,
        });
        result.claimIds.push(stored.claim.id);
        await this.emitSimple(client, account, runId, "claim", stored.claim);
        await this.emitSimple(client, account, runId, "bus", {
          seq: 0,
          at: new Date().toISOString(),
          type: "deliver",
          from: member.id,
          to: "board",
          text: `交了结论：${claimInput.text.slice(0, 120)}`,
          refs: { claimId: stored.claim.id, ...(taskId ? { taskId } : {}) },
        } satisfies BusEntry);
      }

      // 3) 留言板四栏：问题 / 求助 / 决定 / 回答落到一条 BoardPost。
      if (kind === "question" || kind === "help" || kind === "decision" || kind === "answer") {
        const postInput = obj(input.post);
        const body = String(postInput.text ?? input.text ?? "").trim();
        if (!body) throw new ApiFailure("POST_TEXT_REQUIRED", 400, "留言要有正文。");
        const col =
          kind === "answer" ? "question" : (kind as "question" | "help" | "decision");
        const postId = randomUUID();
        const answerTo = typeof input.answerTo === "string" ? input.answerTo : null;
        await client.query(
          `insert into swarm_post(id,account_id,run_id,dossier_id,col,author,body,recipient,reply_to,refs)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            postId,
            account,
            runId,
            row.dossier_id,
            col,
            member.id,
            body.slice(0, 8000),
            typeof postInput.to === "string" ? postInput.to : null,
            answerTo,
            JSON.stringify({
              ...(taskId ? { taskId } : {}),
              ...(routeId ? { routeId } : {}),
            }),
          ],
        );
        if (answerTo)
          await client.query(
            "update swarm_post set answered=true where account_id=$1 and id=$2",
            [account, answerTo],
          );
        result.postIds.push(postId);
        const post = (await this.posts(client, account, runId)).find((entry) => entry.id === postId);
        if (post) await this.emitSimple(client, account, runId, "post", post);
        await this.emitSimple(client, account, runId, "bus", {
          seq: 0,
          at: new Date().toISOString(),
          type: kind === "question" ? "ask" : kind === "help" ? "help" : kind === "decision" ? "broadcast" : "deliver",
          from: member.id,
          to: kind === "decision" ? "board" : (post?.to ?? "board"),
          text: body.slice(0, 200),
          refs: { postId, ...(taskId ? { taskId } : {}) },
        } satisfies BusEntry);
      }

      await recordSubmission(client, {
        account,
        runId,
        submissionId,
        member: member.id,
        kind,
        result,
      });
      await this.emitReport(client, account, runId, row.plan_version, row.state_reason);
      await this.emitRun(client, account, runId);
      return result;
    });
  }

  /**
   * 审查（research_review_claim）：反驳 / 补证据 / 独立核实 / 降级。
   * 审查者自己的证据先落库，再落 review，最后按规则改结论状态；推 review 与 claim 两条事件。
   */
  async reviewResearch(
    account: string,
    runId: string,
    input: {
      member?: unknown;
      claimId?: unknown;
      claimVersion?: unknown;
      kind?: unknown;
      verdict?: unknown;
      reason?: unknown;
      evidence?: unknown;
      evidenceIds?: unknown;
      taskId?: unknown;
      submissionId?: unknown;
    },
  ): Promise<{ review: Review; claim: Claim }> {
    const memberName =
      typeof input.member === "string" && input.member.trim() !== "" ? input.member.trim() : "lead";
    const submissionId =
      typeof input.submissionId === "string" && input.submissionId.trim() !== ""
        ? input.submissionId.trim().slice(0, 200)
        : randomUUID();
    return this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId);
      const repeated = await findSubmission(client, account, runId, submissionId);
      if (repeated && repeated.reviewId) {
        const claim = await loadClaim(client, account, runId, repeated.claimIds[0] ?? "");
        return {
          review: (await loadReviews(client, account, runId, { claimId: claim.id })).slice(-1)[0],
          claim,
        };
      }
      if (TERMINAL.has(row.state))
        throw new ApiFailure("RUN_ENDED", 409, "这次群研已经结束，不再接收审查。");
      const member = await this.memberOf(client, account, runId, memberName);
      // 审查者自己的证据（核实必须带）先落库。
      const evidenceInput = Array.isArray(input.evidence)
        ? input.evidence
        : input.evidence
          ? [input.evidence]
          : [];
      const evidenceIds: string[] = Array.isArray(input.evidenceIds)
        ? input.evidenceIds.map(String)
        : [];
      for (const raw of evidenceInput) {
        const parsed = readEvidence(raw);
        const stored = await putEvidence(client, { account, runId, submissionId, evidence: parsed });
        evidenceIds.push(stored.id);
        if (stored.created) await this.emitSimple(client, account, runId, "evidence", stored.evidence);
      }
      const reviewInput = readReview({
        claimId: input.claimId,
        claimVersion: input.claimVersion,
        kind: input.kind,
        verdict: input.verdict,
        reason: input.reason,
        evidenceIds,
        taskId: input.taskId,
      });
      const outcome = await reviewClaim(client, {
        account,
        runId,
        member: member.id,
        round: row.round,
        submissionId,
        review: reviewInput,
      });
      await recordSubmission(client, {
        account,
        runId,
        submissionId,
        member: member.id,
        kind: `review:${reviewInput.kind}`,
        result: {
          submissionId,
          claimIds: [outcome.claim.id],
          evidenceIds,
          postIds: [],
          reviewId: outcome.review.id,
        } satisfies SubmissionResult,
      });
      await this.emitSimple(client, account, runId, "review", outcome.review);
      await this.emitSimple(client, account, runId, "claim", outcome.claim);
      await this.emitSimple(client, account, runId, "bus", {
        seq: 0,
        at: new Date().toISOString(),
        type: reviewInput.kind === "verify" ? "verify" : reviewInput.kind === "refute" ? "refute" : "deliver",
        from: member.id,
        to: "board",
        text:
          reviewInput.kind === "verify"
            ? `核实了「${outcome.claim.text.slice(0, 60)}」：${reviewInput.verdict}`
            : reviewInput.kind === "refute"
              ? `反驳「${outcome.claim.text.slice(0, 60)}」：${reviewInput.reason.slice(0, 60)}`
              : `${reviewInput.kind}：${outcome.claim.text.slice(0, 60)}`,
        refs: { claimId: outcome.claim.id, reviewId: outcome.review.id },
      } satisfies BusEntry);
      await this.emitReport(client, account, runId, row.plan_version, row.state_reason);
      await this.emitRun(client, account, runId);
      return { review: outcome.review, claim: outcome.claim };
    });
  }

  /**
   * 查询（research_query）：按角色 / 路线 / 任务 / 版本增量读。
   * 独立阶段（前 2 轮）研究员只能看到自己那条路线的结论——服务端裁，不靠前端隐藏。
   */
  async queryResearch(
    account: string,
    runId: string,
    input: {
      member?: unknown;
      routeId?: unknown;
      taskId?: unknown;
      sinceVersion?: unknown;
      sinceSeq?: unknown;
      limit?: unknown;
      include?: unknown;
    },
  ): Promise<{
    phase: "independent" | "cross";
    scope: string;
    claims: Claim[];
    evidence: Evidence[];
    posts: BoardPost[];
    routes: SwarmRoute[];
    truncated: boolean;
  }> {
    return this.dependencies.db.withAccountSnapshot(account, async (client) => {
      const row = await this.row(client, account, runId);
      const memberName =
        typeof input.member === "string" && input.member.trim() !== ""
          ? input.member.trim()
          : "lead";
      const member = await this.memberOf(client, account, runId, memberName);
      const phase: "independent" | "cross" = row.round <= 2 ? "independent" : "cross";
      const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100);
      // 独立阶段：研究员只看自己路线；反驳 / 核实 / 负责人看全部（他们本来就要审）。
      const scopedRoutes =
        phase === "independent" && member.role === "researcher"
          ? [member.routeId ?? "__none__"]
          : null;
      const claims = await latestClaims(client, account, runId, {
        routeId: typeof input.routeId === "string" ? input.routeId : null,
        taskId: typeof input.taskId === "string" ? input.taskId : null,
        routes: scopedRoutes,
        sinceVersion: Number.isFinite(Number(input.sinceVersion))
          ? Number(input.sinceVersion)
          : undefined,
        limit: limit + 1,
      });
      const truncated = claims.length > limit;
      const page = claims.slice(0, limit);
      const evidenceIds = [...new Set(page.flatMap((claim) => claim.evidenceIds))];
      const evidence = await loadEvidence(client, account, runId, evidenceIds);
      const posts = (await this.posts(client, account, runId)).filter((post) =>
        scopedRoutes
          ? !post.refs.routeId || scopedRoutes.includes(post.refs.routeId)
          : true,
      );
      const routes = await loadApproaches(client, account, runId);
      return {
        phase,
        scope:
          scopedRoutes === null
            ? "all-routes"
            : `route:${member.routeId ?? "none"}（独立阶段只给自己这条路线）`,
        claims: page,
        evidence,
        posts,
        routes,
        truncated,
      };
    });
  }

  /** 登记路线（research_register_approach）：同义不新开；标阻塞要写原因；重开要写新机制。 */
  async registerApproach(
    account: string,
    runId: string,
    input: unknown,
  ): Promise<{ route: SwarmRoute; created: boolean }> {
    const approach = readApproach(input);
    return this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId);
      const stored = await putApproach(client, { account, runId, approach });
      const fold = await loadFold(client, account, runId);
      const route: SwarmRoute = {
        ...stored.route,
        taskIds: [...fold.tasks.values()]
          .filter((task) => task.routeId === stored.route.id)
          .map((task) => task.id),
        memberIds: [...fold.members.values()]
          .filter((member) => member.tags.includes(stored.route.id))
          .map((member) => member.id),
      };
      await this.emitSimple(client, account, runId, "route", route);
      await this.emitSimple(client, account, runId, "bus", {
        seq: 0,
        at: new Date().toISOString(),
        type: "broadcast",
        from: "lead",
        to: "board",
        text:
          stored.route.state === "blocked"
            ? `路线 ${stored.route.id} 标阻塞：${stored.route.blockedReason ?? stored.route.gap ?? "缺口未写"}`
            : stored.route.reopenReason
              ? `路线 ${stored.route.id} 重新开放：${stored.route.reopenReason}`
              : `${stored.created ? "新路线" : "更新路线"} ${stored.route.id}：${stored.route.title}`,
        refs: {},
      } satisfies BusEntry);
      await this.emitReport(client, account, runId, row.plan_version, row.state_reason);
      await this.emitRun(client, account, runId);
      return { route, created: stored.created };
    });
  }

  /** 结论详情：结论 + 它引用的证据 + 来自哪个任务、哪个队员。 */
  async claimDetail(account: string, runId: string, claimId: string, version?: number) {
    return this.dependencies.db.withAccountSnapshot(account, async (client) => {
      await this.row(client, account, runId);
      const claim = await loadClaim(client, account, runId, claimId, version);
      const evidenceIds = await claimEvidenceIds(client, account, runId, claim.id, claim.version);
      const evidence = await loadEvidence(client, account, runId, evidenceIds);
      const reviews = await loadReviews(client, account, runId, { claimId: claim.id });
      const fold = await loadFold(client, account, runId);
      const task = claim.taskId ? fold.tasks.get(claim.taskId) : undefined;
      const member = fold.members.get(claim.author);
      const meta =
        claim.author === "lead"
          ? null
          : ((
              await client.query(
                "select data from swarm_meta where account_id=$1 and run_id=$2 and kind='member' and ref_id=$3",
                [account, runId, claim.author],
              )
            ).rows[0]?.data as { role?: string; label?: string | null } | undefined);
      const role = (meta?.role as MemberRole | undefined) ?? member?.role ?? "researcher";
      return {
        claim: { ...claim, evidenceIds, reviews: reviews.map((review) => review.id) },
        evidence,
        reviews,
        task: task
          ? { id: task.id, title: task.title, state: task.state, routeId: task.routeId }
          : null,
        member:
          claim.author === "lead"
            ? { id: "lead", label: "负责人", role: "lead" as const }
            : {
                id: claim.author,
                label: meta?.label ?? member?.label ?? labelOf(claim.author, role),
                role,
              },
      };
    });
  }

  /** 证据详情：证据 + 哪几条结论引用了它。 */
  async evidenceDetail(account: string, runId: string, evidenceId: string) {
    return this.dependencies.db.withAccountSnapshot(account, async (client) => {
      await this.row(client, account, runId);
      const rows = await loadEvidence(client, account, runId, [evidenceId]);
      const evidence = rows[0];
      if (!evidence) throw new ApiFailure("EVIDENCE_NOT_FOUND", 404, "这条证据不存在。");
      const links = (
        await client.query(
          `select c.id, c.version, c.text from swarm_claim_evidence l
             join swarm_claim c
               on c.account_id=l.account_id and c.run_id=l.run_id
              and c.id=l.claim_id and c.version=l.claim_version
            where l.account_id=$1 and l.run_id=$2 and l.evidence_id=$3
            order by c.created_at desc limit 50`,
          [account, runId, evidenceId],
        )
      ).rows;
      return {
        evidence,
        referencedBy: links.map((row) => ({
          claimId: String(row.id),
          claimVersion: Number(row.version),
          text: String(row.text),
        })),
      };
    });
  }

  /**
   * 阶段结果事件（契约 §3 的 report）：候选集合、负结果、缺口或来源变了才推，
   * 页面不用等刷新。和上一条一样就不推，避免每条提交都刷一帧。
   */
  private async emitReport(
    client: pg.PoolClient,
    account: string,
    runId: string,
    version: number,
    stateReason: string | null,
  ): Promise<boolean> {
    const report = await buildReport(client, { account, runId, version, stateReason });
    const signature = JSON.stringify({
      state: report.state,
      verified: report.verified,
      unverified: report.unverified,
      negative: report.negative,
      gaps: report.gaps,
      sources: report.sources,
    });
    const previous = (
      await client.query(
        `select data from swarm_event
          where account_id=$1 and run_id=$2 and type='report'
          order by seq desc limit 1`,
        [account, runId],
      )
    ).rows[0]?.data as SwarmReport | undefined;
    if (
      previous &&
      JSON.stringify({
        state: previous.state,
        verified: previous.verified,
        unverified: previous.unverified,
        negative: previous.negative,
        gaps: previous.gaps,
        sources: previous.sources,
      }) === signature
    )
      return false;
    await this.emitSimple(client, account, runId, "report", report);
    return true;
  }

  /** 阶段结果（汇总面）：核实没接通，所以 verified 为空、候选全放 unverified。 */
  async report(account: string, runId: string): Promise<SwarmReport> {
    await this.project(account, runId);
    return this.dependencies.db.withAccountSnapshot(account, async (client) => {
      const row = await this.row(client, account, runId);
      const run = await this.runOf(client, account, runId);
      return buildReport(client, {
        account,
        runId,
        version: row.plan_version,
        stateReason: row.state_reason,
        runState: run.state,
        limits: run.limits,
        used: { rounds: run.used.rounds, activeMs: run.used.activeMs },
      });
    });
  }

  /** 内核把队员记录上报过来时落到同一条事件流（members/:id/log 读它）。 */
  async reportMemberLog(
    account: string,
    runId: string,
    item: { member: string; to?: string | null } & MemberLogItem,
  ): Promise<{ seq: number | null }> {
    return this.dependencies.db.withAccount(account, async (client) => {
      const row = await this.row(client, account, runId);
      // 队员发出的消息只记进它自己的工作记录：通信面按「收件人会话里那一份」记一条，
      // 不然同一条消息会既出现「已发出」又出现「已收到」（验收里的 E3 余下项）。
      if (item.kind === "message_out") {
        const seq = await this.emitSimple(client, account, runId, "member_log", {
          ...item,
          to: undefined,
        });
        return { seq };
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
    "建人用 research_spawn（不要直接 spawn_teammate）：写清 role、跟的 route_id、label；研究员一律 fresh。",
    "建任务用 research_task（不要直接 team_task_create）：写清 kind、route_id、parent_id，有依赖写 blocked_by。",
    "这样页面上的路线卡、任务树和名册才对得上；靠描述里写 route= 是不算数的。",
    "一个研究员只跟一条路线，三条路线不要用同一种做法；反驳和核实读别人的产出用 research_files 的读。",
    "每条结论都用 research_submit 交到黑板：结论要引用至少一条证据（来源 + 章节/表号 + 原文摘句），没有证据就写成负结果。",
    "候选结论要有人独立反驳、另一个人独立核实（用 research_review_claim）：核实要自己回原文核、把核到的证据一起交上来，不能只复述反驳意见，也不能核自己交的结论。",
    "只把东西写进自己的 notes.md 不算交付——黑板和任务板都要动，页面才看得见；问题和求助也用 research_submit 发。",
    `这次额度是 ${rounds} 轮、${plan?.limits.minutes ?? MIN_MINUTES} 分钟。用 wait_agent 收齐产出，不要停下来等用户。`,
    "队员要用 research_files 在 team/<队员名>/ 里写自己的记录（目录会自己建出来）；不要读写别人的目录。",
    "根任务不要放进别的任务的 blocked_by：它不会被完成，团队会被自己卡死。",
    "收齐之后把哪些做了、哪些没做、还缺什么讲清楚；没有核实过的结论只说「候选」。",
  ]
    .filter(Boolean)
    .join("\n");
}
