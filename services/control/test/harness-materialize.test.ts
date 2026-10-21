import { beforeAll, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { loadToolRegistry, loadBenchBundle } from "../src/harness/manifest";
import { initialEffective, planBenchPatch } from "../src/harness/resolver";
import { materializeHarnessRole } from "../src/harness/materialize";
import {
  planRoleProject,
  RoleProjectRequest,
} from "../src/bridge/openscience/role-project";
import { canonical } from "../src/api/context";
import { fixtureBenchWithTunables } from "./fixtures/bench-tunable";
let registry: Awaited<ReturnType<typeof loadToolRegistry>>;
let effective: ReturnType<typeof initialEffective>;
const options = () => ({
  dossierId: randomUUID(),
  roleId: "research-read",
  modelRoutes: {
    cheap: "fixture/cheap",
    mid: "fixture/mid",
    strong: "fixture/strong",
  },
  memory: "SERVER_FILTERED_MEMORY",
});
beforeAll(async () => {
  registry = await loadToolRegistry();
  effective = initialEffective(
    await loadBenchBundle({ benchId: "research", registry }),
  );
});
it("materializes all ten actual research roles without role_def", () => {
  expect(Object.keys(effective.manifest.roles)).toHaveLength(10);
  for (const roleId of Object.keys(effective.manifest.roles)) {
    const result = materializeHarnessRole(effective, registry, {
      ...options(),
      roleId,
    });
    expect(RoleProjectRequest.parse(result)).toEqual(result);
    const role = effective.manifest.roles[roleId];
    expect(result.role.prompt).toContain(effective.prompts[roleId]);
    expect(result.role.steps).toBe(role.steps);
    expect(result.role.writeTargets).toEqual(role.write_targets);
    expect(result.role.toolGrants.task.permission).toBe("deny");
    expect(result.role.toolGrants).not.toHaveProperty("*");
    expect(
      planRoleProject({
        ...result,
        root: "/data",
        pluginUrl: "file:///opt/reinlab/plugin/index.js",
      }).project.roleId,
    ).toBe(roleId);
  }
});
it("routes models only through effective slot tiers and appends only own notes", () => {
  const candidate = planBenchPatch(
    fixtureBenchWithTunables(effective, [
      ...effective.manifest.tunable,
      "roles.*.dossier_note",
    ]),
    {
      model_slots: { strong: "cheap" },
      roles: {
        "research-read": { dossier_note: "OWN_DOSSIER_NOTE" },
        "research-auto": { dossier_note: "OTHER_ROLE_NOTE" },
      },
    },
    registry,
    100,
  ).candidate;
  const request = materializeHarnessRole(candidate, registry, options());
  expect(request.model).toBe("fixture/cheap");
  expect(request.memory).toBe("SERVER_FILTERED_MEMORY");
  expect(request.role.prompt).toContain("OWN_DOSSIER_NOTE");
  expect(request.role.prompt).not.toContain("OTHER_ROLE_NOTE");
});
it("allows only strictly bounded step tightening", () => {
  expect(
    materializeHarnessRole(effective, registry, { ...options(), maxSteps: 1 })
      .role.steps,
  ).toBe(1);
  for (const maxSteps of [0, 49, 1.5, NaN])
    expect(() =>
      materializeHarnessRole(effective, registry, { ...options(), maxSteps }),
    ).toThrow();
});
it("strips wildcard and applies task/danger deny while preserving registry risks", () => {
  const raw = structuredClone(effective);
  raw.manifest.roles["research-read"].tools = {
    "*": "deny",
    task: "deny",
    bash: "ask",
    read: "allow",
  };
  const { digest: _digest, ...body } = raw;
  raw.digest = createHash("sha256").update(canonical(body)).digest("hex");
  const request = materializeHarnessRole(raw, registry, options());
  expect(request.role.toolGrants).toEqual({
    task: { risk: "danger", permission: "deny" },
    bash: { risk: "danger", permission: "deny" },
    read: { risk: "read", permission: "allow" },
  });
});
it("rejects unknown role, missing route, changed registry and snapshot corruption", () => {
  expect(() =>
    materializeHarnessRole(effective, registry, {
      ...options(),
      roleId: "unknown",
    }),
  ).toThrow();
  expect(() =>
    materializeHarnessRole(effective, registry, {
      ...options(),
      modelRoutes: {},
    }),
  ).toThrow();
  const changed = structuredClone(registry);
  changed.tools.read.risk = "danger";
  expect(() => materializeHarnessRole(effective, changed, options())).toThrow();
  const changedEffective = structuredClone(effective);
  changedEffective.prompts["research-read"] = "forged";
  expect(() =>
    materializeHarnessRole(changedEffective, registry, options()),
  ).toThrow();
});
it("rejects unsafe prompt templates and unsupported MCP even in a sealed snapshot", () => {
  for (const kind of ["prompt", "mcp"]) {
    const raw = structuredClone(effective);
    if (kind === "prompt") raw.prompts["research-read"] = "{env:FIXTURE_ONLY}";
    else {
      raw.manifest.roles["research-read"].mcp = { fixture: [] };
    }
    const { digest: _digest, ...body } = raw;
    raw.digest = createHash("sha256").update(canonical(body)).digest("hex");
    expect(() => materializeHarnessRole(raw, registry, options())).toThrow();
  }
});

it("rejects interpolated or oversized server memory and oversized effective notes", () => {
  for (const memory of ["{file:/fixture}", "x".repeat(131073)])
    expect(() =>
      materializeHarnessRole(effective, registry, { ...options(), memory }),
    ).toThrow();
  const raw = structuredClone(effective);
  raw.dossierNotes["research-read"] = "x".repeat(32768);
  const { digest: _digest, ...body } = raw;
  raw.digest = createHash("sha256").update(canonical(body)).digest("hex");
  expect(() => materializeHarnessRole(raw, registry, options())).toThrow();
});
