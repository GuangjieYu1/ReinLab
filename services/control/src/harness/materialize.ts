import { createHash } from "node:crypto";
import { ToolRegistry } from "@reinlab/contracts";
import type { z } from "zod";
import { canonical } from "../api/context";
import { ApiFailure } from "../api/errors";
import { verifyEffective, type EffectiveBench } from "./resolver";
import { RoleProjectRequest } from "../bridge/openscience/role-project";
export type MaterializeRoleOptions = {
  dossierId: string;
  roleId: string;
  modelRoutes: Partial<Record<"cheap" | "mid" | "strong", string>>;
  memory: string;
  maxSteps?: number;
};
const invalid = () =>
  new ApiFailure(
    "HARNESS_MATERIALIZATION_FAILED",
    503,
    "工作台角色配置无法安全生成。"
  );
/** Server-side translation. Caller supplies already scope-filtered memory and trusted routes. */
export function materializeHarnessRole(
  effective: EffectiveBench,
  registry: ToolRegistry,
  options: MaterializeRoleOptions
): z.infer<typeof RoleProjectRequest> {
  try {
    const trusted = ToolRegistry.parse(registry),
      verified = verifyEffective(effective, trusted);
    if (
      createHash("sha256").update(canonical(trusted)).digest("hex") !==
      verified.registryHash
    )
      throw invalid();
    if (!Object.hasOwn(verified.manifest.roles, options.roleId))
      throw invalid();
    const role = verified.manifest.roles[options.roleId];
    if (
      Object.keys(role.mcp).length ||
      verified.manifest.delegations.accepts.length ||
      verified.manifest.delegations.sends.length
    )
      throw invalid();
    const tier = verified.manifest.model_slots[role.model_slot];
    if (!tier || !Object.hasOwn(options.modelRoutes, tier)) throw invalid();
    const steps = options.maxSteps ?? role.steps;
    if (!Number.isInteger(steps) || steps < 1 || steps > role.steps)
      throw invalid();
    const toolGrants: z.infer<typeof RoleProjectRequest>["role"]["toolGrants"] =
      {};
    for (const [tool, permission] of Object.entries(role.tools)) {
      if (tool === "*") {
        if (permission !== "deny") throw invalid();
        continue;
      }
      if (!Object.hasOwn(trusted.tools, tool)) throw invalid();
      const risk = trusted.tools[tool].risk;
      toolGrants[tool] = {
        risk,
        permission: risk === "danger" || tool === "task" ? "deny" : permission,
      };
    }
    toolGrants.task = { risk: "danger", permission: "deny" };
    if (role.model_cap)
      toolGrants.question = { risk: "read", permission: "allow" };
    const note = verified.dossierNotes[options.roleId];
    if (note !== undefined && typeof note !== "string") throw invalid();
    const prompt =
      verified.prompts[options.roleId] +
      (note ? "\n\n## Dossier instructions\n" + note : "");
    const request = RoleProjectRequest.parse({
      dossierId: options.dossierId,
      role: {
        id: options.roleId,
        prompt,
        toolGrants,
        writeTargets: [...role.write_targets],
        steps,
        ...(role.model_cap ? { modelCap: role.model_cap } : {}),
      },
      model: options.modelRoutes[tier],
      memory: options.memory,
    });
    if (/\{(?:file|env):/i.test(JSON.stringify(request))) throw invalid();
    return request;
  } catch {
    throw invalid();
  }
}
