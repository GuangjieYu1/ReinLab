import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadToolRegistry } from "../src/harness/manifest";
import { canonical } from "../src/api/context";
import {
  loadCapabilityCatalog,
  requireImplemented,
  compileCapabilityGrants,
} from "../src/mcp/registry";
import { loadBenchBundle } from "../src/harness/manifest";

it("MCP capability table describes all four servers and preserves legacy aliases", async () => {
  const table = JSON.parse(await readFile("tools/registry.json", "utf8"));
  for (const name of [
    "files.list",
    "files.read",
    "files.write",
    "files.patch",
    "memory.read",
    "memory.propose",
    "cards.card.answer",
    "cards.approval.request",
    "cards.gate.request_open",
    "papers.search",
    "papers.fetch",
    "papers.pages",
  ]) {
    const cap = table.capabilities?.[name];
    expect(cap, name).toBeDefined();
    for (const field of [
      "server",
      "capability",
      "placement",
      "risk",
      "effects",
      "input",
      "output",
      "idempotent",
      "egress",
      "availability",
      "review",
    ])
      expect(Object.hasOwn(cap, field), `${name}.${field}`).toBe(true);
    if (cap.risk !== "read") expect(cap.idempotent).toBe(true);
  }
  expect(table.aliases.literature.map((v: any) => v.capability)).toEqual([
    "papers.search",
    "papers.fetch",
    "papers.pages",
  ]);
  expect(table.aliases.finding_record).toContainEqual({
    capability: "files.write",
    pathPrefix: "findings/",
    minimumPermission: "ask",
  });
});

it("planned capabilities fail explicitly and the independent capability revision is hashed", async () => {
  const catalog = await loadCapabilityCatalog();
  expect(catalog.digest).toMatch(/^[a-f0-9]{64}$/);
  const planned = structuredClone(catalog);
  planned.capabilities["files.write"].availability = "planned";
  expect(() => requireImplemented(planned, "files.write")).toThrow(
    expect.objectContaining({ code: "NOT_IMPLEMENTED", status: 501 }),
  );
  expect(() => requireImplemented(catalog, "not.registered")).toThrow(
    expect.objectContaining({ code: "CAPABILITY_DENIED" }),
  );
  for (const inherited of ["constructor", "toString", "__proto__"])
    expect(() => requireImplemented(catalog, inherited)).toThrow(
      expect.objectContaining({ code: "CAPABILITY_DENIED" }),
    );
});

it("legacy alias grants are narrowed and literature fetch cannot acquire write permission without approval", async () => {
  const registry = await loadToolRegistry(),
    catalog = await loadCapabilityCatalog();
  const bundle = await loadBenchBundle({ benchId: "research", registry });
  const role = structuredClone(bundle.manifest.roles["research-read"]);
  const grants = compileCapabilityGrants(role, catalog);
  expect(grants.find((g) => g.name === "papers.search")?.permission).toBe(
    "allow",
  );
  expect(grants.find((g) => g.name === "papers.fetch")?.permission).toBe("ask");
  expect(grants.find((g) => g.name === "files.write")).toEqual({
    name: "files.write",
    permission: "ask",
    writeTargets: ["findings/", "read/layers/", "read/quizzes/"],
  });
  role.tools = { finding_record: "allow" };
  role.write_targets = ["findings/", "results/"];
  expect(
    compileCapabilityGrants(role, catalog).find(
      (g) => g.name === "files.write",
    ),
  ).toEqual({
    name: "files.write",
    permission: "ask",
    writeTargets: ["findings/"],
  });
  role.tools.finding_record = "deny";
  expect(compileCapabilityGrants(role, catalog)).toEqual([]);
});

it("extended capability metadata does not rewrite the frozen v1 registry core", async () => {
  const table = JSON.parse(await readFile("tools/registry.json", "utf8"));
  const core = await loadToolRegistry();
  expect(core).toEqual({
    schema: table.schema,
    tools: table.tools,
    mcp: table.mcp,
    delegations: table.delegations,
  });
  expect(createHash("sha256").update(canonical(core)).digest("hex")).toBe(
    "35f5aaf3682f03ab094c30074beacef5a76071b08ed0bab49188800d39fa906e",
  );
});
