import { it, expect } from "vitest";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import {
  compileCapabilityGrants,
  loadCapabilityCatalog,
} from "../src/mcp/registry";
import { initialEffective } from "../src/harness/resolver";
import { materializeHarnessRole } from "../src/harness/materialize";
it("research1.2 publishes a cheap search-only clarification role with immutable model ceiling; old1.1 stays readable", async () => {
  const registry = await loadToolRegistry(),
    bundle = await loadBenchBundle({ benchId: "research", registry });
  expect(bundle.manifest.version).toBe("1.2.1");
  const role = bundle.manifest.roles["research-clarify"];
  expect(role).toMatchObject({
    model_slot: "cheap",
    steps: 6,
    write_targets: [],
    model_cap: { cny: 0.05, rounds: 6, output_tokens: 512 },
  });
  expect(
    compileCapabilityGrants(role, await loadCapabilityCatalog()).map(
      (g) => g.name
    )
  ).toEqual(["papers.search"]);
  const built = materializeHarnessRole(initialEffective(bundle), registry, {
    dossierId: "11111111-1111-4111-8111-111111111111",
    roleId: "research-clarify",
    modelRoutes: { cheap: "deepseek/deepseek-v4-flash" },
    memory: "",
  });
  expect(built.role.toolGrants.question.permission).toBe("allow");
  expect(built.role.toolGrants.task.permission).toBe("deny");
  expect(
    (await loadBenchBundle({ benchId: "research", registry, version: "1.1.0" }))
      .manifest.roles["research-clarify"]
  ).toBeUndefined();
});

it("previous research1.2.0 keeps its frozen 256-token prompt", async()=>{const registry=await loadToolRegistry();const old=await loadBenchBundle({benchId:"research",registry,version:"1.2.0"});expect(old.manifest.roles["research-clarify"].model_cap?.output_tokens).toBe(256);});
