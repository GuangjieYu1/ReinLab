import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BenchManifest,
  benchPatchFor,
  type ToolRegistry,
} from "@reinlab/contracts";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
const roots: string[] = [];
const requiredArtifactsField = "require" as const;
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const registry: ToolRegistry = {
  schema: "reinlab.tools/v1",
  tools: {
    read: { risk: "read", availability: "native" },
    write: { risk: "write", availability: "native" },
    bash: { risk: "danger", availability: "native" },
    task: { risk: "danger", availability: "native" },
  },
  mcp: {},
  delegations: [],
};
function manifest() {
  return {
    schema: "reinlab.bench/v1",
    id: "fixture",
    version: "1.0.0",
    code: "FIX",
    title: "fixture",
    ui: "custom",
    dossier: { layout: ["notes/"], templates: {} },
    model_slots: { cheap: "cheap", mid: "mid", strong: "strong" },
    entrypoints: { read: "reader", swarm: "reader", auto: "reader" },
    roles: {
      reader: {
        prompt: "prompts/fixture/read.md",
        model_slot: "mid",
        steps: 4,
        tools: { read: "allow" },
        mcp: {},
        write_targets: [],
        memory: {
          read: ["L2"],
          write: [],
          dossier: "current",
          messages: "own",
          refs: "explicit",
        },
      },
    },
    gates: {
      read: {
        stages: ["ingest", "close"],
        [requiredArtifactsField]: {},
        approve: "user",
      },
    },
    engines: {},
    delegations: { accepts: [], sends: [] },
    cards: {},
    budget: { default_cny: 5, by_mode: { read: 5, swarm: 30, auto: null } },
    tunable: ["model_slots.*", "budget.*"],
    metadata: { source: "fixture" },
  };
}
async function fixture(value: unknown = manifest()) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-bench-manifest-")),
  );
  roots.push(root);
  await mkdir(join(root, "benches"));
  await mkdir(join(root, "prompts/fixture"), { recursive: true });
  await mkdir(join(root, "tools"));
  await writeFile(
    join(root, "benches/fixture.bench.yaml"),
    JSON.stringify(value),
  );
  await writeFile(join(root, "prompts/fixture/read.md"), "fixture prompt\n");
  await writeFile(join(root, "tools/registry.json"), JSON.stringify(registry));
  return {
    root,
    file: join(root, "benches/fixture.bench.yaml"),
    load: () => loadBenchBundle({ root, benchId: "fixture", registry }),
  };
}
it("loads a strict declarative bench and binds prompt bytes into its digest", async () => {
  const f = await fixture(),
    a = await f.load();
  expect(a.manifest.id).toBe("fixture");
  expect(a.prompts.reader).toBe("fixture prompt\n");
  expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(a.referencedHashes["prompts/fixture/read.md"]).toMatch(
    /^[a-f0-9]{64}$/,
  );
  await writeFile(join(f.root, "prompts/fixture/read.md"), "changed prompt\n");
  const b = await f.load();
  expect(b.digest).not.toBe(a.digest);
  expect(b.manifest.version).toBe(a.manifest.version);
});
it.each(["wildcard", "task", "danger", "escape", "file", "env"] as const)(
  "T-HAR1 rejects %s with an error location",
  async (kind) => {
    const value = manifest();
    if (kind === "wildcard") value.roles.reader.tools = { "*": "allow" } as any;
    if (kind === "task") value.roles.reader.tools = { task: "allow" } as any;
    if (kind === "danger") value.roles.reader.tools = { bash: "allow" } as any;
    if (kind === "escape")
      value.roles.reader.write_targets = ["../outside"] as any;
    if (kind === "file") value.metadata.source = "{file:/fixture-private}";
    if (kind === "env") value.metadata.source = "{env:FIXTURE_PRIVATE}";
    const f = await fixture(value);
    const error = await f.load().catch((e) => e);
    expect(error.code).toBe("BENCH_MANIFEST_INVALID");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues[0].path.length).toBeGreaterThan(0);
  },
);
it("also rejects prompt templates, nonexisting registry tools, mismatched entrypoints and schema extras", async () => {
  for (const change of [
    (v: any) => (v.roles.reader.tools = { missing: "allow" }),
    (v: any) => (v.entrypoints.read = "missing"),
    (v: any) => (v.roles.reader.code = "arbitrary logic"),
  ]) {
    const v = manifest();
    change(v);
    const f = await fixture(v);
    await expect(f.load()).rejects.toMatchObject({
      code: "BENCH_MANIFEST_INVALID",
    });
  }
  const f = await fixture();
  await writeFile(
    join(f.root, "prompts/fixture/read.md"),
    "{file:/fixture-private}",
  );
  await expect(f.load()).rejects.toMatchObject({
    code: "BENCH_MANIFEST_INVALID",
  });
});
it("rejects duplicate keys, explicit tags, aliases and prototype keys before accepting YAML", async () => {
  const base = JSON.stringify(manifest());
  const alternate = {
    ...manifest(),
    roles: { ...manifest().roles, second: { ...manifest().roles.reader } },
  };
  const alias = JSON.stringify(alternate)
    .replace('"tools":{"read":"allow"}', '"tools": &shared {"read":"allow"}')
    .replace('"tools":{"read":"allow"}', '"tools": *shared ');
  for (const text of [
    base.replace('"version":"1.0.0"', '"version":"1.0.0","version":"1.0.0"'),
    "!custom " + base,
    alias,
    base.replace('"source":"fixture"', '"constructor":"fixture"'),
  ]) {
    const f = await fixture();
    await writeFile(f.file, text);
    await expect(f.load()).rejects.toMatchObject({
      code: "BENCH_MANIFEST_INVALID",
    });
  }
});
it("refuses cross-bundle paths and symlink/hardlink/missing referenced files", async () => {
  for (const prompt of [
    "../outside.md",
    "/tmp/outside.md",
    "prompts/other/read.md",
  ]) {
    const v = manifest();
    v.roles.reader.prompt = prompt;
    const f = await fixture(v);
    await expect(f.load()).rejects.toMatchObject({
      code: "BENCH_MANIFEST_INVALID",
    });
  }
  for (const mode of ["symlink", "hardlink", "missing"]) {
    const f = await fixture(),
      file = join(f.root, "prompts/fixture/read.md");
    await rm(file);
    const target = join(f.root, "other.md");
    await writeFile(target, "fixture");
    if (mode === "symlink") await symlink(target, file);
    if (mode === "hardlink") await link(target, file);
    await expect(f.load()).rejects.toMatchObject({
      code: "BENCH_MANIFEST_INVALID",
    });
  }
});
it("validates patches against declared roles/slots and never accepts prompt, gate or step overrides", () => {
  const schema = benchPatchFor(BenchManifest.parse(manifest()));
  expect(
    schema.safeParse({ roles: { reader: { tools: { read: "deny" } } } })
      .success,
  ).toBe(true);
  expect(
    schema.safeParse({ roles: { reader: { tools: { write: "ask" } } } })
      .success,
  ).toBe(true); // New known tools are a resolver approval, not immediate authority.
  for (const value of [
    { roles: { other: { tools: { read: "deny" } } } },
    { model_slots: { missing: "strong" } },
    { roles: { reader: { prompt: "changed" } } },
    { gates: {} },
    { roles: { reader: { steps: 100 } } },
  ])
    expect(schema.safeParse(value).success).toBe(false);
});
it("migrates the actual ten role prompts byte-for-byte and keeps unavailable tools visibly planned", async () => {
  const root = resolve("."),
    registry = await loadToolRegistry(root),
    bundle = await loadBenchBundle({ root, benchId: "research", registry });
  expect(Object.keys(bundle.manifest.roles)).toHaveLength(10);
  expect(bundle.manifest.entrypoints).toEqual({
    read: "research-read",
    swarm: "swarm-lead",
    auto: "research-auto",
  });
  for (const [id, role] of Object.entries(bundle.manifest.roles)) {
    expect(bundle.prompts[id]).toBe(
      await readFile(join(root, "services/control/roles", id + ".md"), "utf8"),
    );
    for (const tool of Object.keys(role.tools))
      expect(registry.tools[tool].availability).toBe("planned");
  }
  expect(bundle.manifest.budget.by_mode.auto).toBeNull();
  expect(bundle.manifest.cards).toEqual({});
  const sql = await readFile(
    join(root, "infra/supabase/migrations/202610190002_roles.sql"),
    "utf8",
  );
  const seeds = [
    ...sql.matchAll(
      /\('([^']+)','([^']+)','([^']+)','([^']+)','([^']+)','([^']+)','([^']+)',(\d+)\)/g,
    ),
  ];
  expect(seeds).toHaveLength(10);
  for (const [, id, , , _tier, grants, scope, targets, steps] of seeds) {
    const role = bundle.manifest.roles[id],
      original = JSON.parse(grants),
      memory = JSON.parse(scope);
    expect(role.tools).toEqual(
      Object.fromEntries(
        Object.entries(original).map(([tool, value]) => [
          tool,
          (value as any).permission,
        ]),
      ),
    );
    expect(role.steps).toBe(Number(steps));
    expect(role.write_targets).toEqual(JSON.parse(targets));
    expect(bundle.manifest.model_slots[role.model_slot]).toBe(_tier);
    expect(role.memory).toEqual({
      read: memory.layers,
      write: [],
      dossier: memory.dossier,
      messages: memory.messages,
      refs: memory.refs,
    });
    for (const [tool, value] of Object.entries(original))
      expect(registry.tools[tool].risk).toBe((value as any).risk);
  }
});
it("includes registry and real schema content in the bundle hash without resolving external references", async () => {
  const v: any = manifest();
  v.cards.result = {
    schema: "schemas/fixture/result.json",
    ui: "ResultCard",
    tool: "write",
  };
  const f = await fixture(v);
  await mkdir(join(f.root, "schemas/fixture"), { recursive: true });
  await writeFile(
    join(f.root, "schemas/fixture/result.json"),
    JSON.stringify({ type: "object" }),
  );
  const first = await f.load();
  expect(first.referencedHashes["schemas/fixture/result.json"]).toMatch(
    /^[a-f0-9]{64}$/,
  );
  await writeFile(
    join(f.root, "schemas/fixture/result.json"),
    JSON.stringify({ type: "string" }),
  );
  expect((await f.load()).digest).not.toBe(first.digest);
  const changed = structuredClone(registry);
  changed.tools.read.risk = "write";
  expect(
    (
      await loadBenchBundle({
        root: f.root,
        benchId: "fixture",
        registry: changed,
      })
    ).registryHash,
  ).not.toBe(first.registryHash);
});
it("accepts only deny for wildcard/task and rejects alternate escaping write-target forms", async () => {
  const good: any = manifest();
  good.roles.reader.tools = { "*": "deny", task: "deny" };
  expect(
    (await (await fixture(good)).load()).manifest.roles.reader.tools.task,
  ).toBe("deny");
  for (const target of [
    "/outside",
    "C:\\outside",
    "notes/../../outside",
    "notes//outside",
    "notes/.",
    "./notes/",
    "notes\\outside",
  ]) {
    const v: any = manifest();
    v.roles.reader.write_targets = [target];
    await expect((await fixture(v)).load()).rejects.toMatchObject({
      code: "BENCH_MANIFEST_INVALID",
    });
  }
});
