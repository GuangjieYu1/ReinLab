import { it, expect, vi } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import {
  startNativeRoleServer,
  startRoleProvider,
} from "./fixtures/role-provider";
import { testEvidenceDirectory } from "./fixtures/test-evidence";

it("new empty native account configures a usable DeepSeek smoke model before any prompt and restores its empty provider config", async () => {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-smoke-native-")),
    ),
    provider = await startRoleProvider();
  let native: Awaited<ReturnType<typeof startNativeRoleServer>> | undefined,
    runtime: RoleRuntime | undefined;
  const report: Record<string, unknown> = {
    fixtureOnly: true,
    realModelRequests: 0,
    realKeyReads: 0,
  };
  const transport = fetch,
    catalogReads: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const response = await transport(input, init);
      if (
        new URL(input instanceof Request ? input.url : String(input))
          .pathname === "/provider"
      ) {
        const data = (await response.clone().json()) as any;
        catalogReads.push({
          connected: data.connected,
          deepseek: data.all?.find((p: any) => p.id === "deepseek")?.models,
        });
      }
      return response;
    },
  );
  try {
    native = await startNativeRoleServer(root, provider.url, undefined, true);
    report.nativeVersion = native.version;
    expect(native.version).toBe("2.0.150");
    const project = await prepareRoleProject({
      root,
      dossierId: randomUUID(),
      role: {
        id: "smoke-read",
        prompt: "Reply fixture text only.",
        toolGrants: {},
        writeTargets: [],
        steps: 1,
      },
      model: "deepseek/deepseek-v4-flash",
      memory: "",
      pluginUrl: pathToFileURL(resolve("plugins/reinlab-os-plugin/index.js"))
        .href,
    });
    const catalog = async () => {
      const response = await fetch(
        native!.baseUrl +
          "/provider?directory=" +
          encodeURIComponent(project.directory),
        {
          headers: { authorization: "Bearer " + native!.token },
          signal: AbortSignal.timeout(5000),
        },
      );
      expect(response.ok).toBe(true);
      const value = (await response.json()) as any;
      return {
        connected: value.connected,
        all: value.all.map((p: any) => ({
          id: p.id,
          models: Object.entries(p.models ?? {}).map(
            ([id, m]: [string, any]) => ({
              id,
              api: m.api,
              limit: m.limit,
              reasoning: m.capabilities?.reasoning,
            }),
          ),
        })),
      };
    };
    report.before = await catalog();
    expect((report.before as any).connected).toEqual([]);
    runtime = new RoleRuntime({
      baseUrl: native.baseUrl,
      token: native.token,
      project,
    });
    await runtime.configureSmokeGateway({
      origin: provider.url,
      token: randomBytes(32).toString("base64url"),
    });
    const after = await catalog();
    report.after = after;
    expect(after.connected).toContain("deepseek");
    expect(
      after.all
        .find((p: any) => p.id === "deepseek")
        ?.models.some((m: any) => m.id === "deepseek-v4-flash"),
    ).toBe(true);
    const { sessionID } = await runtime.createSession(),
      receipt = await runtime.prompt({
        sessionID,
        requestID: "smoke-native-fixture",
        message: "Reply fixture text only.",
      });
    let run = await runtime.getRun(sessionID, receipt.runID);
    for (
      let i = 0;
      i < 100 &&
      !["completed", "failed", "cancelled", "interrupted"].includes(run.state);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 50));
      run = await runtime.getRun(sessionID, receipt.runID);
    }
    report.state = run.state;
    report.providerCalls = provider.requests.length;
    report.sentModels = provider.requests.map((r) => r.model);
    expect(run.state).toBe("completed");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].model).toBe("deepseek-flash");
    await runtime.cleanupSmokeGateway();
    const restored = await catalog();
    report.restored = restored;
    expect(restored.connected).toEqual([]);
  } finally {
    report.catalogReads = catalogReads;
    await runtime?.cleanupSmokeGateway();
    await native?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    const output = await testEvidenceDirectory("runtime-smoke-native");
    await writeFile(
      join(output, "native-catalog.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
}, 60000);
