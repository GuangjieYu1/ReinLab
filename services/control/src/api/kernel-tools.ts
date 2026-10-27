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

    return dependencies.db.withAccount(claims.account, async (client) => {
      if (APPROVAL_REQUIRED.has(capability)) {
        const existing = await existingPaperAsset(client, call);
        if (existing) return c.json({ result: existing });

        const effectKey = effectKeyOf(capability, argsHash(call));
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
          return c.json({ state: card.state === "pending" ? "pending" : card.state, approvalId: card.id }, 409);
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
      const result = await dependencies.dispatch(call);
      if (APPROVAL_REQUIRED.has(capability) && typeof body.approvalId === "string")
        await client.query(
          "update approval set decision_receipt=$2 where id=$1 and decision_receipt is null",
          [body.approvalId, JSON.stringify(result)],
        );
      return c.json({ result });
    });
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
      "select id assetId,status,license,path,paper_id \"paperId\" from paper_asset where account_id=$1 and dossier_id=$2 and paper_id=$3 order by created_at desc limit 1",
      [call.account, call.dossier, paperId],
    )
  ).rows[0];
  return row ? { ...row, reused: true } : null;
}
