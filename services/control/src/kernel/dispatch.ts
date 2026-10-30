import path from "node:path";
import { homedir } from "node:os";
import type { Database } from "../db/database";
import { loadCapabilityCatalog, type CapabilityCatalog } from "../mcp/registry";
import { paperHandlers, type PaperDeposit } from "../mcp/papers";
import {
  commitRegistration,
  existingByDigest,
  prepareRegistration,
  type WorkspaceRoots,
} from "../mcp/register";
import type { CardDeposit, CapabilityHandler } from "../mcp/handler";
import { kernelCardHandlers } from "./cards";
import { ApiFailure } from "../api/errors";
import type { TokenClaims } from "../mcp/token";
import type { AuthorizedCapability } from "../mcp/handler";
import type { KernelToolCall } from "../api/kernel-tools";
import { createHash, randomUUID } from "node:crypto";

export type DispatchDependencies = {
  db: Database;
  cacheRoot: string;
  deposit: PaperDeposit;
  cardDeposit: CardDeposit;
  /** Test seam: replace the frozen-schema card layer with a recording double. */
  cardHandlers?: (db: Database, deposit: CardDeposit) => Record<string, unknown>;
  /** Transport override for tests; production uses the pinned HTTP client. */
  http?: Parameters<typeof paperHandlers>[3];
  /** 宿主上的内核根：用来定位当前档案的工作区（工作区登记论文要用）。 */
  kernelHome?: string;
  catalog?: CapabilityCatalog;
};

const PLACEHOLDER_SCOPE = {
  grants: [],
  memory: { layers: [], refs: null, assignedCitations: false },
} as const;

/**
 * Route an allowed kernel tool to the existing business handlers.
 *
 * The kernel token carries account/dossier/run only; the handlers still get a
 * capability context so their account scoping and page/anchor rules stay in
 * force. No budget reservation or capability digest is synthesized here.
 */
export function createKernelDispatch(dependencies: DispatchDependencies) {
  let catalog: CapabilityCatalog | undefined = dependencies.catalog;
  let handlers: ReturnType<typeof paperHandlers> | undefined;
  let cards: Record<string, CapabilityHandler> | undefined;

  const loadCatalog = async () => {
    catalog ??= await loadCapabilityCatalog();
    return catalog;
  };
  const catalogFor = (current: CapabilityCatalog) => current;
  const paper = async () => {
    catalog ??= await loadCapabilityCatalog();
    handlers ??= paperHandlers(
      dependencies.db,
      dependencies.cacheRoot,
      dependencies.deposit,
      dependencies.http,
    );
    return { catalog, handlers };
  };

  return async function dispatch(call: KernelToolCall): Promise<unknown> {
    const contextFor = (current: CapabilityCatalog): AuthorizedCapability =>
      ({
        claims: {
          account: call.account,
          dossier: call.dossier,
          run: call.run,
          role: "research-read",
        } as unknown as TokenClaims,
        scope: PLACEHOLDER_SCOPE as unknown as AuthorizedCapability["scope"],
        catalog: current,
      }) as AuthorizedCapability;

    if (call.server === "cards") {
      // 卡片里的 paperId 可能是论文站点的 id（W…/arXiv 号），而页码回执按资产 id 记录：
      // 落卡前把它换成这次运行下载的资产 id，引用才核得上。
      call = { ...call, args: await withAssetId(dependencies.db, call) };
      // 内核运行没有 run_harness 行，冻结清单那条卡片写入路径在这里必然 403；
      // 用内核自己的写入器：同样的卡片规范和「引用必须来自本轮读过的页」。
      cards ??= dependencies.cardHandlers
        ? (dependencies.cardHandlers(dependencies.db, dependencies.cardDeposit) as Record<
            string,
            CapabilityHandler
          >)
        : kernelCardHandlers(dependencies.db);
      const handler = cards[`cards.${call.tool}`];
      if (!handler)
        throw new ApiFailure("KERNEL_TOOL_UNSUPPORTED", 501, "该卡片工具尚未接入。");
      const catalog = catalogFor(await loadCatalog());
      return handler(contextFor(catalog), call.args, randomUUID());
    }
    if (call.server === "papers") {
      const { catalog: current, handlers: table } = await paper();
      // 工作区登记走自己的两段式流程，不是既有远程 handler。
      if (call.tool === "register")
        return registerPaper(dependencies, contextFor(current), call);
      const handler = table[`papers.${call.tool}`];
      if (!handler) throw new ApiFailure("KERNEL_TOOL_UNSUPPORTED", 501, "该论文工具尚未接入。");
      // 读页的 assetId 也可能是 arXiv / OpenAlex 号：本轮已下载过就换成资产 id，
      // 否则这次读页被拒，模型会绕去抓网页，页码依据就落不了库。
      if (call.tool === "pages" && typeof call.args?.assetId === "string")
        call = { ...call, args: await withAssetId(dependencies.db, call) };
      const result = await handler(contextFor(current), call.args, randomUUID());
      // Reading a page is a citation receipt: the card check requires these rows,
      // so the kernel path records them the same way the old engine did.
      if (call.tool === "pages") await recordPageReads(dependencies.db, call, result);
      return result;
    }
    throw new ApiFailure("KERNEL_TOOL_UNSUPPORTED", 501, "该工具尚未接入。");
  };
}

/**
 * 工作区登记：两段式。`__phase=prepare` 只读文件、算摘要、整理元数据（供审批绑定内容）；
 * `__phase=commit` 在批准之后重新校验摘要并正式入档。
 */
async function registerPaper(
  dependencies: DispatchDependencies,
  context: AuthorizedCapability,
  call: KernelToolCall,
): Promise<unknown> {
  const roots = workspaceRoots(dependencies, call);
  const phase = (call.args as any)?.__phase;
  if (phase === "commit") {
    const prepared = await prepareRegistration(call.args as any, roots);
    return dependencies.db.withAccount(call.account, (client) =>
      commitRegistration(client, { deposit: dependencies.deposit, context, cacheRoot: dependencies.cacheRoot }, {
        account: call.account,
        dossier: call.dossier,
        run: call.run,
        prepared,
        expectedDigest: String((call.args as any).__digest ?? prepared.digest),
      }),
    );
  }
  const prepared = await prepareRegistration(call.args as any, roots);
  const existing = await dependencies.db.withAccount(call.account, (client) =>
    existingByDigest(client, call.account, call.dossier, prepared.digest),
  );
  return {
    phase: "prepare",
    digest: prepared.digest,
    existing,
    metadata: prepared.metadata,
    path: prepared.absolute,
  };
}

/** 当前档案的工作区：宿主机目录 + 容器里看到的同一目录。 */
function workspaceRoots(dependencies: DispatchDependencies, call: KernelToolCall): WorkspaceRoots {
  const base = dependencies.kernelHome ?? path.join(homedir(), ".local/state/reinlab/kernel");
  return {
    host: path.join(base, "accounts", call.account, "dossiers", call.dossier),
    container: "/opt/reinlab-account/dossiers/" + call.dossier,
  };
}

async function recordPageReads(
  db: Database,
  call: KernelToolCall,
  result: Record<string, unknown>,
): Promise<void> {
  const assetId = typeof result?.assetId === "string" ? result.assetId : "";
  const pages = Array.isArray(result?.pages) ? result.pages : [];
  if (!assetId || pages.length === 0) return;
  await db.withAccount(call.account, async (client) => {
    for (const entry of pages as Array<{ page?: unknown; text?: unknown }>) {
      const page = Number(entry?.page);
      const text = typeof entry?.text === "string" ? entry.text : "";
      if (!Number.isSafeInteger(page) || page < 1 || !text) continue;
      const digest = createHash("sha256").update(text).digest("hex");
      await client.query(
        `insert into paper_page_read(account_id,dossier_id,run_id,asset_id,page,text_sha256,page_text)
         values($1,$2,$3,$4,$5,$6,$7)
         on conflict do nothing`,
        [call.account, call.dossier, call.run, assetId, page, digest, text.slice(0, 4 * 1024 * 1024)],
      );
    }
  });
}

async function withAssetId(
  db: Database,
  call: KernelToolCall,
): Promise<Record<string, unknown>> {
  const args = { ...(call.args ?? {}) } as Record<string, any>;
  const isAssetId = (value: unknown) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const resolve = async (value: unknown): Promise<string | undefined> => {
    if (typeof value !== "string" || value === "" || isAssetId(value)) return undefined;
    const row = (
      await db.withAccount(call.account, (client) =>
        client.query(
          "select id from paper_asset where account_id=$1 and dossier_id=$2 and run_id=$3 and paper_id=$4 order by created_at desc limit 1",
          [call.account, call.dossier, call.run, value],
        ),
      )
    ).rows[0];
    return row?.id;
  };
  // 卡片工具的参数有两种形状：直接把字段摊在 args 上，或者整张卡放在 args.card。
  const card = (args.card && typeof args.card === "object" && !Array.isArray(args.card))
    ? (args.card as Record<string, any>)
    : args;
  const mapped = await resolve(card.paperId ?? card.assetId);
  if (mapped) {
    if (card.paperId) card.paperId = mapped;
    if (card.assetId) card.assetId = mapped;
  }
  if (Array.isArray(card.evidence)) {
    for (const entry of card.evidence) {
      const asset = await resolve(entry?.paperId);
      if (asset) entry.paperId = asset;
    }
  }
  if (Array.isArray(card.items)) {
    for (const item of card.items) {
      if (!Array.isArray(item?.citations)) continue;
      for (const citation of item.citations) {
        const asset = await resolve(citation?.paperId);
        if (asset) citation.paperId = asset;
      }
    }
  }
  // 分层讲解卡的页码依据挂在 body[].refs[] 上，那里同样按资产 id 核账。
  // 模型照样会写 arXiv / OpenAlex 号，不换就会被 schema 整张拒掉。
  if (Array.isArray(card.body)) {
    for (const entry of card.body) {
      if (!Array.isArray(entry?.refs)) continue;
      for (const ref of entry.refs) {
        const asset = await resolve(ref?.paperId);
        if (asset) ref.paperId = asset;
      }
    }
  }
  return args;
}
