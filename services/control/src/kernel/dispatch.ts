import type { Database } from "../db/database";
import { loadCapabilityCatalog, type CapabilityCatalog } from "../mcp/registry";
import { paperHandlers, type PaperDeposit } from "../mcp/papers";
import { ApiFailure } from "../api/errors";
import type { TokenClaims } from "../mcp/token";
import type { AuthorizedCapability } from "../mcp/authority";
import type { KernelToolCall } from "../api/kernel-tools";
import { randomUUID } from "node:crypto";

export type DispatchDependencies = {
  db: Database;
  cacheRoot: string;
  deposit: PaperDeposit;
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

    if (call.server === "papers") {
      const { catalog: current, handlers: table } = await paper();
      const handler = table[`papers.${call.tool}`];
      if (!handler) throw new ApiFailure("KERNEL_TOOL_UNSUPPORTED", 501, "该论文工具尚未接入。");
      return handler(contextFor(current), call.args, randomUUID());
    }
    throw new ApiFailure("KERNEL_TOOL_UNSUPPORTED", 501, "该工具尚未接入。");
  };
}
