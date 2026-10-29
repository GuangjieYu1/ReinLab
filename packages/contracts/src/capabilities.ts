import { z } from "zod";
import { ToolRegistry } from "./bench";

const id = z.string().regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/).max(160);
const jsonSchema = z.object({ type: z.literal("object") }).passthrough();
const relativeDirectory = z.string().max(300).refine(value =>
  /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\/$/.test(value) &&
  value.split("/").every(part => part !== "." && part !== ".."));
export const Capability = z.object({
  server: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  capability: id,
  placement: z.enum(["account", "control", "shared", "external"]),
  risk: z.enum(["read", "write", "danger"]),
  effects: z.enum(["none", "dossier_write", "memory_proposal", "ui_card", "network_fetch"]),
  input: jsonSchema,
  output: jsonSchema,
  idempotent: z.boolean(),
  egress: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(16),
  availability: z.enum(["implemented", "planned"]),
  review: z.object({
    source: z.string().url(), license: z.string().min(1), version: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), reviewedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.risk !== "read" && !value.idempotent)
    ctx.addIssue({ code: "custom", message: "写类能力必须要求请求编号" });
  if (value.placement === "external" && !value.review)
    ctx.addIssue({ code: "custom", message: "外部能力必须有锁定版本和审查记录" });
  if (value.effects !== "network_fetch" && value.egress.length)
    ctx.addIssue({ code: "custom", message: "非网络能力不得声明外网" });
});
export const CapabilityRegistryDocument = ToolRegistry.extend({
  capabilityRevision: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/).optional(),
  capabilities: z.record(id, Capability).optional(),
  aliases: z.record(z.string(), z.array(z.object({
    capability: id,
    pathPrefix: relativeDirectory.optional(),
    minimumPermission: z.enum(["allow", "ask"]).optional(),
  }).strict()).min(1).max(16)).optional(),
}).superRefine((table, ctx) => {
  if (!table.capabilityRevision && !table.capabilities && !table.aliases) return;
  if (!table.capabilityRevision || !table.capabilities || !table.aliases) {
    ctx.addIssue({ code: "custom", message: "能力目录、别名及revision必须一起声明" }); return;
  }
  for (const [name, definition] of Object.entries(table.capabilities))
    if (name !== `${definition.server}.${definition.capability}`)
      ctx.addIssue({ code: "custom", path: ["capabilities", name], message: "能力名称与服务器不一致" });
  for (const [alias, targets] of Object.entries(table.aliases)) {
    if (!Object.hasOwn(table.tools, alias) || table.tools[alias].availability === "native")
      ctx.addIssue({ code: "custom", path: ["aliases", alias], message: "别名必须引用已登记业务工具，不得替换原生工具" });
    for (const target of targets)
      if (!Object.hasOwn(table.capabilities, target.capability))
        ctx.addIssue({ code: "custom", path: ["aliases", alias], message: "别名引用未登记能力" });
  }
});
export type Capability = z.infer<typeof Capability>;
export type CapabilityRegistryDocument = z.infer<typeof CapabilityRegistryDocument>;

/** The unchanged v1 document is the identity of already published manifests.
 * Capability authorization is separately revisioned and pinned per run. */
export function legacyRegistryCore(table: CapabilityRegistryDocument): ToolRegistry {
  return ToolRegistry.parse({ schema: table.schema, tools: table.tools, mcp: table.mcp, delegations: table.delegations });
}
