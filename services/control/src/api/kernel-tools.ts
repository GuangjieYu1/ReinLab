import type { Hono } from "hono";
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";
import { paperHandle } from "../mcp/papers";
import { announceDossierChanged, nameFromPaper } from "../dossier/service";
import { applyOps, loadPlan, readPlan, stopCenter, weatherView, type OpsOutcome } from "../explore/service";
import { createProfile, deleteProfile, listProfiles, updateProfile } from "../explore/profiles";
import { listRefs } from "../explore/refs";
import { planUsage } from "../explore/usage";
import { userSaidClearly } from "../explore/authorize";
import { sunAtWindow, sunDay } from "../explore/sun";
import { localDayOf } from "../explore/weather";
import { OpsBody } from "../explore/schema";
import type { Basemap, Op, Viewport } from "@reinlab/contracts";
import { publishCamera, publishOps } from "./explore-api";
import {
  attachCourse,
  createDossier,
  detachArtifact,
  getDossier,
  listArtifacts,
  listDossiers,
  requestDelete,
  setArchived,
  updateDossier,
} from "../dossier/service";

/**
 * 两种入口（远程 fetch / 工作区 register）共用的「论文入档成功」处理：
 * 按第 6 节补名、写一条真实操作记录、更新档案最近活动。
 */
async function afterPaperRegistered(
  client: pg.PoolClient,
  call: KernelToolCall,
  result: Record<string, unknown>,
) {
  const renamed = await nameFromPaper(client, call.account, call.dossier).catch(() => null);
  const title =
    String(
      (result?.viewMetadata as any)?.title ?? (result?.title as string) ?? renamed ?? "",
    ).slice(0, 120) || "这篇论文";
  await client.query(
    "update dossier set last_activity_at=now(), version=version+1 where account_id=$1 and id=$2",
    [call.account, call.dossier],
  );
  // 改名/入档要立刻反映到页面头部与列表，不要求用户重新打开。
  await announceDossierChanged(client, call.account, call.dossier, "artifacts").catch(() => {});
  await client.query(
    `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
     values($1,$2,$3,'user_op','attach',$4,$5) on conflict do nothing`,
    [
      call.account,
      call.dossier,
      call.run,
      JSON.stringify({
        id: randomUUID(),
        at: new Date().toISOString(),
        dossierId: call.dossier,
        actor: "agent",
        via: "agent",
        action: "attach",
        text: `助手把《${title}》正式入档`,
      }),
      "paper-registered:" + String(result?.assetId ?? randomUUID()),
    ],
  );
}

/** 第 7 节：把档案工具映射到服务函数。结果里带 open，Agent 坞据此渲染可点卡片。 */
async function dossierTool(
  client: any,
  input: { account: string; dossier: string; tool: string; args: Record<string, unknown> },
) {
  const a = input.args ?? {};
  const dossierId = typeof a.dossierId === "string" ? a.dossierId : input.dossier;
  switch (input.tool) {
    case "list": {
      const found = await listDossiers(client, input.account, {
        bench: typeof a.bench === "string" ? a.bench : undefined,
        q: typeof a.q === "string" ? a.q : undefined,
        view: typeof a.view === "string" ? a.view : undefined,
      });
      // 多个匹配原样返回，由模型自己决定怎么问用户。
      return {
        items: found.items.map((d: any) => ({
          id: d.id,
          title: d.title,
          bench: d.bench,
          lifecycle: d.lifecycle,
          work: d.work,
          artifacts: d.artifacts.total,
          open: { to: "dossier", dossierId: d.id },
        })),
      };
    }
    case "get": {
      const d = await getDossier(client, input.account, dossierId);
      const arts = await listArtifacts(client, input.account, dossierId);
      return { ...d, artifacts: arts.items, open: { to: "dossier", dossierId: d.id } };
    }
    case "create":
      return createDossier(
        client,
        input.account,
        { bench: a.bench, kind: a.kind, title: a.title, intent: a.intent },
        "agent",
      );
    case "update":
      return updateDossier(
        client,
        input.account,
        dossierId,
        { baseVersion: a.baseVersion, title: a.title, intent: a.intent, lifecycle: a.lifecycle },
        "agent",
      );
    case "archive":
      return setArchived(client, input.account, dossierId, true, "agent", input.dossier);
    case "unarchive":
      return setArchived(client, input.account, dossierId, false, "agent", input.dossier);
    case "delete":
      // 只返回确认卡，不直接删。
      return requestDelete(client, input.account, dossierId, "agent", input.dossier);
    case "attach_course": {
      const courseId = String(a.courseId ?? "");
      if (!courseId) throw new ApiFailure("INVALID_INPUT", 400, "需要课程 id。");
      return attachCourse(client, input.account, dossierId, courseId, String(a.title ?? "课程"));
    }
    case "detach": {
      await detachArtifact(client, input.account, dossierId, String(a.artifactId ?? ""));
      return { removed: true };
    }
    default:
      throw new ApiFailure("KERNEL_TOOL_DENIED", 403, "没有这个档案工具。");
  }
}
import type { Database } from "../db/database";
import type { KernelAuth } from "../kernel/auth";
import {
  consumeApproval,
  decideApproval,
  effectKeyOf,
  requestApproval,
  type ApprovalCard,
} from "../run/approval";

/** Reading tools the kernel may call. Nothing else is forwarded. */
export const KERNEL_TOOLS: Record<string, string[]> = {
  papers: ["search", "fetch", "pages", "register"],
  cards: ["card.layer", "card.finding", "clarify.question"],
  // 课程台最小能力：提交一份学习计划并入档。计划确认与入档是同一次批准。
  courses: ["plan"],
  // 探索台的计划与画布：和页面调同一组服务函数，只是 via='agent'。
  explore: [
    "get",
    "ops",
    "view",
    "undo",
    "weather",
    "sun",
    "profiles",
    "profile_write",
    "refs",
    "usage",
  ],
  // 侧边 Agent 的档案工具：和页面调同一组服务函数，只是 via='agent'。
  dossiers: [
    "list",
    "get",
    "create",
    "update",
    "archive",
    "unarchive",
    "delete",
    "attach_course",
    "detach",
  ],
};

/** One turn must not call tools forever: the budget page already promises a step cap. */
const MAX_TOOL_CALLS = 40;

/** Actions that need the user's one-shot approval before they run. */
const APPROVAL_REQUIRED = new Set(["papers.fetch", "papers.register"]);

/** Tools that are really a question to the user, not a business write. */
const ASKS_THE_USER = new Set(["cards.clarify.question"]);

/** 正式入档类动作：一份学习计划可以用同一次批准既确认又入档。 */
const PLAN_CAPABILITY = "courses.plan";

export type KernelToolCall = {
  account: string;
  dossier: string;
  run: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
};

export type KernelToolDependencies = {
  auth: KernelAuth;
  db: Database;
  now: () => number;
  /** Executes an allowed tool against the business layer. */
  dispatch: (call: KernelToolCall) => Promise<unknown>;
};

const argsHash = (call: KernelToolCall) =>
  createHash("sha256").update(canonical({ server: call.server, tool: call.tool, args: call.args })).digest("hex");

const tokenOf = (request: Request) => {
  const key = request.headers.get("x-api-key");
  if (key) return key.trim();
  return request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
};

/**
 * Kernel tool gateway used by the reading plugin.
 *
 * One approval card per concrete action: `papers.fetch` asks only when the
 * dossier has no asset for that paper yet, a repeat call after approval returns
 * the existing asset instead of downloading again, and a rejection stops the
 * run without a download.
 */
export function registerKernelTools(
  app: Hono<any>,
  dependencies: KernelToolDependencies,
) {
  const authenticate = (request: Request) => {
    try {
      return dependencies.auth.verify(tokenOf(request), dependencies.now());
    } catch {
      throw new ApiFailure("KERNEL_TOKEN_INVALID", 401, "运行令牌缺失或无效。");
    }
  };

  app.post("/kernel/tool", async (c) => {
    const claims = authenticate(c.req.raw);
    const body = (await c.req.json().catch(() => ({}))) as {
      server?: unknown;
      tool?: unknown;
      args?: unknown;
      approvalId?: unknown;
    };
    if (
      typeof body.server !== "string" ||
      typeof body.tool !== "string" ||
      !KERNEL_TOOLS[body.server]?.includes(body.tool)
    )
      throw new ApiFailure("KERNEL_TOOL_DENIED", 403, "该工具不在精读范围。");
    const args =
      body.args && typeof body.args === "object" && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    const call: KernelToolCall = {
      account: claims.account,
      dossier: claims.dossier,
      run: claims.run,
      server: body.server,
      tool: body.tool,
      args,
    };
    const capability = `${body.server}.${body.tool}`;

    try {
      // 事务提交之后再推事件：页面不能先看到还没生效的东西。
      let settled: ExploreSettlement | null = null;
      const response = await dependencies.db.withAccount(claims.account, async (client) => {
        // 单轮工具调用上限：按「当前这一轮」计数。审批后续接是同一个 run 的新 dsh_turn，
        // 要从它开始重新计，否则批准过的动作会被上一轮用掉的次数挡住。
        const used = Number(
          (
            await client.query(
              `select count(*)::int n from event e
                where e.run_id=$1 and e.action='tool/call'
                  and e.at >= coalesce(
                    (select max(t.started_at) from dsh_turn t where t.run_id=$1),
                    '-infinity'::timestamptz)`,
              [claims.run],
            )
          ).rows[0]?.n ?? 0,
        );
        if (used >= MAX_TOOL_CALLS)
          throw new ApiFailure(
            "TOOL_CALL_LIMIT",
            409,
            `这一轮已经调用工具 ${used} 次（上限 ${MAX_TOOL_CALLS}），先把已经拿到的内容收尾。`,
          );
        if (ASKS_THE_USER.has(capability)) {
          if (typeof body.approvalId === "string") {
            const answered = (
              await client.query(
                "select state,effects from approval where id=$1 and account_id=$2",
                [body.approvalId, call.account],
              )
            ).rows[0];
            if (!answered)
              throw new ApiFailure("APPROVAL_NOT_FOUND", 404, "这段时间的提问已不存在。");
            if (answered.state === "approved")
              return c.json({
                result: { state: "answered", ...(answered.effects?.answer ?? {}) },
              });
            if (answered.state === "rejected" || answered.state === "expired")
              return c.json({ result: { state: "cancelled" } });
            return c.json({ state: "pending", approvalId: body.approvalId }, 409);
          }
          // The candidate choice belongs to the user: keep the turn open on a
          // question card and hand the answer back to the kernel.
          const card = await requestApproval(client, {
            account: call.account,
            dossier: call.dossier,
            run: call.run,
            capability,
            argsHash: argsHash(call),
            title:
              typeof args.question === "string" && args.question.trim() !== ""
                ? args.question.trim().slice(0, 300)
                : "请选择要读的论文",
            effects: [
              {
                kind: typeof args.kind === "string" ? args.kind : "text",
                candidates: Array.isArray(args.candidates) ? args.candidates : [],
              },
            ],
            risk: "read",
            kind: "question",
          });
          await client.query("update dsh_session set lease_run_id=null where lease_run_id=$1", [
            call.run,
          ]);
          return c.json({ state: "pending", approvalId: card.id }, 409);
        }
        // 探索台：读计划、改计划与画布、移视野、撤回自己的涂鸦。
        if (body.server === "explore") {
          const settledNow = await exploreTool(client, {
            account: call.account,
            dossier: call.dossier,
            run: call.run,
            tool: String(body.tool),
            args,
          });
          if (settledNow.publish) settled = settledNow.publish;
          return c.json(settledNow.body, settledNow.status as any);
        }
        // 第 7 节：档案工具。和页面同一组服务函数，删除只返回确认卡。
        if (body.server === "dossiers") {
          const result = await dossierTool(client, {
            account: call.account,
            dossier: call.dossier,
            tool: String(body.tool),
            args,
          });
          return c.json({ result });
        }
        // 工作区登记：先只读文件、算摘要，交给用户批一次；批准后按同一份内容入档。
        if (capability === "papers.register") {
          const prepared = (await dependencies.dispatch({
            ...call,
            args: { ...args, __phase: "prepare" },
          })) as Record<string, any>;
          if (prepared?.existing)
            return c.json({ result: { ...prepared.existing, reused: true } });
          const effectKey = effectKeyOf(capability, argsHash(call));
          const commit = async () => {
            const result = (await dependencies.dispatch({
              ...call,
              args: { ...args, __phase: "commit", __digest: prepared.digest },
            })) as Record<string, unknown>;
            await afterPaperRegistered(client, call, {
              ...(result ?? {}),
              ...(prepared.metadata ?? {}),
            });
            return result;
          };
          if (typeof body.approvalId === "string") {
            if (!(await consumeApproval(client, { approvalId: body.approvalId, effectKey })))
              throw new ApiFailure("APPROVAL_NOT_CONSUMABLE", 409, "这次入档没有可用的批准，请重新发起。");
            return c.json({ result: await commit() });
          }
          const approved = (
            await client.query(
              `select id from approval
                where account_id=$1 and run_id=$2 and effect_key=$3
                  and state='approved' and consumed_at is null
                order by created_at desc limit 1`,
              [call.account, call.run, effectKey],
            )
          ).rows[0];
          if (!approved) {
            const title = String(prepared?.metadata?.title ?? args.title ?? "这篇论文");
            const card = await requestApproval(client, {
              account: call.account,
              dossier: call.dossier,
              run: call.run,
              capability,
              argsHash: argsHash(call),
              title: `把《${title}》正式入档`,
              effects: [
                {
                  capability,
                  argsHash: argsHash(call),
                  // 批准绑定的是这份内容：摘要写进卡里，之后文件换了就不认。
                  sha256: prepared?.digest,
                  title,
                  // 卡上只写工作区内的相对位置，不外泄宿主绝对路径。
                  path: String(args.path ?? "工作区里的这份 PDF"),
                },
              ],
              risk: "write",
            });
            await client.query(
              "update dsh_session set lease_run_id=null where lease_run_id=$1",
              [call.run],
            );
            return c.json({ state: "pending", approvalId: card.id }, 409);
          }
          if (!(await consumeApproval(client, { approvalId: approved.id, effectKey })))
            throw new ApiFailure("APPROVAL_NOT_CONSUMABLE", 409, "这次入档没有可用的批准，请重新发起。");
          return c.json({ result: await commit() });
        }
        // 课程计划：还没批准就交出一张确认卡（卡上就是计划本身），
        // 批准后同一次动作把计划写进档案。不再另外索要入档审批。
        if (capability === PLAN_CAPABILITY) {
          const effectKey = effectKeyOf(capability, argsHash(call));
          const summary = String(args.goal ?? args.title ?? "").trim().slice(0, 200);
          if (typeof body.approvalId === "string") {
            const consumed = await consumeApproval(client, {
              approvalId: body.approvalId,
              effectKey,
            });
            if (!consumed)
              throw new ApiFailure("APPROVAL_NOT_CONSUMABLE", 409, "这次计划没有可用的批准，请重新提交。");
          } else {
            // 已经批准过这份计划：直接执行，不重复要批准。
            const approved = (
              await client.query(
                `select id from approval
                  where account_id=$1 and run_id=$2 and effect_key=$3
                    and state='approved' and consumed_at is null
                  order by id desc limit 1`,
                [call.account, call.run, effectKey],
              )
            ).rows[0];
            if (!approved) {
              const card = await requestApproval(client, {
                account: call.account,
                dossier: call.dossier,
                run: call.run,
                capability,
                argsHash: argsHash(call),
                title: summary ? "确认这份学习计划并入档：" + summary : "确认这份学习计划并入档",
                effects: [{ capability, argsHash: argsHash(call), plan: args }],
                risk: "write",
              });
              await client.query(
                "update dsh_session set lease_run_id=null where lease_run_id=$1",
                [call.run],
              );
              return c.json({ state: "pending", approvalId: card.id }, 409);
            }
            if (!(await consumeApproval(client, { approvalId: approved.id, effectKey })))
              throw new ApiFailure("APPROVAL_NOT_CONSUMABLE", 409, "这次计划没有可用的批准，请重新提交。");
          }
          const planId = randomUUID();
          await client.query(
            `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
             values($1::uuid,$2::uuid,$3::uuid,'course','course_plan_created',$4,$5)
             on conflict do nothing`,
            [
              call.account,
              call.dossier,
              call.run,
              JSON.stringify({ planId, plan: args }),
              "course-plan:" + planId,
            ],
          );
          return c.json({ result: { planId, state: "archived" } });
        }
        if (APPROVAL_REQUIRED.has(capability)) {
          const existing = await existingPaperAsset(client, call);
          if (existing) return c.json({ result: existing });
          // 底线：只读用户选定的这一篇。没选定、或者选的不是这一篇，都不下载。
          const chosen = (
            await client.query("select input->>'chosenPaperId' chosen from run where id=$1 and account_id=$2", [
              call.run,
              call.account,
            ])
          ).rows[0]?.chosen;
          if (!chosen)
            throw new ApiFailure(
              "PAPER_NOT_CHOSEN",
              409,
              "用户还没选定论文：先把真实候选交给用户，由用户选一篇后再下载。",
            );
          if (paperHandle(String(args.paperId)) !== paperHandle(chosen))
            throw new ApiFailure(
              "PAPER_NOT_CHOSEN",
              409,
              `这一轮只读用户选定的这一篇（${String(chosen)}）；不要下载别的论文。`,
            );

          const effectKey = effectKeyOf(capability, argsHash(call));
          // The user may have approved this exact action already; a retry without
          // the id must execute it once instead of bouncing a 409 forever.
          if (typeof body.approvalId !== "string") {
            const card = await requestApproval(client, {
              account: call.account,
              dossier: call.dossier,
              run: call.run,
              capability,
              argsHash: argsHash(call),
              title: "把这篇论文正式入档",
              // 一次批准覆盖「这篇论文进入正式档案」这一次提交；
              // 下载到工作区、草稿与讲解卡都不再单独打扰。
              effects: [{ capability, argsHash: argsHash(call) }],
              risk: "write",
            });
            if (card.state === "approved" && !card.consumed) {
              const consumed = await consumeApproval(client, {
                approvalId: card.id,
                effectKey,
              });
              if (consumed) {
                const result = await dependencies.dispatch(call);
                await client.query(
                  "update approval set decision_receipt=$2 where id=$1 and decision_receipt is null",
                  [card.id, JSON.stringify(result)],
                );
                if (capability === "papers.fetch")
                  await afterPaperRegistered(client, call, result as Record<string, unknown>);
                return c.json({ result });
              }
            }
            if (card.state === "approved" && card.consumed) {
              const receipt = (
                await client.query("select decision_receipt from approval where id=$1", [
                  card.id,
                ])
              ).rows[0]?.decision_receipt;
              if (receipt) return c.json({ result: { ...(receipt as object), reused: true } });
              const reused = await existingPaperAsset(client, call);
              if (reused) return c.json({ result: reused });
            }
            if (card.state === "pending")
              await client.query(
                "update dsh_session set lease_run_id=null where lease_run_id=$1",
                [call.run],
              );
            return c.json({ state: card.state === "pending" ? "pending" : card.state, approvalId: card.id }, 409);
          }
          // Already downloaded for this dossier: consume the approval and return
          // the existing asset instead of downloading the same paper again.
          const already = await existingPaperAsset(client, call);
          if (already) {
            await consumeApproval(client, { approvalId: body.approvalId, effectKey });
            return c.json({ result: already });
          }
          const consumed = await consumeApproval(client, {
            approvalId: body.approvalId,
            effectKey,
          });
          if (!consumed) {
            const reused = await existingPaperAsset(client, call);
            if (reused) return c.json({ result: reused });
            // The action already ran for this exact approval: return its result
            // instead of running (and downloading) a second time.
            const receipt = (
              await client.query(
                "select decision_receipt from approval where id=$1 and account_id=$2",
                [body.approvalId, claims.account],
              )
            ).rows[0]?.decision_receipt;
            if (receipt)
              return c.json({ result: { ...(receipt as Record<string, unknown>), reused: true } });
            throw new ApiFailure("APPROVAL_NOT_CONSUMABLE", 409, "这次动作没有可用的批准，请重新请求。");
          }
        }
        const result = (await dependencies.dispatch(call)) as Record<string, unknown>;
        // 选定并下载成功后按第 6 节补名：占位名换成论文名（用户改过的绝不动）。
        if (capability === "papers.fetch")
          await nameFromPaper(client, call.account, call.dossier).catch(() => null);
        // 论文视图要标题/作者/来源：从资产元数据补上，界面才能切到「读这篇」。
        const assetId =
          typeof result?.assetId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.assetId)
            ? result.assetId
            : undefined;
        if (call.server === "papers" && call.tool === "fetch" && assetId) {
          const meta = (
            await client
              .query("select view_metadata from paper_asset where account_id=$1 and id=$2", [
                call.account,
                assetId,
              ])
          ).rows[0]?.view_metadata as Record<string, unknown> | undefined;
          if (meta)
            Object.assign(result, {
              title: meta.title ?? null,
              authors: meta.authors ?? [],
              venue: meta.venue ?? null,
              license: meta.license ?? result.license ?? null,
            });
        }
        if (APPROVAL_REQUIRED.has(capability) && typeof body.approvalId === "string")
          await client.query(
            "update approval set decision_receipt=$2 where id=$1 and decision_receipt is null",
            [body.approvalId, JSON.stringify(result)],
          );
        return c.json({ result });
      });
      if (settled) publishSettled(claims.account, settled);
      return response;
    } catch (error) {
      // 工具失败必须带错误码和一句原因，模型与日志才有据可查。
      if (error instanceof ApiFailure)
        return c.json({ code: error.code, message: error.message, error: error.code }, error.status);
      const detail = String((error as Error)?.message ?? error);
      console.error(
        JSON.stringify({ code: "KERNEL_TOOL_FAILED", tool: capability, message: detail.slice(0, 300) }),
      );
      return c.json(
        { code: "KERNEL_TOOL_FAILED", message: detail.slice(0, 300), error: detail.slice(0, 300) },
        500,
      );
    }
  });

  app.get("/kernel/approvals/:id", async (c) => {
    const claims = authenticate(c.req.raw);
    const id = c.req.param("id");
    return dependencies.db.withAccountSnapshot(claims.account, async (client) => {
      const row = (
        await client.query(
          "select id,state,decided_scope from approval where id=$1 and account_id=$2",
          [id, claims.account],
        )
      ).rows[0];
      if (!row) throw new ApiFailure("APPROVAL_NOT_FOUND", 404, "审批不存在。");
      return c.json({ state: row.state });
    });
  });

  /** 人一直不点：由插件在等待超时后调用，把这张卡标成过期并留下事件。 */
  app.post("/kernel/approvals/:id/expire", async (c) => {
    const claims = authenticate(c.req.raw);
    return dependencies.db.withAccount(claims.account, async (client) => {
      const row = (
        // 只过期本 run 自己的卡：别的运行（含上一段被取消的澄清）等待超时
        // 时，不能把这一轮刚建的卡一起标掉。
        await client.query(
          "update approval set state='expired' where id=$1 and account_id=$2 and run_id=$3 and state='pending' returning run_id",
          [c.req.param("id"), claims.account, claims.run],
        )
      ).rows[0];
      if (!row) return c.json({ state: "expired" });
      await client.query(
        "update dsh_session set lease_run_id=null where lease_run_id=$1",
        [row.run_id],
      );
      await appendApprovalEvent(client, claims.account, row.run_id, "approval.expired", {
        approvalId: c.req.param("id"),
        reason: "expired",
      });
      await leaseBack(client, row.run_id);
      return c.json({ state: "expired" });
    });
  });

  app.post("/kernel/approvals/:id/decide", async (c) => {
    const claims = authenticate(c.req.raw);
    const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown };
    const decision = body.decision;
    if (decision !== "approve" && decision !== "reject")
      throw new ApiFailure("DECISION_INVALID", 400, "决定无效。");
    return dependencies.db.withAccount(claims.account, async (client) => {
      const card: ApprovalCard = await decideApproval(client, {
        approvalId: c.req.param("id"),
        decision,
      });
      const decided = (
        await client.query("select run_id from approval where id=$1 and account_id=$2", [
          c.req.param("id"),
          claims.account,
        ])
      ).rows[0];
      if (decided) await leaseBack(client, decided.run_id);
      return c.json({ state: card.state });
    });
  });
}

/** 决定/过期之后，把会话租约还回这一轮（被别人占用时保持原样）。 */
async function leaseBack(client: pg.PoolClient, run: string) {
  await client.query(
    "update dsh_session set lease_run_id=$1 where lease_run_id is null and dossier_id=(select dossier_id from run where id=$1)",
    [run],
  );
}
async function appendApprovalEvent(
  client: pg.PoolClient,
  account: string,
  run: string,
  action: string,
  payload: Record<string, unknown>,
) {
  const row = (
    await client.query("select dossier_id from run where id=$1 and account_id=$2", [run, account])
  ).rows[0];
  if (!row) return;
  await client.query(
    `insert into event(account_id,dossier_id,run_id,role_id,kind,action,payload,dedupe_key)
     values($1,$2,$3,'research-read','dsh',$4,$5,$6)`,
    [
      account,
      row.dossier_id,
      run,
      action,
      JSON.stringify(payload),
      `dsh:${run}:${action}:${String(payload.approvalId ?? Date.now())}`,
    ],
  );
}
async function existingPaperAsset(
  client: pg.PoolClient,
  call: KernelToolCall,
): Promise<Record<string, unknown> | null> {
  const paperId = typeof call.args.paperId === "string" ? call.args.paperId : "";
  if (!paperId) return null;
  const row = (
    await client.query(
      "select id assetId,status,license,path,paper_id \"paperId\" from paper_asset where account_id=$1 and dossier_id=$2 and paper_id=$3 and run_id=$4 and status='full_text' order by created_at desc limit 1",
      [call.account, call.dossier, paperId, call.run],
    )
  ).rows[0];
  return row ? { ...row, reused: true } : null;
}

/** 探索台工具：和页面同一组服务函数，只是 actor='agent'。 */
type ExploreSettlement =
  | { kind: "ops"; outcome: OpsOutcome }
  | {
      kind: "camera";
      bench: string;
      dossierId: string;
      runId: string;
      viewport: Viewport;
      basemap: Basemap;
    };

function publishSettled(account: string, settled: ExploreSettlement) {
  if (settled.kind === "ops") publishOps(account, settled.outcome);
  else
    publishCamera(account, settled.bench, {
      dossierId: settled.dossierId,
      runId: settled.runId,
      viewport: settled.viewport,
      basemap: settled.basemap,
    });
}

async function exploreTool(
  client: pg.PoolClient,
  input: { account: string; dossier: string; run: string; tool: string; args: Record<string, unknown> },
): Promise<{ status: number; body: Record<string, unknown>; publish?: ExploreSettlement }> {
  const args = input.args ?? {};
  if (input.tool === "get") {
    const bundle = await readPlan(client, input.account, input.dossier);
    // 对话里的候选卡按 id 显示，模型不必背名称。
    return {
      status: 200,
      body: { result: { ...bundle, stopIds: bundle.plan.stops.map((stop) => stop.id) } },
    };
  }
  if (input.tool === "view") {
    const viewport = args.viewport as Viewport;
    const basemap: Basemap = args.basemap === "satellite" ? "satellite" : "vector";
    const outcome = await applyOps(client, input.account, input.dossier, {
      ops: [{ op: "view.save", viewport, basemap }],
      actor: "agent",
      run: input.run,
    });
    return {
      status: 200,
      body: { result: { saved: true, viewport, basemap } },
      publish: {
        kind: "camera",
        bench: outcome.bench,
        dossierId: input.dossier,
        runId: input.run,
        viewport,
        basemap,
      },
    };
  }
  if (input.tool === "profiles") {
    return {
      status: 200,
      body: {
        result: {
          items: await listProfiles(
            client,
            input.account,
            typeof args.type === "string" ? args.type : undefined,
          ),
        },
      },
    };
  }
  if (input.tool === "profile_write") {
    // 新推测、新总结必须先得到用户确认：他的原话要同时点到目标与动作。
    const action = args.action === "update" ? "update" : args.action === "delete" ? "delete" : "add";
    const type = args.type === "gear" ? "gear" : "model";
    const existing = await listProfiles(client, input.account, type);
    const target =
      typeof args.id === "string" && args.id
        ? existing.find((profile) => profile.id === args.id)
        : typeof args.name === "string" && args.name
          ? existing.find((profile) => profile.name === args.name)
          : undefined;
    const name = String(args.name ?? target?.name ?? "");
    const verdict = await userSaidClearly(client, {
      account: input.account,
      dossier: input.dossier,
      run: input.run,
      targets: [name],
      verbs:
        action === "delete"
          ? ["删", "去掉", "移除", "不要"]
          : ["记住", "加上", "加进", "改成", "更新", "我有", "存进", "记一下"],
    });
    if (!verdict.ok)
      return {
        status: 409,
        body: { state: "needs_user_confirmation", reason: verdict.reason },
      };
    if (action === "delete") {
      if (!target)
        throw new ApiFailure("PROFILE_NOT_FOUND", 404, "账号里没有这条资料。");
      await deleteProfile(client, input.account, target.id);
      return { status: 200, body: { result: { removed: target.id } } };
    }
    if (action === "update") {
      if (!target) throw new ApiFailure("PROFILE_NOT_FOUND", 404, "账号里没有这条资料。");
      const profile = await updateProfile(client, input.account, target.id, {
        ...(args as Record<string, unknown>),
        baseRevision: target.revision,
      });
      return { status: 200, body: { result: profile } };
    }
    const profile = await createProfile(client, input.account, {
      ...(args as Record<string, unknown>),
      type,
    });
    return { status: 200, body: { result: profile } };
  }
  if (input.tool === "refs") {
    return {
      status: 200,
      body: { result: { items: await listRefs(client, input.account, input.dossier) } },
    };
  }
  if (input.tool === "usage") {
    return {
      status: 200,
      body: { result: await planUsage(client, input.account, input.dossier) },
    };
  }
  if (input.tool === "weather") {
    const view = await weatherView(client, input.account, input.dossier, {
      stopId: typeof args.stopId === "string" ? args.stopId : undefined,
      refresh: args.refresh === true,
    });
    return { status: 200, body: { result: view } };
  }
  if (input.tool === "sun") {
    const { plan } = await loadPlan(client, input.account, input.dossier);
    const destination = plan.document.destination;
    if (!destination)
      throw new ApiFailure("DESTINATION_REQUIRED", 409, "先确定拍摄地点和时区，太阳要按当地时间算。");
    const wanted =
      typeof args.stopId === "string"
        ? plan.document.stops.filter((stop) => stop.id === args.stopId)
        : plan.document.stops;
    if (typeof args.stopId === "string" && !wanted.length)
      throw new ApiFailure("STOP_NOT_FOUND", 404, "计划里没有这个停留点。");
    // 没有行程日期时按当地今天算，别用服务器的 UTC 日期。
    const today = localDayOf(new Date(), destination.timezone);
    const targets = wanted.length
      ? wanted.map((stop) => ({
          stopId: stop.id,
          name: stop.name,
          at: stopCenter(stop.geometry),
          day: stop.day,
          window: stop.window ?? null,
        }))
      : [
          {
            stopId: "destination",
            name: destination.name,
            at: destination.center,
            day: plan.document.days[0] ?? today,
            window: null,
          },
        ];
    return {
      status: 200,
      body: {
        result: {
          timezone: destination.timezone,
          items: targets.map((target) => ({
            stopId: target.stopId,
            name: target.name,
            day: target.day,
            sun: sunDay(target.at, target.day, destination.timezone),
            atWindow: sunAtWindow(target.at, target.window, destination.timezone),
          })),
          // 地形见光要高程数据（OpenTopography 的 key 还没配）：只给天文时段，不当成见光时段。
          terrain: {
            available: false,
            reason: "地形见光是另一回事：本机还没配高程数据（OpenTopography），所以这里只有太阳的时刻和方向。",
          },
        },
      },
    };
  }
  const authorization =
    typeof args.authorization === "string"
      ? { messageId: args.authorization }
      : args.authorization && typeof args.authorization === "object"
        ? args.authorization
        : undefined;
  const parsed = OpsBody.safeParse({
    ...(typeof args.baseRevision === "number" ? { baseRevision: args.baseRevision } : {}),
    ops: input.tool === "undo" ? [{ op: "canvas.undo" }] : Array.isArray(args.ops) ? args.ops : [],
    ...(authorization ? { authorization } : {}),
  });
  if (!parsed.success)
    throw new ApiFailure("INVALID_INPUT", 400, "这批动作的格式不对：检查 op 名称和必填字段。");
  const outcome = await applyOps(client, input.account, input.dossier, {
    baseRevision: parsed.data.baseRevision,
    ops: parsed.data.ops as Op[],
    actor: "agent",
    run: input.run,
    authorization: parsed.data.authorization,
  });
  if (outcome.pending)
    // 还没生效：只交出待批的修改，不说已经改好了。
    return {
      status: 409,
      body: {
        state: "pending",
        approvalId: outcome.pending.approvalId,
        pending: outcome.pending,
        revision: outcome.revision,
      },
    };
  const stopIds = [
    ...new Set(
      outcome.applied.flatMap((entry) => {
        const result = (entry.result ?? {}) as Record<string, any>;
        const ids: string[] = [];
        if (result.stop?.id) ids.push(String(result.stop.id));
        if (Array.isArray(result.stops))
          for (const stop of result.stops) if (stop?.id) ids.push(String(stop.id));
        return ids;
      }),
    ),
  ];
  return {
    status: 200,
    body: {
      result: {
        revision: outcome.revision,
        state: outcome.plan.state,
        applied: outcome.applied,
        pending: null,
        stopIds,
      },
    },
    publish: outcome.applied.length ? { kind: "ops", outcome } : undefined,
  };
}
