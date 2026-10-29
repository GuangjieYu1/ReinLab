import type { CapabilityCatalog } from "./registry";
import type { TokenClaims } from "./token";

/** 内核工具处理函数的入参：账户/档案/运行 + 能力目录（出站白名单在目录里）。 */
export type AuthorizedCapability = {
  claims: TokenClaims;
  scope: { grants: Array<{ name: string; permission: "allow" | "ask" }> };
  catalog: CapabilityCatalog;
};

export type CapabilityHandler = (
  context: AuthorizedCapability,
  args: Record<string, unknown>,
  requestId: string,
) => Promise<Record<string, unknown>>;

/** Where a finished card file goes (kernel: this account's dossier on disk). */
export type CardDeposit = (
  context: AuthorizedCapability,
  id: string,
  name: string,
  card: Record<string, unknown>,
  writeTargets: string[],
) => Promise<void>;
