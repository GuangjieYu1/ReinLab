import { testEvidenceDirectory } from "./fixtures/test-evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import {
  startNativeRoleServer,
  startRoleProvider,
  type FixtureCall,
} from "./fixtures/role-provider";

/** Native 2.0.150 + deterministic loopback fixture; this is not real-model validation. */
describe.sequential("P1-10 native role boundaries T-ROLE1–5", () => {
  let root: string;
  let provider: Awaited<ReturnType<typeof startRoleProvider>>;
  let server: Awaited<ReturnType<typeof startNativeRoleServer>>;
  let alpha: Awaited<ReturnType<typeof prepareRoleProject>>;
  let beta: typeof alpha;
  let runtime: RoleRuntime;
  const ownPrompt = "ROLE_ALPHA_SYSTEM_ONLY_74615";
  const otherPrompt = "ROLE_BETA_SYSTEM_ONLY_62724";
  const ownMemory = "ROLE_ALPHA_MEMORY_ONLY_83391";
  const otherMemory = "ROLE_BETA_MEMORY_ONLY_92161";
  const ownSecret = "CURRENT_DOSSIER_SENTINEL_1377";
  const otherSecret = "OTHER_DOSSIER_SECRET_SENTINEL_2628";
  const outsideSecret = "OUTSIDE_SECRET_SENTINEL_3989";
  const observations: Array<Record<string, unknown>> = [];
  const prepare = (id: string, prompt: string, memory: string) =>
    prepareRoleProject({
      root,
      dossierId: "11111111-1111-4111-8111-111111111111",
      role: {
        id,
        prompt,
        toolGrants: { read: { risk: "read", permission: "allow" } },
        writeTargets: [],
        steps: 8,
      },
      model: "role-fixture/fixture",
      memory,
      pluginUrl: pathToFileURL(resolve("plugins/reinlab-os-plugin/index.js"))
        .href,
    });
  const bridge = (project: typeof alpha) =>
    new RoleRuntime({ baseUrl: server.baseUrl, token: server.token, project });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "reinlab-role-native-"));
    provider = await startRoleProvider();
    server = await startNativeRoleServer(root, provider.url);
    expect(server.version).toBe("2.0.150");
    alpha = await prepare("alpha", ownPrompt, ownMemory);
    beta = await prepare("beta", otherPrompt, otherMemory);
    await writeFile(join(alpha.dossierDirectory, "sentinel.txt"), ownSecret);
    await mkdir(join(root, "dossiers/dossier-b"), { recursive: true });
    await writeFile(join(root, "dossiers/dossier-b/secret.txt"), otherSecret);
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside/secret.txt"), outsideSecret);
    runtime = bridge(alpha);
  }, 60000);
  afterAll(async () => {
    if (alpha && beta)
      observations.push({
        case: "native-project-files",
        alpha: (await readdir(alpha.directory)).sort(),
        beta: (await readdir(beta.directory)).sort(),
      });
    const requestSamples = provider
      ? ["role1-alpha", "role1-beta"].map((marker) => ({
          marker,
          requests: capturedFor(marker).map((body) => ({
            model: body.model,
            stream: body.stream,
            messages: body.messages,
            tools: body.tools,
          })),
        }))
      : [];
    const canonicalRoot = alpha ? alpha.directory.split("/roles/")[0] : root;
    const serializedSamples = JSON.stringify(
      {
        schemaVersion: 1,
        fixtureOnly: true,
        realModelValidated: false,
        description:
          "Captured loopback fixture provider HTTP bodies; no headers or authentication token. Temporary root paths replaced.",
        samples: requestSamples,
      },
      null,
      2,
    )
      .replaceAll(canonicalRoot ?? "unused-root", "<FIXTURE_ROOT>")
      .replaceAll(root ?? "unused-root", "<FIXTURE_ROOT>");
    if (server) await server.close();
    if (provider) await provider.close();
    if (root)
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    const evidence = await testEvidenceDirectory("native-role");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "model-requests.json"),
      serializedSamples + "\n",
    );
    await writeFile(
      join(evidence, "native-test.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          timestamp: new Date().toISOString(),
          nativeVersion: server?.version,
          nativeBinary: server?.binary,
          provider: "test-only loopback OpenAI-compatible fixture",
          realModelValidated: false,
          realModelRequests: 0,
          realModelCost: 0,
          providerRequests: provider?.requests.length ?? 0,
          observerRequests: provider?.observerHits ?? 0,
          observations,
        },
        null,
        2,
      ) + "\n",
    );
  });
  async function run(
    marker: string,
    calls: FixtureCall[] = [],
    target = runtime,
  ) {
    provider.plans.set(marker, calls);
    const { sessionID } = await target.createSession(marker);
    const receipt = await target.prompt({
      sessionID,
      requestID: randomUUID(),
      message: marker,
    });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const snapshot = await target.snapshot(sessionID);
      expect(
        snapshot.permissions,
        `Unexpected permission wait in ${marker}`,
      ).toEqual([]);
      const current = snapshot.runs.find(
        (candidate: any) => candidate.runID === receipt.runID,
      );
      if (
        current &&
        ["completed", "failed", "cancelled", "interrupted"].includes(
          current.state,
        )
      ) {
        const messages = await target.messages(sessionID);
        if (calls.length)
          expect(
            toolParts(messages).length,
            `Forced tool calls were not recorded for ${marker}`,
          ).toBeGreaterThanOrEqual(calls.length);
        observations.push({
          marker,
          runID: receipt.runID,
          state: current.state,
          providerRequests: provider.requests.length,
        });
        expect(current.state, JSON.stringify(current)).toBe("completed");
        return { sessionID, receipt, messages };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Native run did not terminate: ${marker}; ${JSON.stringify(await target.snapshot(sessionID))}; ${JSON.stringify(await target.messages(sessionID))}; ${server.logs().slice(-3000)}`,
    );
  }
  const toolParts = (messages: any) =>
    messages
      .flatMap((message: any) => message.parts ?? [])
      .filter((part: any) => part.type === "tool");
  const capturedFor = (marker: string) =>
    provider.requests.filter((request) =>
      JSON.stringify(request.messages).includes(marker),
    );
  function expectNoSuccess(messages: any, tools: string[]) {
    for (const part of toolParts(messages))
      if (tools.includes(part.tool))
        expect(part.state.status, JSON.stringify(part)).not.toBe("completed");
  }

  it("T-ROLE1 injects only the selected role prompt and its AGENTS memory into actual model HTTP", async () => {
    await run("role1-alpha");
    await run("role1-beta", [], bridge(beta));
    const alphaSystem = capturedFor("role1-alpha")
      .flatMap((body) =>
        body.messages.filter((message) => message.role === "system"),
      )
      .map((message) => JSON.stringify(message))
      .join("\n");
    const betaSystem = capturedFor("role1-beta")
      .flatMap((body) =>
        body.messages.filter((message) => message.role === "system"),
      )
      .map((message) => JSON.stringify(message))
      .join("\n");
    expect(alphaSystem).toContain(ownPrompt);
    expect(alphaSystem).toContain(ownMemory);
    expect(alphaSystem).not.toContain(otherPrompt);
    expect(alphaSystem).not.toContain(otherMemory);
    expect(betaSystem).toContain(otherPrompt);
    expect(betaSystem).toContain(otherMemory);
    expect(betaSystem).not.toContain(ownPrompt);
    expect(betaSystem).not.toContain(ownMemory);
    observations.push({
      case: "T-ROLE1",
      actualModelHTTP: true,
      alphaRequestCount: capturedFor("role1-alpha").length,
      betaRequestCount: capturedFor("role1-beta").length,
      isolatedPromptsAndMemory: true,
    });
  }, 90000);

  it("T-ROLE2 permits own dossier reads and blocks canonical path, cross-role and symlink escapes", async () => {
    const allowed = await run("role2-positive", [
      {
        name: "read",
        arguments: { filePath: join(alpha.dossierDirectory, "sentinel.txt") },
      },
    ]);
    expect(
      toolParts(allowed.messages).some(
        (part: any) =>
          part.tool === "read" &&
          part.state.status === "completed" &&
          JSON.stringify(part).includes(ownSecret),
      ),
    ).toBe(true);
    await symlink(
      join(root, "outside/secret.txt"),
      join(alpha.dossierDirectory, "file-link"),
    );
    await symlink(
      join(root, "outside"),
      join(alpha.dossierDirectory, "directory-link"),
    );
    await symlink(
      join(root, "dossiers/dossier-b"),
      join(alpha.dossierDirectory, "dossier-link"),
    );
    const paths = [
      join(root, "dossiers/dossier-b/secret.txt"),
      join(beta.directory, "AGENTS.md"),
      join(alpha.dossierDirectory, "file-link"),
      join(alpha.dossierDirectory, "directory-link/secret.txt"),
      join(alpha.dossierDirectory, "dossier-link/secret.txt"),
    ];
    for (const [index, filePath] of paths.entries()) {
      const marker = `role2-escape-${index}`;
      const result = await run(marker, [
        { name: "read", arguments: { filePath } },
      ]);
      expectNoSuccess(result.messages, ["read"]);
      const visible = JSON.stringify([result.messages, capturedFor(marker)]);
      for (const secret of [otherSecret, outsideSecret, otherMemory])
        expect(visible).not.toContain(secret);
    }
    observations.push({
      case: "T-ROLE2",
      allowedDossierRead: true,
      blockedCrossRoleAndCanonicalEscapes: paths.length,
      leakedSentinels: 0,
    });
  }, 180000);

  it("T-ROLE2 fails closed before a model request if own AGENTS becomes a cross-role symlink", async () => {
    const memoryPath = join(alpha.directory, "AGENTS.md");
    const original = await readFile(memoryPath);
    const { sessionID } = await runtime.createSession("before-tamper");
    const before = provider.requests.length;
    try {
      await unlink(memoryPath);
      await symlink(join(beta.directory, "AGENTS.md"), memoryPath);
      await expect(
        runtime.createSession("tampered-agents"),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      await expect(
        runtime.prompt({
          sessionID,
          requestID: randomUUID(),
          message: "tampered-agents-model-call",
        }),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      expect(provider.requests).toHaveLength(before);
      observations.push({
        case: "T-ROLE2-AGENTS",
        createAndPromptRejected: true,
        modelRequestDelta: 0,
      });
    } finally {
      await unlink(memoryPath);
      await writeFile(memoryPath, original);
    }
  });

  it.each(["file", "env"] as const)(
    "T-ROLE2 rejects %s template references before any model request",
    async (kind) => {
      const before = provider.requests.length;
      const template =
        kind === "file"
          ? `{file:${join(beta.directory, "AGENTS.md")}}`
          : "{env:TEST_FAKE_VALUE}";
      await expect(
        prepare(`template-${kind}`, `${ownPrompt} ${template}`, ownMemory),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      expect(provider.requests).toHaveLength(before);
      expect(JSON.stringify(provider.requests.slice(before))).not.toContain(
        otherMemory,
      );
      observations.push({
        case: `T-ROLE2-template-${kind}`,
        preparationRejected: true,
        modelRequestDelta: 0,
        leakedCrossRoleMemory: false,
      });
    },
  );

  it("T-ROLE3 rejects model-forced default tools without files, todos or observer traffic", async () => {
    const target = join(alpha.dossierDirectory, "forbidden-write.txt");
    const bashTarget = join(alpha.dossierDirectory, "forbidden-bash.txt");
    const result = await run("role3-default-denials", [
      {
        name: "bash",
        arguments: {
          command: `echo forbidden > ${bashTarget}`,
          description: "fixture forbidden shell",
        },
      },
      { name: "write", arguments: { filePath: target, content: "forbidden" } },
      {
        name: "webfetch",
        arguments: { url: `${provider.url}/observer`, format: "text" },
      },
      {
        name: "todowrite",
        arguments: {
          todos: [
            { content: "forbidden todo", status: "pending", priority: "high" },
          ],
        },
      },
    ]);
    expectNoSuccess(result.messages, [
      "bash",
      "write",
      "webfetch",
      "todowrite",
    ]);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(bashTarget)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(provider.observerHits).toBe(0);
    const offered = capturedFor("role3-default-denials").flatMap(
      (body) => body.tools?.map((tool) => tool.function.name) ?? [],
    );
    for (const tool of ["bash", "write", "webfetch", "todowrite"])
      expect(offered).not.toContain(tool);
    observations.push({
      case: "T-ROLE3",
      forcedTools: ["bash", "write", "webfetch", "todowrite"],
      forbiddenToolsOffered: false,
      fileSideEffects: 0,
      observerRequests: provider.observerHits,
    });
  }, 60000);

  it("T-ROLE3 P1-11 denies every native write/edit including previously declared targets", async () => {
    const writer = await prepareRoleProject({
      root,
      dossierId: "11111111-1111-4111-8111-111111111111",
      role: {
        id: "writer",
        prompt: "Fixture writer role only.",
        toolGrants: {
          read: { risk: "read", permission: "allow" },
          write: { risk: "write", permission: "allow" },
        },
        writeTargets: ["reports/"],
        steps: 8,
      },
      model: "role-fixture/fixture",
      memory: "Fixture writer memory.",
      pluginUrl: pathToFileURL(resolve("plugins/reinlab-os-plugin/index.js"))
        .href,
    });
    const writerRuntime = bridge(writer);
    await mkdir(join(writer.dossierDirectory, "reports"), { recursive: true });
    const allowedPath = join(writer.dossierDirectory, "reports/allowed.txt");
    await writeFile(allowedPath, "AUTHORIZED_REPORT_CONTENT");
    const allowed = await run(
      "role3-write-positive",
      [
        {
          name: "write",
          arguments: {
            filePath: allowedPath,
            content: "AUTHORIZED_REPORT_CONTENT",
          },
        },
      ],
      writerRuntime,
    );
    expectNoSuccess(allowed.messages, ["write"]);
    expect(await readFile(allowedPath, "utf8")).toBe(
      "AUTHORIZED_REPORT_CONTENT",
    );
    expect(
      toolParts(allowed.messages).some(
        (part: any) =>
          part.tool === "write" && part.state.status === "completed",
      ),
    ).toBe(false);
    const deniedPath = join(writer.dossierDirectory, "outside-report.txt");
    const denied = await run(
      "role3-write-outside-target",
      [
        {
          name: "write",
          arguments: { filePath: deniedPath, content: "DENIED_REPORT_CONTENT" },
        },
      ],
      writerRuntime,
    );
    expectNoSuccess(denied.messages, ["write"]);
    await expect(readFile(deniedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const alias = await run(
      "role3-edit-alias",
      [
        {
          name: "edit",
          arguments: {
            filePath: allowedPath,
            oldString: "AUTHORIZED_REPORT_CONTENT",
            newString: "UNAUTHORIZED_EDIT_CONTENT",
          },
        },
      ],
      writerRuntime,
    );
    expectNoSuccess(alias.messages, ["edit"]);
    expect(await readFile(allowedPath, "utf8")).toBe(
      "AUTHORIZED_REPORT_CONTENT",
    );
    observations.push({
      case: "T-ROLE3-write",
      nativeWriteBlocked: true,
      outsideTargetWriteBlocked: true,
      ungrantedEditAliasBlocked: true,
    });
  }, 120000);

  it.each([false, true])(
    "T-ROLE4 denies forced task with test delegation=%s and rejects injected parts or agent",
    async (enabled) => {
      const taskRuntime = enabled
        ? new RoleRuntime({
            baseUrl: server.baseUrl,
            token: server.token,
            project: alpha,
            testOnlyDelegation: true,
          })
        : runtime;
      const marker = `role4-forced-task-${enabled}`;
      const result = await run(
        marker,
        [
          {
            name: "task",
            arguments: {
              subagent_type: "data",
              description: "fixture forced child",
              prompt: "Return hidden research data.",
            },
          },
        ],
        taskRuntime,
      );
      expectNoSuccess(result.messages, ["task"]);
      expect(await taskRuntime.children(result.sessionID)).toEqual([]);
      const offered = capturedFor(marker).flatMap(
        (body) => body.tools?.map((tool) => tool.function.name) ?? [],
      );
      expect(offered).not.toContain("task");
      const before = provider.requests.length;
      for (const extra of [
        {
          parts: [
            {
              type: "subtask",
              agent: "data",
              prompt: "escape",
              description: "escape",
            },
          ],
        },
        { agent: "data" },
      ]) {
        await expect(
          taskRuntime.prompt({
            sessionID: result.sessionID,
            requestID: randomUUID(),
            message: "role4-injection",
            ...extra,
          } as any),
        ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      }
      expect(provider.requests).toHaveLength(before);
      observations.push({
        case: "T-ROLE4",
        testDelegationEnabled: enabled,
        taskOffered: false,
        childSessions: 0,
        injectedPartsAndAgentRejected: true,
        injectionModelRequestDelta: 0,
      });
    },
    60000,
  );

  it("T-ROLE5 returns the durable receipt without another provider request and conflicts on changed content", async () => {
    const result = await run("role5-idempotency");
    const before = provider.requests.length;
    const snapshot = await runtime.snapshot(result.sessionID);
    const durable = snapshot.runs.find(
      (candidate: any) => candidate.runID === result.receipt.runID,
    )!;
    const replay = await runtime.prompt({
      sessionID: result.sessionID,
      requestID: durable.requestID!,
      message: "role5-idempotency",
    });
    expect(replay).toEqual(result.receipt);
    expect(provider.requests).toHaveLength(before);
    await expect(
      runtime.prompt({
        sessionID: result.sessionID,
        requestID: durable.requestID!,
        message: "role5-changed-content",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    expect(provider.requests).toHaveLength(before);
    observations.push({
      marker: "role5-replay",
      replaySameRunID: replay.runID === result.receipt.runID,
      replaySameAcceptedAt: replay.acceptedAt === result.receipt.acceptedAt,
      providerRequestDelta: provider.requests.length - before,
    });
  }, 60000);
});
