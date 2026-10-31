import { createHash } from "node:crypto";
import { z } from "zod";
import type { Hono } from "hono";
import type { JsonValue } from "@reinlab/contracts";
import type { Database } from "../db/database";
import { reconcileAccount } from "../kernel/lifecycle";
import { appendEvent, scrub } from "../ledger";
import { mutate, canonical, type ApiEnv, type ApiContext } from "./context";
import { ApiFailure, denied } from "./errors";
import { applyConfirmation } from "../dossier/service";
import { applyOps, type OpsOutcome } from "../explore/service";

const Decision = z
  .object({
    decision: z.enum(["approve", "reject"]),
    scope: z.literal("once").default("once"),
  })
  .strict();
const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
const capabilityLabel: Record<string, string> = {
  "papers.search": "检索论文",
  "papers.fetch": "把这篇论文正式入档",
  "papers.pages": "按页读取原文",
  "cards.card.layer": "写入分层讲解",
  "cards.card.quiz": "写入检查题",
  "cards.card.finding": "记录发现",
};
/** 计划已经变了，这张卡不再适用（不改计划，也不报成功）。 */
const STALE_PLAN_CODES = new Set([
  "PLAN_STALE",
  "STOP_NOT_FOUND",
  "CANVAS_NOT_FOUND",
  "PLAN_STATE",
  "PLAN_EMPTY",
  // 确认整份计划还差账户时区：卡上给不出时区就作废，让用户在页面上确认一次。
  "TIMEZONE_REQUIRED",
]);
const conflict = () =>
  new ApiFailure(
    "APPROVAL_CONFLICT",
    409,
    "审批已处理、过期或请求对象已变化，请刷新。",
  );
/** 卡片里只有给人看的短句；参数哈希留在账本里，不回给界面。 */
/** 审批卡上「会发生什么」：说人话，不把能力名甩给用户。 */
function describe(effects: any) {
  // 档案的删除/归档确认卡：effects 是对象，直接说清影响。
  if (typeof effects?.kind === "string" && effects.kind.startsWith("dossier.")) {
    const impact = effects.impact ?? {};
    const lines = [
      effects.kind === "dossier.delete"
        ? `删除《${effects.target?.title ?? "这份档案"}》后，列表、搜索和续上次都看不到它`
        : `归档《${effects.target?.title ?? "这份档案"}》后，它从进行中移到已归档`,
    ];
    if (impact.activeRuns) lines.push(`会停止 ${impact.activeRuns} 个正在跑的任务`);
    if (impact.pendingRequests) lines.push(`会关闭 ${impact.pendingRequests} 个待处理的请求`);
    if (impact.artifacts) lines.push(`档案里的 ${impact.artifacts} 项成果将不再能从这里访问`);
    if (impact.note) lines.push(impact.note);
    return lines;
  }
  // 探索台的计划修改卡：说清会改哪几个停留点，并把前后值写出来。
  const planChange = (Array.isArray(effects) ? effects[0] : effects) as any;
  if (planChange?.kind === "explore.planChange") {
    const lines = [String(planChange.summary ?? "按刚才说的改一下计划")];
    const changes = Array.isArray(planChange.changes) ? planChange.changes : [];
    for (const change of changes.slice(0, 6)) {
      const name = String(change?.after?.name ?? change?.before?.name ?? "这项");
      if (!change?.after) {
        const before = change?.before ?? {};
        const when = [before.day, before.window ? windowText(before.window) : ""].filter(Boolean).join(" ");
        lines.push(`删掉「${name}」${when ? `（${when}）` : ""}`);
      } else if (!change?.before) lines.push(`加上「${name}」`);
      else if (change.after.state === "confirmed" && change.before.state === "candidate")
        lines.push(`把「${name}」定下来（候选 → 已确认）`);
      else {
        const parts: string[] = [];
        for (const key of Object.keys(change.after)) {
          if (["state", "name", "kind"].includes(key)) continue;
          parts.push(`${stopFieldText(key)} ${valueText(change.before?.[key])} → ${valueText(change.after[key])}`);
        }
        lines.push(`改「${name}」：${parts.join("；") || "安排有调整"}`);
      }
    }
    lines.push("不批准就不改计划，你现在看到的安排保持原样");
    return lines;
  }
  // 天气调整建议：具体到哪个停留点、改什么、前后各是什么，并说明不应用就不改计划。
  if (planChange?.kind === "explore.weatherSuggestion") {
    const lines = [String(planChange.summary ?? "天气有变化，建议调整")];
    for (const change of (Array.isArray(planChange.changes) ? planChange.changes : []).slice(0, 6)) {
      const parts = Object.keys(change?.after ?? {})
        .map(
          (key) =>
            `${stopFieldText(key)} ${valueText(change.before?.[key])} → ${valueText(change.after[key])}`,
        );
      const why = typeof change?.why === "string" && change.why ? `（${change.why}）` : "";
      const who = String(change?.stopName ?? "") || String(change?.stopId ?? "").slice(0, 8);
      lines.push(`${who}：${parts.join("；")}${why}`);
    }
    lines.push("不批准就不改计划，你现在看到的安排保持原样");
    return lines;
  }
  // 审批行里的 effects 是数组（[{capability, argsHash}]），不是对象。
  const first = Array.isArray(effects) ? effects[0] : effects;
  const capability =
    typeof first?.capability === "string" ? first.capability : "";
  if (!capability) return [];
  const what = capabilityLabel[capability];
  if (capability === "papers.register") {
    const first0 = Array.isArray(effects) ? effects[0] : effects;
    const where = String(first0?.path ?? "工作区里的这份文件");
    const title = String(first0?.title ?? "");
    return [
      `把工作区里的 ${where}${title ? `（《${title}》` + "）" : ""}登记进当前档案，成为这份档案的正式论文`,
      "不会去网上重新下载，只读你工作区里这一份",
      "不批准就不入档、也不改名；你工作区里的原文件都还在",
    ];
  }
  if (capability === "papers.fetch")
    return [
      "把这篇论文下载进当前档案，并登记成正式资料",
      "只写这一篇，不会顺带改别的档案",
      "不批准就不下载，也不会编造内容",
    ];
  if (capability === "courses.plan")
    return [
      "把这份学习计划写进课程档案，之后可以照着它安排学习",
      "只写这一次提交的内容；改了计划需要重新确认",
      "不批准就不入档，已聊过的内容不会丢",
    ];
  return [
    what ? "这次要做的是：" + what : "这次请求需要你确认",
    "只处理这一次；内容变化后会重新问一次",
  ];
}
const clock = (iso: string) => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
const windowText = (window: any) =>
  typeof window?.start === "string" && typeof window?.end === "string"
    ? `${clock(window.start)}–${clock(window.end)}`
    : "时段";
const valueText = (value: unknown): string => {
  if (value === null || value === undefined) return "未定";
  if (typeof value === "string") return value.length > 30 ? value.slice(0, 30) + "…" : value;
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "object") {
    const row = value as any;
    if (typeof row.start === "string" && typeof row.end === "string") return windowText(row);
    if (row.type === "Point") return "坐标";
    if (row.coordinates) return "位置";
    return "内容";
  }
  return String(value);
};
const stopFieldText = (key: string): string =>
  ({
    window: "时段",
    day: "日期",
    name: "名称",
    kind: "类型",
    entry: "入口",
    exit: "出口",
    facing: "朝向",
    focal: "焦段",
    reason: "理由",
    refs: "参考图",
    detail: "细节",
    geometry: "位置",
  })[key] ?? key;

/** 卡片能力名：kernel 卡取 effects[0].capability，档案确认卡取 effects.kind。 */
function approvalCapability(effects: any): string | null {
  if (typeof effects?.kind === "string") return effects.kind;
  const first = Array.isArray(effects) ? effects[0] : effects;
  // kernel 卡用 capability；探索台的计划修改卡/天气建议卡用 kind。
  if (typeof first?.capability === "string") return first.capability;
  return typeof first?.kind === "string" ? first.kind : null;
}
function publicValue(v: any): JsonValue {
  if (Array.isArray(v)) return v.map(publicValue);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            ![
              "sessionID",
              "sessionId",
              "requestID",
              "requestId",
              "runID",
              "os_session_id",
              "os_request_id",
              "reinlabMcp",
            ].includes(k),
        )
        .map(([k, x]) => [k, publicValue(x)]),
    );
  return v;
}

/**
 * Reading approvals: the only cards left are kernel ones (`effect_key` set) and
 * in-conversation questions. Deciding one records the user's one-shot consent;
 * the consuming worker call is what actually reads the approval back.
 */
export function registerApprovalInbox(
  app: Hono<ApiEnv>,
  db: Database,
  isLive?: (runId: string) => boolean,
) {
  app.get("/v1/approvals", async (c) => {
    // 有人来看待办时先核对一次：超时没处理的请求、没有执行者的残留都在这收尾，
    // 不靠人工 SQL，也不让一个任务永远停在执行中。
    await reconcileAccount(db, c.get("accountId"), { isLive }).catch(() => {});
    return db.withAccount(c.get("accountId"), async (client) => {
      const state = z
        .enum(["pending", "indeterminate", "approved", "rejected", "expired"])
        .safeParse(c.req.query("state") ?? "pending");
      if (!state.success)
        throw new ApiFailure("INVALID_INPUT", 400, "待处理决定状态无效。");
      const rows = (
        await client.query(
          `select a.id,a.run_id "runId",a.kind,a.title,a.effects,a.risk,a.state,
                  a.decision_sent "sent",
                  -- 没有 run 的卡（天气建议、删除/归档确认）也要指回那份档案
                  coalesce(a.dossier_id,r.dossier_id) "dossierId",
                  d.title "dossierTitle",
                  d.bench "bench",r.role_id "roleId",r.state "runState"
             from approval a
             -- 档案的删除/归档确认卡没有 run，只有 dossier_id：也要进收件箱。
             left join run r on r.account_id=a.account_id and r.id=a.run_id
             join dossier d on d.account_id=a.account_id and d.id=coalesce(a.dossier_id,r.dossier_id)
            where a.account_id=$1 and a.state=$2
              and (a.effect_key is not null or a.dossier_id is not null)
            order by a.id limit 200`,
          [c.get("accountId"), state.data],
        )
      ).rows;
      return c.json({
        items: rows.map((row) => ({
          id: row.id,
          runId: row.runId,
          kind: row.kind,
          // 卡片类型直接给：前端不用从说明文字里猜。档案确认卡是 dossier.* 的 kind。
          capability: approvalCapability(row.effects),
          title: scrub(String(row.title).slice(0, 300)),
          effects: scrub(describe(row.effects) as JsonValue),
          risk: row.risk,
          state: row.state,
          sent: row.sent ?? false,
          source: {
            dossierId: row.dossierId,
            dossierTitle: scrub(row.dossierTitle),
            // 收件箱要显示这是哪个工作台的请求。
            bench: row.bench,
            runId: row.runId,
            roleId: row.roleId,
          },
        })),
      });
    });
  });
}

/**
 * 报告：一项任务结束后，收件箱要能看到结果、已有成果和原因（PRD 2.5 / L6）。
 * 只列该账户已经落终态的任务，不要求「批准」才能结束。
 */
export function registerReports(app: Hono<ApiEnv>, db: Database) {
  app.get("/v1/reports", (c) =>
    db.withAccount(c.get("accountId"), async (client) => {
      const rows = (
        await client.query(
          `select r.id "runId", r.dossier_id "dossierId", r.state, r.ended_at "endedAt",
                  d.title "dossierTitle",
                  (select e.payload->>'message' from event e
                    where e.run_id=r.id and e.action in ('run.interrupted') order by e.seq desc limit 1) "reason",
                  (select count(*)::int from event e
                    where e.run_id=r.id and e.action='card_created' and e.payload->>'cardType'='layer') "layers",
                  (select count(*)::int from event e
                    where e.run_id=r.id and e.action='card_created' and e.payload->>'cardType'='finding') "findings"
             from run r join dossier d on d.account_id=r.account_id and d.id=r.dossier_id
            where r.account_id=$1 and r.state in ('completed','failed','cancelled','interrupted')
            order by r.ended_at desc nulls last limit 20`,
          [c.get("accountId")],
        )
      ).rows;
      return c.json({
        items: rows.map((row) => ({
          runId: row.runId,
          dossierId: row.dossierId,
          dossierTitle: row.dossierTitle,
          state: row.state,
          endedAt: row.endedAt,
          reason: row.reason ? String(row.reason) : null,
          produced: { layers: row.layers, findings: row.findings },
        })),
      });
    }),
  );
}

/**
 * 课程档案：列出该档案已入档的学习计划（PRD 3.6 的「显示在课程档案中」）。
 * 入档是批准后的那一次写入，这里只读。
 */
export function registerCourses(app: Hono<ApiEnv>, db: Database) {
  app.get("/v1/courses/plans", (c) =>
    db.withAccount(c.get("accountId"), async (client) => {
      const rows = (
        await client.query(
          `select e.run_id "runId", e.dossier_id "dossierId", d.title "dossierTitle",
                  e.payload->>'planId' "planId", e.payload->'plan' "plan", e.at
             from event e join dossier d on d.account_id=e.account_id and d.id=e.dossier_id
            where e.account_id=$1 and e.action='course_plan_created'
            order by e.at desc limit 50`,
          [c.get("accountId")],
        )
      ).rows;
      return c.json({
        items: rows.map((row) => ({
          planId: row.planId,
          runId: row.runId,
          dossierId: row.dossierId,
          dossierTitle: row.dossierTitle,
          plan: row.plan,
          at: row.at,
        })),
      });
    }),
  );
}

/** Called by the runtime route for `/v1/approvals/:id/decide`. */
export async function decideInboxCard(
  c: ApiContext,
  db: Database,
  resume?: (account: string, runId: string, prompt: string) => void,
  /** 事务提交后由调用方推事件：页面看到已生效的那一批。 */
  onApplied?: (outcome: OpsOutcome) => void,
): Promise<Response | null> {
  const id = z.string().uuid().safeParse(c.req.param("id"));
  if (!id.success) throw denied();
  const account = c.get("accountId");
  return mutate(c, db, Decision, async (client, input) => {
    const row = (
      await client.query(
        // 档案的删除/归档确认卡没有 run，所以这里必须 left join。
        `select a.*,coalesce(a.dossier_id,r.dossier_id) dossier_id,r.role_id,
                r.state run_state,r.ended_at
           from approval a left join run r on r.account_id=a.account_id and r.id=a.run_id
          where a.id=$1 and (a.effect_key is not null or a.dossier_id is not null)
          for update of a`,
        [id.data],
      )
    ).rows[0];
    if (!row) throw denied();
    // 档案确认卡（删除 / 归档活跃档案）走这里：一次决定即生效，和页面同一张卡。
    // kernel 卡的 effects 是数组，档案确认卡是对象：两种都认。
    const effectOf = Array.isArray(row.effects) ? row.effects[0] : row.effects;
    const effectKind = (effectOf as any)?.kind;
    if (typeof effectKind === "string" && effectKind.startsWith("dossier.")) {
      const approved = input.decision === "approve";
      await client.query(
        "update approval set state=$3, decided_at=now() where account_id=$1 and id=$2",
        [account, id.data, approved ? "approved" : "rejected"],
      );
      await applyConfirmation(client, account, id.data, approved);
      return {
        status: 200,
        body: { state: approved ? "approved" : "rejected" },
      } as any;
    }
    // 探索台的计划修改卡：批准就在当时最新的计划上执行那一批 ops；
    // 计划在这张卡之后改过，就不套用（显示「已不适用」），绝不覆盖用户后来的修改。
    if (effectKind === "explore.planChange") {
      const approved = input.decision === "approve";
      if (!approved) {
        await client.query(
          "update approval set state='rejected', decided_at=now(), decided_scope='once' where account_id=$1 and id=$2",
          [account, id.data],
        );
        // 驳回也要送回原会话：不送回去，下一轮助手还以为「那张卡在等你点」。
        if (row.run_state === "waiting")
          resume?.(
            account,
            row.run_id,
            `用户驳回了这次计划修改（审批 ${row.id}），计划没有被改动。这一项已被拒绝：除非用户在这之后又明确提出，不要再提交它，也不要把它打包进别的修改里。如果他问原因，照实说明这次为什么被退回。`,
          );
        return { status: 200, body: { state: "rejected" } } as any;
      }
      const effects = effectOf as any;
      // 先把决定落成 approved：执行那一批时按这张卡一次性消费。
      const marked = await client.query(
        `update approval set state='approved', decided_at=now(), decided_scope='once'
          where account_id=$1 and id=$2 and state='pending'`,
        [account, id.data],
      );
      if (!marked.rowCount) throw conflict();
      try {
        const outcome = await applyOps(client, account, String(effects.dossierId), {
          ops: Array.isArray(effects.ops) ? effects.ops : [],
          actor: "agent",
          run: row.run_id,
          approved: { approvalId: id.data },
        });
        onApplied?.(outcome);
        if (row.run_state === "waiting")
          resume?.(
            account,
            row.run_id,
            `用户已批准这次计划修改（审批 ${row.id}），已经生效。不要重复提交同一批改动，用一两句话说明改了什么。`,
          );
        return { status: 200, body: { state: "approved", revision: outcome.revision } } as any;
      } catch (error) {
        if (error instanceof ApiFailure && STALE_PLAN_CODES.has(error.code)) {
          await client.query(
            "update approval set state='expired', decided_at=now() where account_id=$1 and id=$2",
            [account, id.data],
          );
          return { status: 200, body: { state: "stale", reason: error.message } } as any;
        }
        throw error;
      }
    }
    // 天气调整建议：批准就在当时最新的计划上应用那几处改动；不批准就保留原安排。
    if (effectKind === "explore.weatherSuggestion") {
      const effects = effectOf as any;
      const approved = input.decision === "approve";
      const marked = await client.query(
        `update approval set state=$3, decided_at=now(), decided_scope='once'
          where account_id=$1 and id=$2 and state='pending'`,
        [account, id.data, approved ? "approved" : "rejected"],
      );
      if (!marked.rowCount) throw conflict();
      if (!approved) {
        // 天气调整建议被驳回：同样送回会话，别让助手下一轮还说「等你确认」。
        if (row.run_state === "waiting")
          resume?.(
            account,
            row.run_id,
            `用户没有采纳这条天气调整建议（审批 ${row.id}），计划保持原样。不要重复提交同一批改动。`,
          );
        return { status: 200, body: { state: "rejected" } } as any;
      }
      try {
        const outcome = await applyOps(client, account, String(effects.dossierId), {
          ops: Array.isArray(effects.ops) ? effects.ops : [],
          actor: "agent",
          run: row.run_id ?? null,
          approved: { approvalId: id.data },
        });
        onApplied?.(outcome);
        return { status: 200, body: { state: "approved", revision: outcome.revision } } as any;
      } catch (error) {
        if (error instanceof ApiFailure && STALE_PLAN_CODES.has(error.code)) {
          await client.query(
            "update approval set state='expired', decided_at=now() where account_id=$1 and id=$2",
            [account, id.data],
          );
          return { status: 200, body: { state: "stale", reason: error.message } } as any;
        }
        throw error;
      }
    }
    // 一次决定落在同一个请求上：同参数重复提交返回同一回执，不同参数报冲突。
    const hash = createHash("sha256").update(canonical(input)).digest("hex"),
      old = (
        await client.query(
          "select request_hash,receipt from card_decision where approval_id=$1",
          [id.data],
        )
      ).rows[0];
    if (old) {
      if (old.request_hash !== hash) throw conflict();
      return { status: 200, body: old.receipt };
    }
    if (
      row.state !== "pending" ||
      !["running", "waiting"].includes(row.run_state) ||
      row.ended_at
    )
      throw conflict();
    const receipt = {
      approvalId: row.id,
      decision: input.decision,
      scope: "once",
    } as unknown as Record<string, JsonValue>;
    await client.query(
      `update approval
          set state=$2, decided_scope='once', decided_at=now(), decision_sent=true,
              decision_hash=$3, decision_input=$4
        where id=$1`,
      [
        row.id,
        input.decision === "approve" ? "approved" : "rejected",
        hash,
        json(input),
      ],
    );
    await appendEvent(client, account, {
      dossierId: row.dossier_id,
      runId: row.run_id,
      roleId: row.role_id,
      kind: "approval",
      action: "approval.decided",
      risk: "write",
      payload: receipt,
      dedupeKey: "inbox-approval-decided:" + row.id,
    });
    await client.query(
      "insert into card_decision(account_id,approval_id,request_hash,receipt)values($1,$2,$3,$4)",
      [account, row.id, hash, json(receipt)],
    );
    // 等待期间执行段已经让出：落定之后按同一会话续上，把这次决定作为输入
    // 送回原任务。是否续得上由运行服务自己判断，接口不因此失败。
    if (row.run_state === "waiting")
      resume?.(
        account,
        row.run_id,
        input.decision === "approve"
          ? `用户已批准这次请求（审批 ${row.id}）。继续原来的任务；如果还要执行同一个动作，直接再来一次即可，不要重复请求批准。`
          : `用户驳回/拒绝了这次请求（审批 ${row.id}）。不要重复请求同一个批准；照实说明并收尾，已完成的成果保留。`,
      );
    return { status: 200, body: receipt };
  });
}
