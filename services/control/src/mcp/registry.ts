import Ajv from "ajv";
import { createHash } from "node:crypto";
import type { BenchRole, CapabilityRegistryDocument } from "@reinlab/contracts";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";
import { loadRegistryDocument } from "../harness/manifest";

export type CapabilityCatalog = {
  revision: string;
  digest: string;
  capabilities: NonNullable<CapabilityRegistryDocument["capabilities"]>;
  aliases: NonNullable<CapabilityRegistryDocument["aliases"]>;
};
export type CapabilityGrant = {
  name: string;
  permission: "allow" | "ask";
  writeTargets: string[];
};
const unavailable = () =>
  new ApiFailure("CAPABILITY_REGISTRY_INVALID", 503, "能力目录未通过验证。");
export async function loadCapabilityCatalog(
  root?: string
): Promise<CapabilityCatalog> {
  const registry = await loadRegistryDocument(root);
  if (
    !registry.capabilityRevision ||
    !registry.capabilities ||
    !registry.aliases
  )
    throw unavailable();
  const validator = new Ajv({ strict: true, validateFormats: true });
  validator.addFormat(
    "uuid",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  try {
    for (const cap of Object.values(registry.capabilities)) {
      validator.compile(cap.input);
      validator.compile(cap.output);
    }
  } catch {
    throw unavailable();
  }
  const snapshot = {
    revision: registry.capabilityRevision,
    capabilities: registry.capabilities,
    aliases: registry.aliases,
  };
  return {
    ...snapshot,
    digest: createHash("sha256").update(canonical(snapshot)).digest("hex"),
  };
}
export function requireImplemented(catalog: CapabilityCatalog, name: string) {
  const capability = Object.hasOwn(catalog.capabilities, name)
    ? catalog.capabilities[name]
    : undefined;
  if (!capability)
    throw new ApiFailure("CAPABILITY_DENIED", 403, "此能力未登记。");
  if (capability.availability === "planned")
    throw new ApiFailure("NOT_IMPLEMENTED", 501, "此能力尚未实现。");
  return capability;
}
function intersection(targets: string[], prefix?: string) {
  if (!prefix) return [...targets];
  return targets.flatMap((target) => {
    if (target === prefix || target.startsWith(prefix)) return [target];
    if (target.endsWith("/") && prefix.startsWith(target)) return [prefix];
    return [];
  });
}
/** Capabilities are an intersection of the frozen role and reviewed alias scope.
 * Aliases never turn a specialized tool into unrestricted files.write. */
export function compileCapabilityGrants(
  role: BenchRole,
  catalog: CapabilityCatalog
): CapabilityGrant[] {
  const grants = new Map<string, CapabilityGrant>();
  const add = (name: string, permission: "allow" | "ask", prefix?: string) => {
    if (role.capability_allowlist && !role.capability_allowlist.includes(name))
      return;
    const cap = Object.hasOwn(catalog.capabilities, name)
      ? catalog.capabilities[name]
      : undefined;
    if (!cap) throw unavailable();
    const targets = name.startsWith("files.")
      ? intersection(role.write_targets, prefix)
      : [];
    if (
      ["files.write", "files.patch", "files.undo"].includes(name) &&
      !targets.length
    )
      return;
    const old = grants.get(name);
    grants.set(name, {
      name,
      permission:
        cap.risk === "danger" ||
        permission === "ask" ||
        old?.permission === "ask"
          ? "ask"
          : "allow",
      writeTargets: [
        ...new Set([...(old?.writeTargets ?? []), ...targets]),
      ].sort(),
    });
  };
  for (const [alias, permission] of Object.entries(role.tools)) {
    if (permission === "deny") continue;
    for (const mapping of (Object.hasOwn(catalog.aliases, alias)
      ? catalog.aliases[alias]
      : []) ?? [])
      add(
        mapping.capability,
        permission === "ask" || mapping.minimumPermission === "ask"
          ? "ask"
          : "allow",
        mapping.pathPrefix
      );
  }
  for (const [server, capabilities] of Object.entries(role.mcp))
    for (const capability of capabilities) {
      const name = `${server}.${capability}`,
        definition = Object.hasOwn(catalog.capabilities, name)
          ? catalog.capabilities[name]
          : undefined;
      if (!definition) throw unavailable();
      add(name, definition.risk === "read" ? "allow" : "ask");
    }
  return [...grants.values()].sort((a, b) => a.name.localeCompare(b.name));
}
