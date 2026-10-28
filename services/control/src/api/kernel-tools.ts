import type { Hono } from "hono";
import type pg from "pg";
import { createHash } from "node:crypto";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";
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
  papers: ["search", "fetch", "pages"],
  cards: ["card.layer", "card.finding", "clarify.question"],
};

/** Actions that need the user's one-shot approval before they run. */
const APPROVAL_REQUIRED = new Set(["papers.fetch"]);

/** Tools that are really a question to the user, not a business write. */
const ASKS_THE_USER = new Set(["cards.clarify.question"]);

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
      return await dependencies.db.withAccount(claims.account, async (client) => {
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
          return c.json({ state: "pending", approvalId: card.id }, 409);
        }
        if (APPROVAL_REQUIRED.has(capability)) {
          const existing = await existingPaperAsset(client, call);
          if (existing) return c.json({ result: existing });
          // 底线：候选论文由用户来选。这一轮没有用户选定的编号就不下载，先请它把候选交出去。
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
              title: "下载论文全文",
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
      return c.json({ state: card.state });
    });
  });
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
