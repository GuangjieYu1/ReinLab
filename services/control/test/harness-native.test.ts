import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { loadToolRegistry, loadBenchBundle } from "../src/harness/manifest";
import { initialEffective } from "../src/harness/resolver";
import { materializeHarnessRole } from "../src/harness/materialize";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import {
  startNativeRoleServer,
  startRoleProvider,
  type FixtureCall,
} from "./fixtures/role-provider";
import { testEvidenceDirectory } from "./fixtures/test-evidence";
/** T-HAR10: real loader/materializer + native 2.0.150, deterministic loopback provider only. */
describe.sequential("T-HAR10 harness-generated native role boundaries", () => {
  let root: string,
    provider: Awaited<ReturnType<typeof startRoleProvider>>,
    server: Awaited<ReturnType<typeof startNativeRoleServer>>;
  let alpha: Awaited<ReturnType<typeof prepareRoleProject>>,
    beta: typeof alpha,
    a: RoleRuntime,
    b: RoleRuntime;
  const observations: Record<string, unknown>[] = [];
  const own = "HARNESS_OWN_MEMORY_7811",
    other = "HARNESS_OTHER_MEMORY_8922",
    outside = "HARNESS_OUTSIDE_DATA_9033",
    allowed = "HARNESS_ALLOWED_DATA_0144";
  const captures = (marker: string) =>
    provider.requests.filter((request) =>
      JSON.stringify(request.messages).includes(marker),
    );
  const parts = (messages: any[]) =>
    messages
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === "tool");
  beforeAll(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-harness-native-")),
    );
    const bundleRoot = join(root, "bundle");
    await mkdir(join(bundleRoot, "benches"), { recursive: true });
    await mkdir(join(bundleRoot, "prompts/research"), { recursive: true });
    const manifest = parse(
      await readFile(resolve("benches/research.bench.yaml"), "utf8"),
    );
    // Sole fixture manifest difference: add native read allow to two real roles.
    for (const roleId of ["research-read", "research-auto"])
      manifest.roles[roleId].tools.read = "allow";
    for (const role of Object.values(manifest.roles) as Array<{
      prompt: string;
    }>)
      await copyFile(resolve(role.prompt), join(bundleRoot, role.prompt));
    await writeFile(
      join(bundleRoot, "benches/research.bench.yaml"),
      stringify(manifest),
    );
    // The released manifest now references card schemas; fixture bundle carries
    // their exact source bytes too, rather than dropping production validation.
    for(const card of Object.values(manifest.cards) as Array<{schema:string}>){
      await mkdir(join(bundleRoot,'schemas/research'),{recursive:true});
      await copyFile(resolve(card.schema),join(bundleRoot,card.schema));
    }
    const registry = await loadToolRegistry(),
      effective = initialEffective(
        await loadBenchBundle({
          root: bundleRoot,
          benchId: "research",
          registry,
        }),
      );
    const dossierId = randomUUID(),
      projectRoot = join(root, "projects");
    await mkdir(projectRoot);
    const prepare = (roleId: string, memory: string) =>
      prepareRoleProject({
        ...materializeHarnessRole(effective, registry, {
          dossierId,
          roleId,
          modelRoutes: {
            cheap: "role-fixture/fixture",
            mid: "role-fixture/fixture",
            strong: "role-fixture/fixture",
          },
          memory,
          maxSteps: 8,
        }),
        root: projectRoot,
        pluginUrl: pathToFileURL(resolve("plugins/reinlab-os-plugin/index.js"))
          .href,
      });
    alpha = await prepare("research-read", own);
    beta = await prepare("research-auto", other);
    await writeFile(join(alpha.dossierDirectory, "allowed.txt"), allowed);
    await mkdir(join(projectRoot, "outside"));
    await writeFile(join(projectRoot, "outside/secret.txt"), outside);
    await mkdir(join(projectRoot, "dossiers/other"), { recursive: true });
    await writeFile(join(projectRoot, "dossiers/other/secret.txt"), outside);
    await symlink(
      join(projectRoot, "outside/secret.txt"),
      join(alpha.dossierDirectory, "escape-link"),
    );
    provider = await startRoleProvider();
    server = await startNativeRoleServer(root, provider.url);
    expect(server.version).toBe("2.0.150");
    a = new RoleRuntime({
      baseUrl: server.baseUrl,
      token: server.token,
      project: alpha,
    });
    b = new RoleRuntime({
      baseUrl: server.baseUrl,
      token: server.token,
      project: beta,
    });
    observations.push({
      fixtureOnly: true,
      realModelRequests: 0,
      manifestDifference:
        "real research clone; only research-read/research-auto tools.read=allow",
      bundleDigest: effective.bundleDigest,
      registryHash: effective.registryHash,
      roleIds: [alpha.roleId, beta.roleId],
    });
  }, 60000);
  afterAll(async () => {
    const evidence = await testEvidenceDirectory("harness-native");
    const samples =
      provider?.requests.map((request) => ({
        model: request.model,
        messages: request.messages,
        tools: request.tools,
      })) ?? [];
    await writeFile(
      join(evidence, "harness-native-evidence.json"),
      JSON.stringify(
        {
          nativeVersion: server?.version,
          fixtureOnly: true,
          realModelRequests: 0,
          observations,
          samples,
        },
        null,
        2,
      ).replaceAll(root ?? "unused", "<FIXTURE_ROOT>") + "\n",
    );
    if (server) await server.close();
    if (provider) await provider.close();
    if (root)
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  });
  async function run(marker: string, calls: FixtureCall[] = [], runtime = a) {
    provider.plans.set(marker, calls);
    const { sessionID } = await runtime.createSession(marker),
      requestID = randomUUID();
    const receipt = await runtime.prompt({
      sessionID,
      requestID,
      message: marker,
    });
    for (let attempt = 0; attempt < 600; attempt++) {
      const snapshot = await runtime.snapshot(sessionID);
      expect(snapshot.permissions).toEqual([]);
      const current = snapshot.runs.find((run) => run.runID === receipt.runID);
      if (
        current &&
        ["completed", "failed", "cancelled", "interrupted"].includes(
          current.state,
        )
      ) {
        expect(current.state, JSON.stringify(current)).toBe("completed");
        const messages = await runtime.messages(sessionID);
        if (calls.length)
          expect(parts(messages).length).toBeGreaterThanOrEqual(calls.length);
        return { sessionID, requestID, receipt, messages };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error("Harness fixture did not finish");
  }
  it("actual model system contains only selected harness prompt and server memory", async () => {
    await run("har-system-alpha");
    await run("har-system-beta", [], b);
    const system = (marker: string) =>
      captures(marker)
        .flatMap((request) =>
          request.messages.filter((message) => message.role === "system"),
        )
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
        )
        .join("\n");
    const x = system("har-system-alpha"),
      y = system("har-system-beta");
    expect(x).toContain(own);
    expect(x).not.toContain(other);
    expect(y).toContain(other);
    expect(y).not.toContain(own);
    expect(x).not.toBe(y);
    expect(x).toContain(
      await readFile(resolve("prompts/research/research-read.md"), "utf8"),
    );
    expect(y).toContain(
      await readFile(resolve("prompts/research/research-auto.md"), "utf8"),
    );
    observations.push({ case: "system", distinct: true });
  }, 90000);
  it("allows dossier read and denies external, other dossier/role and symlink reads", async () => {
    const positive = await run("har-read-positive", [
      {
        name: "read",
        arguments: { filePath: join(alpha.dossierDirectory, "allowed.txt") },
      },
    ]);
    expect(
      parts(positive.messages).some(
        (part) =>
          part.state.status === "completed" &&
          JSON.stringify(part).includes(allowed),
      ),
    ).toBe(true);
    for (const [index, filePath] of [
      join(root, "projects/outside/secret.txt"),
      join(root, "projects/dossiers/other/secret.txt"),
      join(beta.directory, "AGENTS.md"),
      join(alpha.dossierDirectory, "escape-link"),
    ].entries()) {
      const marker = "har-read-deny-" + index,
        result = await run(marker, [{ name: "read", arguments: { filePath } }]);
      expect(
        parts(result.messages).every(
          (part) => part.state.status !== "completed",
        ),
      ).toBe(true);
      const visible = JSON.stringify([result.messages, captures(marker)]);
      expect(visible).not.toContain(outside);
      expect(visible).not.toContain(other);
    }
    observations.push({
      case: "read",
      allowed: true,
      denied: 4,
      leaked: false,
    });
  }, 180000);
  it("denies model-forced ungranted tools and task with no file or child side effects", async () => {
    const target = join(alpha.dossierDirectory, "forbidden.txt");
    const result = await run("har-tool-deny", [
      { name: "write", arguments: { filePath: target, content: "forbidden" } },
      { name: "fixture_unknown_tool", arguments: {} },
      {
        name: "task",
        arguments: {
          subagent_type: "data",
          description: "fixture",
          prompt: "fixture",
        },
      },
    ]);
    expect(
      parts(result.messages).every((part) => part.state.status !== "completed"),
    ).toBe(true);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await a.children(result.sessionID)).toEqual([]);
    const offered = captures("har-tool-deny").flatMap(
      (request) => request.tools?.map((tool) => tool.function.name) ?? [],
    );
    for (const name of ["fixture_unknown_tool", "task"])
      expect(offered).not.toContain(name);
    observations.push({
      case: "tools",
      forced: 3,
      sideEffects: 0,
      offeredWrite: offered.includes("write"),
      note: "Native file permission exposes write schema when dossier write targets exist; role whitelist guard still rejects forced ungranted write.",
    });
  }, 90000);
  it("replays request receipt without another provider request and conflicts on changed content", async () => {
    const result = await run("har-replay"),
      before = provider.requests.length;
    expect(
      await a.prompt({
        sessionID: result.sessionID,
        requestID: result.requestID,
        message: "har-replay",
      }),
    ).toEqual(result.receipt);
    await expect(
      a.prompt({
        sessionID: result.sessionID,
        requestID: result.requestID,
        message: "changed",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(provider.requests).toHaveLength(before);
    observations.push({
      case: "replay",
      providerDelta: 0,
      changedContent: 409,
    });
  }, 90000);
});
