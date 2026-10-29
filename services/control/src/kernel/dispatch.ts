import type { Database } from "../db/database";
import { loadCapabilityCatalog, type CapabilityCatalog } from "../mcp/registry";
import { paperHandlers, type PaperDeposit } from "../mcp/papers";
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
      const handler = table[`papers.${call.tool}`];
      if (!handler) throw new ApiFailure("KERNEL_TOOL_UNSUPPORTED", 501, "该论文工具尚未接入。");
      const result = await handler(contextFor(current), call.args, randomUUID());
      // Reading a page is a citation receipt: the card check requires these rows,
      // so the kernel path records them the same way the old engine did.
      if (call.tool === "pages") await recordPageReads(dependencies.db, call, result);
      return result;
    }
    throw new ApiFailure("KERNEL_TOOL_UNSUPPORTED", 501, "该工具尚未接入。");
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
  const mapped = await resolve(args.paperId);
  if (mapped) args.paperId = mapped;
  if (Array.isArray(args.evidence)) {
    for (const entry of args.evidence) {
      const asset = await resolve(entry?.paperId);
      if (asset) entry.paperId = asset;
    }
  }
  if (Array.isArray(args.items)) {
    for (const item of args.items) {
      if (!Array.isArray(item?.citations)) continue;
      for (const citation of item.citations) {
        const asset = await resolve(citation?.paperId);
        if (asset) citation.paperId = asset;
      }
    }
  }
  return args;
}
