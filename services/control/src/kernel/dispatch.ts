import type { Database } from "../db/database";
import { loadCapabilityCatalog, type CapabilityCatalog } from "../mcp/registry";
import { paperHandlers, type PaperDeposit } from "../mcp/papers";
import { dataHandlers, type CardDeposit } from "../mcp/data-handlers";
import { ApiFailure } from "../api/errors";
import type { TokenClaims } from "../mcp/token";
import type { AuthorizedCapability } from "../mcp/authority";
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
  let cards: ReturnType<typeof dataHandlers> | undefined;

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
      cards ??= (dependencies.cardHandlers
        ? dependencies.cardHandlers(dependencies.db, dependencies.cardDeposit)
        : dataHandlers(dependencies.db, dependencies.cardDeposit)) as ReturnType<
        typeof dataHandlers
      >;
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
