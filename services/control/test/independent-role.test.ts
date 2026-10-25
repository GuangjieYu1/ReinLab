import { requireNativeArtifact } from "../../account-runtime/artifact.mjs";
requireNativeArtifact();
import { testEvidenceDirectory } from "./fixtures/test-evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  assertRoleProject,
  prepareRoleProject,
  roleFilesystemGrants,
  type RoleProject,
} from "../src/bridge/openscience/role-project";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import {
  startNativeRoleServer,
  startRoleProvider,
  type FixtureCall,
} from "./fixtures/role-provider";

/** Independent attack tests. Actual pinned npm native binary + loopback provider; no upstream execution/import. */
describe.sequential("P1-10 independent adversarial boundaries", () => {
  let root: string,
    provider: Awaited<ReturnType<typeof startRoleProvider>>,
    server: Awaited<ReturnType<typeof startNativeRoleServer>>;
  const observations: Array<Record<string, unknown>> = [];
  const dossierId = "22222222-2222-4222-8222-222222222222";
  const options = (
    id: string,
    targets = ["reports/"],
    grants: Record<string, { risk: string; permission: string }> = {
      read: { risk: "read", permission: "allow" },
      write: { risk: "write", permission: "allow" },
      edit: { risk: "write", permission: "allow" },
    },
  ) => ({
    root,
    dossierId,
    role: {
      id,
      prompt: "INDEPENDENT_ROLE_" + id,
      toolGrants: grants,
      writeTargets: targets,
      steps: 8,
    },
    model: "role-fixture/fixture",
    memory: "Independent memory " + id,
    pluginUrl: pathToFileURL(resolve("plugins/reinlab-os-plugin/index.js"))
      .href,
  });
  const bridge = (project: RoleProject) =>
    new RoleRuntime({ baseUrl: server.baseUrl, token: server.token, project });
  beforeAll(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-independent-role-")),
    );
    provider = await startRoleProvider();
    server = await startNativeRoleServer(root, provider.url);
    expect(server.version).toBe("2.0.150");
  }, 60000);
  afterAll(async () => {
    if (server) await server.close();
    if (provider) await provider.close();
    const evidence = await testEvidenceDirectory("independent-role");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "independent-test.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          historicalRedFindings: [
            {
              case: "hardlink-read-before-trusted-global-plugin",
              observed:
                "read completed; cross-dossier fixture sentinel reached model HTTP",
            },
            {
              case: "ungranted-edit-after-read-before-trusted-global-plugin",
              observed: "edit completed despite only read/write grant",
            },
            {
              case: "prompt-stall-before-deadline",
              observed:
                "still pending after 800ms, expected OS_UNAVAILABLE/503",
            },
          ],
          timestamp: new Date().toISOString(),
          nativeVersion: server?.version,
          nodeVersion: process.version,
          nativeBinary: server?.binary,
          provider: "test-only loopback fixture",
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
    if (root)
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  });
  async function run(
    runtime: RoleRuntime,
    marker: string,
    calls: FixtureCall[],
    sessionID?: string,
  ) {
    provider.plans.set(marker, calls);
    sessionID ??= (await runtime.createSession(marker)).sessionID;
    const receipt = await runtime.prompt({
      sessionID,
      requestID: randomUUID(),
      message: marker,
    });
    for (const deadline = Date.now() + 30000; Date.now() < deadline; ) {
      const snapshot = await runtime.snapshot(sessionID);
      expect(snapshot.permissions).toEqual([]);
      const current = snapshot.runs.find((r: any) => r.runID === receipt.runID);
      if (
        current &&
        ["completed", "failed", "cancelled", "interrupted"].includes(
          current.state,
        )
      ) {
        expect(current.state).toBe("completed");
        const messages = await runtime.messages(sessionID);
        const parts = messages
          .flatMap((m: any) => m.parts ?? [])
          .filter((p: any) => p.type === "tool");
        expect(parts.length).toBeGreaterThanOrEqual(calls.length);
        observations.push({
          case: marker,
          state: current.state,
          tools: parts.map((p: any) => ({
            tool: p.tool,
            status: p.state.status,
          })),
        });
        return { messages, parts };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Independent native run timeout: " + marker);
  }
  it("rejects forged descriptors, role path injection and normalized write escapes", async () => {
    const p = await prepareRoleProject(options("descriptor"));
    for (const forged of [
      { ...p },
      {
        directory: p.directory,
        dossierDirectory: p.dossierDirectory,
        roleId: p.roleId,
      },
      Object.create(p),
    ]) {
      await expect(assertRoleProject(forged)).rejects.toMatchObject({
        code: "SCOPE_DENIED",
      });
      await expect(roleFilesystemGrants(forged)).rejects.toMatchObject({
        code: "SCOPE_DENIED",
      });
    }
    for (const id of [
      "../alpha",
      "alpha/../../x",
      "alpha\\x",
      "alpha%2fsecret",
      "ALPHA",
      "alpha\0",
    ])
      await expect(
        prepareRoleProject({
          ...options("invalid"),
          role: { ...options("invalid").role, id },
        }),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    for (const target of [
      "reports//x",
      "reports/./x",
      "reports/../x",
      "../other",
      "reports\\x",
      "reports/%2e%2e/x",
      "reports/AGENTS.md",
      "reports/.git/config",
    ])
      await expect(
        prepareRoleProject(options("invalid", [target])),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    observations.push({
      case: "descriptor-and-path-injection",
      forgedDescriptors: 3,
      roleIds: 6,
      writeTargets: 8,
      rejected: true,
    });
  });
  it("checks all managed files for post-issue content, hardlink and symlink tampering", async () => {
    for (const [index, name] of [
      "openscience.json",
      "AGENTS.md",
      ".role-policy.json",
    ].entries()) {
      const p = await prepareRoleProject(options("tamper-" + index)),
        file = join(p.directory, name),
        original = await readFile(file),
        outside = join(root, "copy-" + index);
      await writeFile(file, Buffer.concat([original, Buffer.from(" ")]));
      await expect(assertRoleProject(p)).rejects.toMatchObject({
        code: "SCOPE_DENIED",
      });
      await writeFile(file, original);
      await rename(file, outside);
      await link(outside, file);
      await expect(assertRoleProject(p)).rejects.toMatchObject({
        code: "SCOPE_DENIED",
      });
      await expect(
        prepareRoleProject(options("tamper-" + index)),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      await unlink(file);
      await symlink(outside, file);
      await expect(assertRoleProject(p)).rejects.toMatchObject({
        code: "SCOPE_DENIED",
      });
      await unlink(file);
      await rename(outside, file);
      await expect(assertRoleProject(p)).resolves.toBeUndefined();
    }
    observations.push({
      case: "managed-file-tamper",
      files: 3,
      contentHardlinkSymlinkRejected: true,
    });
  });
  it("rejects ancestor git markers and dossier or declared-target directory substitution", async () => {
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(root, ".git"), "gitdir: /nowhere");
    await expect(
      prepareRoleProject({ ...options("ancestor"), root: nested }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await unlink(join(root, ".git"));
    const p = await prepareRoleProject(options("directory-tamper")),
      saved = p.dossierDirectory + "-saved";
    await rename(p.dossierDirectory, saved);
    await symlink(saved, p.dossierDirectory);
    await expect(assertRoleProject(p)).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
    await unlink(p.dossierDirectory);
    await rename(saved, p.dossierDirectory);
    const outside = join(root, "outside-write");
    await mkdir(outside);
    await symlink(outside, join(p.dossierDirectory, "reports"));
    await expect(assertRoleProject(p)).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
    await unlink(join(p.dossierDirectory, "reports"));
    observations.push({
      case: "ancestor-git-and-directory-substitution",
      allRejected: true,
    });
  });
  it("rejects another runtime session and structured delegate/agent injection before HTTP", async () => {
    const p = await prepareRoleProject(options("session-a")),
      q = await prepareRoleProject(options("session-b")),
      a = bridge(p),
      b = bridge(q),
      { sessionID } = await b.createSession("foreign-session");
    const before = provider.requests.length;
    for (const operation of [
      () =>
        a.prompt({ sessionID, requestID: randomUUID(), message: "foreign" }),
      () => a.snapshot(sessionID),
      () => a.messages(sessionID),
      () => a.children(sessionID),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    const own = (await a.createSession("own-session")).sessionID;
    for (const extra of [
      { agent: "data" },
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
      { directory: q.directory },
      { delegation: true },
      { effort: "high" },
    ])
      await expect(
        a.prompt({
          sessionID: own,
          requestID: randomUUID(),
          message: "injection",
          ...extra,
        }),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(provider.requests.length).toBe(before);
    observations.push({
      case: "session-and-envelope",
      foreignOperations: 4,
      extraFields: 5,
      modelRequestDelta: 0,
    });
  });
  it("still blocks cross-dossier and cross-role reads after an injected native wide filesystem grant", async () => {
    const p = await prepareRoleProject(options("wide-grant")),
      q = await prepareRoleProject(options("wide-victim")),
      runtime = bridge(p),
      { sessionID } = await runtime.createSession("wide-grant");
    const foreign = join(root, "dossiers", randomUUID());
    await mkdir(foreign);
    await writeFile(
      join(foreign, "secret.txt"),
      "INDEPENDENT_FOREIGN_SECRET_321",
    );
    // Fault injection through the authenticated native API, not a bridge authorization path.
    const grantStatuses: number[] = [];
    for (const grantPath of [foreign, q.directory]) {
      const response = await fetch(
        `${new URL(server.baseUrl).origin}/session/${sessionID}/filesystem?directory=${encodeURIComponent(p.directory)}`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + server.token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: grantPath,
            access: "read",
            scope: "session",
          }),
        },
      );
      expect(
        response.ok,
        `Grant fault injection status ${response.status}: ${await response.text()}`,
      ).toBe(true);
      grantStatuses.push(response.status);
    }
    const result = await run(
      runtime,
      "independent-wide-native-grant",
      [
        { name: "read", arguments: { filePath: join(foreign, "secret.txt") } },
        {
          name: "read",
          arguments: { filePath: join(q.directory, "AGENTS.md") },
        },
      ],
      sessionID,
    );
    expect(result.parts.every((p: any) => p.state.status !== "completed")).toBe(
      true,
    );
    expect(JSON.stringify([result.messages, provider.requests])).not.toContain(
      "INDEPENDENT_FOREIGN_SECRET_321",
    );
    observations.push({
      case: "wide-native-filesystem-grant",
      grantStatuses,
      forcedReadCount: 2,
      successfulReads: 0,
    });
  }, 60000);
  it("P1-11 denies native write/edit even at the exact target and preserves prefix/link protection", async () => {
    const p = await prepareRoleProject(
        options("exact-writer", ["reports/final.txt"]),
      ),
      runtime = bridge(p),
      target = join(p.dossierDirectory, "reports/final.txt");
    await mkdir(join(p.dossierDirectory, "reports"), { recursive: true });
    await writeFile(target, "ORIGINAL_SAFE_CONTENT");
    const blockedWrite = await run(runtime, "independent-exact-write", [
      {
        name: "write",
        arguments: { filePath: target, content: "NATIVE_WRITE_DENIED" },
      },
    ]);
    expect(
      blockedWrite.parts.every((p: any) => p.state.status !== "completed"),
    ).toBe(true);
    expect(await readFile(target, "utf8")).toBe("ORIGINAL_SAFE_CONTENT");
    const editSession = (
      await runtime.createSession("independent-edit-session")
    ).sessionID;
    await run(
      runtime,
      "independent-before-edit-read",
      [{ name: "read", arguments: { filePath: target } }],
      editSession,
    );
    await run(
      runtime,
      "independent-exact-edit",
      [
        {
          name: "edit",
          arguments: {
            filePath: target,
            oldString: "ORIGINAL_SAFE_CONTENT",
            newString: "AUTHORIZED_EDIT_CONTENT",
          },
        },
      ],
      editSession,
    );
    expect(await readFile(target, "utf8")).toBe("ORIGINAL_SAFE_CONTENT");
    const aliasProject = await prepareRoleProject(
        options("no-edit-alias", ["reports/final.txt"], {
          read: { risk: "read", permission: "allow" },
          write: { risk: "write", permission: "allow" },
        }),
      ),
      aliasRuntime = bridge(aliasProject),
      aliasSession = (
        await aliasRuntime.createSession("read-before-denied-alias")
      ).sessionID;
    await run(
      aliasRuntime,
      "independent-no-edit-read",
      [{ name: "read", arguments: { filePath: target } }],
      aliasSession,
    );
    const aliasDenied = await run(
      aliasRuntime,
      "independent-no-edit-after-read",
      [
        {
          name: "edit",
          arguments: {
            filePath: target,
            oldString: "AUTHORIZED_EDIT_CONTENT",
            newString: "UNAUTHORIZED_ALIAS_EDIT",
          },
        },
      ],
      aliasSession,
    );
    observations.push({
      case: "ungranted-edit-after-prior-read",
      successfulEdits: aliasDenied.parts.filter(
        (p: any) => p.tool === "edit" && p.state.status === "completed",
      ).length,
    });
    expect(
      aliasDenied.parts
        .filter((p: any) => p.tool === "edit")
        .every((p: any) => p.state.status !== "completed"),
      JSON.stringify(aliasDenied.parts),
    ).toBe(true);
    expect(await readFile(target, "utf8")).toBe("ORIGINAL_SAFE_CONTENT");
    const sibling = target + ".backup";
    const denied = await run(runtime, "independent-prefix-write", [
      { name: "write", arguments: { filePath: sibling, content: "DENIED" } },
    ]);
    expect(denied.parts.every((p: any) => p.state.status !== "completed")).toBe(
      true,
    );
    await expect(readFile(sibling)).rejects.toMatchObject({ code: "ENOENT" });
    const outside = join(root, "protected-write");
    await writeFile(outside, "PROTECTED");
    await unlink(target);
    await symlink(outside, target);
    await expect(runtime.createSession("symlink-target")).rejects.toMatchObject(
      { code: "SCOPE_DENIED" },
    );
    expect(await readFile(outside, "utf8")).toBe("PROTECTED");
    await unlink(target);
    observations.push({
      case: "exact-write-edit-and-symlink",
      nativeWriteDenied: true,
      nativeEditDenied: true,
      prefixDenied: true,
      symlinkDeniedBeforeHTTP: true,
    });
  }, 120000);
  it("blocks a current-dossier hardlink alias to another dossier file", async () => {
    const p = await prepareRoleProject(options("hardlink-reader")),
      runtime = bridge(p),
      foreign = join(root, "dossiers", randomUUID());
    await mkdir(foreign);
    const source = join(foreign, "hardlink-secret.txt"),
      alias = join(p.dossierDirectory, "hardlink-alias.txt");
    await writeFile(source, "INDEPENDENT_HARDLINK_SECRET_665");
    await link(source, alias);
    const result = await run(runtime, "independent-hardlink-read", [
      { name: "read", arguments: { filePath: alias } },
    ]);
    observations.push({
      case: "hardlink-read-attack",
      successfulReads: result.parts.filter(
        (p: any) => p.state.status === "completed",
      ).length,
      sentinelReachedModel: provider.requests.some((request) =>
        JSON.stringify(request.messages).includes(
          "INDEPENDENT_HARDLINK_SECRET_665",
        ),
      ),
    });
    expect(
      result.parts.every((p: any) => p.state.status !== "completed"),
      JSON.stringify(result.parts),
    ).toBe(true);
    expect(JSON.stringify([result.messages, provider.requests])).not.toContain(
      "INDEPENDENT_HARDLINK_SECRET_665",
    );
    observations.push({
      case: "cross-dossier-hardlink-read",
      successfulReads: 0,
    });
  }, 60000);

  it("bounds a stalled native prompt without retrying or replacing its requestID", async () => {
    const p = await prepareRoleProject(options("stall-server")),
      submitted: Array<Record<string, unknown>> = [];
    let pluginPresent = false;
    const nativePaths: string[] = [];
    const stalled = createServer(async (req, res) => {
      nativePaths.push(req.url ?? "");
      if (req.url?.startsWith("/global/config")) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            plugin: pluginPresent
              ? [
                  pathToFileURL(resolve("plugins/reinlab-os-plugin/index.js"))
                    .href,
                ]
              : [],
          }),
        );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url?.startsWith("/runtime/prompt")) {
        submitted.push(body);
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url?.startsWith("/session?")
            ? { id: "session_stall_fixture" }
            : { id: "grant_fixture" },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      stalled.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = stalled.address() as { port: number };
      const runtime = new RoleRuntime({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "fixture-stall-token-no-real-secret-12345",
        project: p,
        timeoutMs: 150,
      } as ConstructorParameters<typeof RoleRuntime>[0]);
      await expect(
        runtime.createSession("missing plugin"),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      expect(nativePaths.every((p) => p.startsWith("/global/config"))).toBe(
        true,
      );
      pluginPresent = true;
      const { sessionID } = await runtime.createSession("stall fixture");
      const requestID = "independent-stall-request-constant";
      pluginPresent = false;
      await expect(
        runtime.prompt({ sessionID, requestID, message: "plugin disappeared" }),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      expect(submitted).toHaveLength(0);
      pluginPresent = true;
      observations.push({
        case: "missing-required-global-plugin",
        sessionCreationDenied: true,
        promptDenied: true,
        promptRequests: 0,
      });
      const start = Date.now();
      const submission = runtime
        .prompt({ sessionID, requestID, message: "independent-stall" })
        .then(
          () => ({ resolved: true }),
          (error) => ({ code: error.code, status: error.status }),
        );
      const result = await Promise.race([
        submission,
        new Promise((resolve) =>
          setTimeout(() => resolve({ deadlineExceeded: true }), 800),
        ),
      ]);
      expect(result).toEqual({ code: "OS_UNAVAILABLE", status: 503 });
      expect(Date.now() - start).toBeLessThan(800);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(submitted).toHaveLength(1);
      expect(submitted[0].requestID).toBe(requestID);
      observations.push({
        case: "stalled-native-prompt",
        bounded: true,
        promptRequests: submitted.length,
        requestIdPreserved: true,
        automaticRetries: 0,
      });
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  }, 5000);

  it("blocks write and edit through a declared-target hardlink to an outside file", async () => {
    const p = await prepareRoleProject(
        options("hardlink-writer", ["hardlink-write.txt"]),
      ),
      runtime = bridge(p),
      source = join(root, "hardlink-protected.txt"),
      alias = join(p.dossierDirectory, "hardlink-write.txt");
    await writeFile(source, "PROTECTED_HARDLINK_ORIGINAL");
    await link(source, alias);
    const result = await run(runtime, "independent-hardlink-write", [
      {
        name: "write",
        arguments: {
          filePath: alias,
          content: "UNAUTHORIZED_HARDLINK_OVERWRITE",
        },
      },
      {
        name: "edit",
        arguments: {
          filePath: alias,
          oldString: "PROTECTED_HARDLINK_ORIGINAL",
          newString: "UNAUTHORIZED_HARDLINK_EDIT",
        },
      },
    ]);
    expect(result.parts.every((p: any) => p.state.status !== "completed")).toBe(
      true,
    );
    expect(await readFile(source, "utf8")).toBe("PROTECTED_HARDLINK_ORIGINAL");
    observations.push({
      case: "outside-file-hardlink-write-edit",
      successfulWrites: 0,
      outsideFileUnchanged: true,
    });
  }, 60000);
});
