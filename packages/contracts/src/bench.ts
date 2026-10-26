import { z } from "zod";
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const benchId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const permission = z.enum(["allow", "ask", "deny"]);
const tier = z.enum(["cheap", "mid", "strong"]);
// Manifest data field; this is not a CommonJS module loader.
const requiredArtifactsField = "require" as const;
const layer = z.enum(["L1", "L2", "L3", "L4"]);
const names = z
  .array(name)
  .max(128)
  .refine((value) => new Set(value).size === value.length);
const layers = z
  .array(layer)
  .max(4)
  .refine((value) => new Set(value).size === value.length);
const tools = z.record(z.union([name, z.literal("*")]), permission);
const money = z.number().finite().positive().max(999999.999999).nullable();
const modeBudget = z
  .object({
    read: money.optional(),
    swarm: money.optional(),
    auto: money.optional(),
  })
  .strict();
export const BenchBudget = z
  .object({ default_cny: money, by_mode: modeBudget })
  .strict();
export const BenchRole = z
  .object({
    prompt: z.string().min(1).max(300),
    model_slot: name,
    steps: z.number().int().min(1).max(512),
    capability_allowlist: z
      .array(z.string().regex(/^[a-z][a-z0-9_.-]+$/))
      .max(128)
      .optional(),
    model_cap: z
      .object({
        cny: z.literal(0.05),
        rounds: z.literal(6),
        output_tokens: z.union([z.literal(256), z.literal(512)]),
      })
      .strict()
      .optional(),
    tools,
    mcp: z.record(name, names).default({}),
    write_targets: z.array(z.string().min(1).max(300)).max(64),
    memory: z
      .object({
        read: layers,
        write: layers,
        dossier: z.literal("current"),
        messages: z.literal("own"),
        refs: z.enum(["explicit", "assigned-citations"]),
      })
      .strict(),
  })
  .strict();
export const ToolRegistry = z
  .object({
    schema: z.literal("reinlab.tools/v1"),
    tools: z.record(
      name,
      z
        .object({
          risk: z.enum(["read", "write", "danger"]),
          availability: z.enum(["native", "implemented", "planned"]),
          description: z.string().max(1000).optional(),
        })
        .strict()
    ),
    mcp: z
      .record(
        name,
        z
          .object({
            capabilities: names,
            availability: z.enum(["implemented", "planned"]),
          })
          .strict()
      )
      .default({}),
    delegations: z
      .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/))
      .max(128)
      .default([]),
  })
  .strict();
export type ToolRegistry = z.infer<typeof ToolRegistry>;
const Manifest = z
  .object({
    schema: z.literal("reinlab.bench/v1"),
    id: benchId,
    version: z
      .string()
      .regex(
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[a-zA-Z0-9.-]+)?$/
      ),
    code: z.string().regex(/^[A-Z][A-Z0-9]{1,11}$/),
    title: z.string().min(1).max(100),
    ui: z.enum(["custom", "generic"]),
    dossier: z
      .object({
        layout: z.array(z.string().min(1).max(300)).max(64),
        templates: z.record(z.string(), z.string()).default({}),
      })
      .strict(),
    model_slots: z
      .record(name, tier)
      .refine((value) => Object.keys(value).length > 0),
    entrypoints: z.object({ read: name, swarm: name, auto: name }).strict(),
    roles: z
      .record(name, BenchRole)
      .refine(
        (value) =>
          Object.keys(value).length > 0 && Object.keys(value).length <= 64
      ),
    gates: z.record(
      name,
      z
        .object({
          stages: names.refine((value) => value.length > 0),
          [requiredArtifactsField]: z
            .record(
              name,
              z.array(z.string().regex(/^artifact:[a-z][a-z0-9_-]*$/))
            )
            .default({}),
          approve: z.literal("user"),
        })
        .strict()
    ),
    engines: z.record(
      name,
      z.object({ adapter: name, capabilities: names }).strict()
    ),
    delegations: z
      .object({
        accepts: z
          .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/))
          .max(128),
        sends: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/)).max(128),
      })
      .strict(),
    cards: z.record(
      name,
      z
        .object({
          schema: z.string().min(1).max(300),
          ui: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/),
          tool: name,
        })
        .strict()
    ),
    budget: BenchBudget,
    tunable: z.array(z.string().min(1).max(120)).max(32),
    metadata: z.record(z.string().max(100), z.string().max(2000)).default({}),
  })
  .strict();
export const BenchManifest = Manifest.superRefine((manifest, context) => {
  for (const [mode, role] of Object.entries(manifest.entrypoints))
    if (!Object.hasOwn(manifest.roles, role))
      context.addIssue({
        code: "custom",
        path: ["entrypoints", mode],
        message: "入口引用未声明角色",
      });
  for (const [role, value] of Object.entries(manifest.roles))
    if (!Object.hasOwn(manifest.model_slots, value.model_slot))
      context.addIssue({
        code: "custom",
        path: ["roles", role, "model_slot"],
        message: "角色引用未声明模型位置",
      });
  for (const [gate, value] of Object.entries(manifest.gates)) {
    const { [requiredArtifactsField]: requirements } = value;
    for (const stage of Object.keys(requirements))
      if (!value.stages.includes(stage))
        context.addIssue({
          code: "custom",
          path: ["gates", gate, "require", stage],
          message: "产物约束引用未声明阶段",
        });
  }
});
export type BenchManifest = z.infer<typeof BenchManifest>;
export type BenchRole = z.infer<typeof BenchRole>;
export type BenchPermission = z.infer<typeof permission>;
export const BenchPatch = z
  .object({
    model_slots: z.record(name, tier).optional(),
    budget: z
      .object({ default_cny: money.optional(), by_mode: modeBudget.optional() })
      .strict()
      .optional(),
    roles: z
      .record(
        name,
        z
          .object({
            tools: tools.optional(),
            write_targets: z
              .array(z.string().min(1).max(300))
              .max(64)
              .optional(),
            memory: z
              .object({ read: layers.optional(), write: layers.optional() })
              .strict()
              .optional(),
            dossier_note: z.string().max(32768).optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();
export type BenchPatch = z.infer<typeof BenchPatch>;
/** Identity validation only; permission ordering and approved loosening belong to the resolver. */
export function benchPatchFor(manifest: BenchManifest) {
  return BenchPatch.superRefine((patch, context) => {
    for (const role of Object.keys(patch.roles ?? {}))
      if (!Object.hasOwn(manifest.roles, role))
        context.addIssue({
          code: "custom",
          path: ["roles", role],
          message: "不能新增角色",
        });
    for (const slot of Object.keys(patch.model_slots ?? {}))
      if (!Object.hasOwn(manifest.model_slots, slot))
        context.addIssue({
          code: "custom",
          path: ["model_slots", slot],
          message: "不能新增模型位置",
        });
  });
}
