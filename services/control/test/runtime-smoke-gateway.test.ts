import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  connected: string[] = [],
  failUpdate = false,
  failCleanup: "raw" | "auth" | undefined = undefined,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-smoke-sdk-")),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const pluginUrl = pathToFileURL(
      resolve("plugins/reinlab-os-plugin/index.js"),
    ).href,
    project = await prepareRoleProject({
      root,
      dossierId: randomUUID(),
      role: {
        id: "smoke-read",
        prompt: "fixture",
        toolGrants: {},
        writeTargets: [],
        steps: 1,
      },
      model: "deepseek/deepseek-v4-flash",
      memory: "",
      pluginUrl,
    });
  const original = JSON.stringify({
      plugin: [pluginUrl],
      only_provider: ["deepseek"],
      agent: { title: { disable: true } },
      fixtureOriginal: true,
    }),
    requests: Array<{ path: string; method: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url!, "http://fixture").pathname;
    requests.push({
      path,
      method: req.method!,
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader("content-type", "application/json");
    if (path === "/global/config/raw") {
      if (req.method === "PUT" && failCleanup === "raw") {
        failCleanup = undefined;
        res.writeHead(503).end("{}");
        return;
      }
      res.end(
        JSON.stringify(
          req.method === "GET"
            ? { content: original, path: "/fixture/config.json" }
            : { plugin: [pluginUrl] },
        ),
      );
      return;
    }
    if (path === "/global/config") {
      if (req.method === "PATCH" && failUpdate) {
        res.writeHead(503).end("{}");
        return;
      }
      res.end(JSON.stringify({ plugin: [pluginUrl] }));
      return;
    }
    if (path === "/provider") {
      res.end(JSON.stringify({ all: [], default: {}, connected }));
      return;
    }
    if (path === "/auth/deepseek") {
      if (req.method === "DELETE" && failCleanup === "auth") {
        failCleanup = undefined;
        res.writeHead(503).end("{}");
        return;
      }
      res.end("true");
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return {
    runtime: new RoleRuntime({
      baseUrl:
        "http://127.0.0.1:" + (server.address() as { port: number }).port,
      token: "x".repeat(43),
      project,
      timeoutMs: 200,
    }),
    requests,
    original,
    token: randomBytes(32).toString("base64url"),
  };
}
it("real SDK configures only temporary deepseek auth, real context/output limits, then restores raw config and removes auth", async () => {
  const f = await fixture(),
    result = await f.runtime.configureSmokeGateway({
      origin: "http://host.docker.internal:43210",
      token: f.token,
    });
  expect(result).toMatchObject({ configured: true, outputCap: 1024 });
  expect(JSON.stringify(result)).not.toContain(f.token);
  expect(f.runtime.reader()).not.toHaveProperty("configureSmokeGateway");
  const auth = f.requests.find(
    (r) => r.path === "/auth/deepseek" && r.method === "PUT",
  )!;
  expect(auth.body).toEqual({ type: "api", key: f.token });
  const config = f.requests.find(
    (r) => r.path === "/global/config" && r.method === "PATCH",
  )!.body;
  expect(config.provider.deepseek.options.baseURL).toBe(
    "http://host.docker.internal:43210/v1",
  );
  expect(config.provider.deepseek.models["deepseek-v4-flash"]).toMatchObject({
    reasoning: false,
    limit: { context: 1048576, output: 1024 },
  });
  expect(JSON.stringify(config)).not.toContain(f.token);
  expect(config.provider.deepseek.options).not.toHaveProperty("apiKey");
  await result.cleanup();
  await result.cleanup();
  expect(
    f.requests
      .filter((r) => r.path === "/global/config/raw" && r.method === "PUT")
      .map((r) => r.body),
  ).toEqual([{ content: f.original }]);
  expect(
    f.requests.filter(
      (r) => r.path === "/auth/deepseek" && r.method === "DELETE",
    ),
  ).toHaveLength(1);
});
it.each([
  "https://host.docker.internal:43210",
  "http://example.com:43210",
  "http://host.docker.internal:43210/path",
  "http://u@host.docker.internal:43210",
  "http://host.docker.internal:43210/?x=1",
  "http://host.docker.internal:43210/#x",
])(
  "rejects non-private/root smoke origin %s before SDK writes",
  async (origin) => {
    const f = await fixture();
    await expect(
      f.runtime.configureSmokeGateway({ origin, token: f.token }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(f.requests).toHaveLength(0);
  },
);
it("rejects provider credentials and existing connections rather than replacing them", async () => {
  const f = await fixture(["deepseek"]);
  await expect(
    f.runtime.configureSmokeGateway({
      origin: "http://host.docker.internal:43210",
      token: f.token,
    }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  expect(f.requests.some((r) => r.method !== "GET")).toBe(false);
  const g = await fixture();
  for (const token of ["sk-" + "x".repeat(40), "short"])
    await expect(
      g.runtime.configureSmokeGateway({
        origin: "http://host.docker.internal:43210",
        token,
      }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  expect(g.requests).toHaveLength(0);
});
it("unknown config update cleans partial temporary auth/config without retrying the update", async () => {
  const f = await fixture([], true);
  await expect(
    f.runtime.configureSmokeGateway({
      origin: "http://host.docker.internal:43210",
      token: f.token,
    }),
  ).rejects.toMatchObject({ code: "OS_UNAVAILABLE" });
  expect(
    f.requests.filter(
      (r) => r.path === "/global/config" && r.method === "PATCH",
    ),
  ).toHaveLength(1);
  expect(
    f.requests.some(
      (r) => r.path === "/global/config/raw" && r.method === "PUT",
    ),
  ).toBe(true);
  expect(
    f.requests.some(
      (r) => r.path === "/auth/deepseek" && r.method === "DELETE",
    ),
  ).toBe(true);
});
it.each(["raw", "auth"] as const)(
  "cleanup failure in %s can retry only the incomplete cleanup without redispatching configuration",
  async (stage) => {
    const f = await fixture([], false, stage),
      result = await f.runtime.configureSmokeGateway({
        origin: "http://host.docker.internal:43210",
        token: f.token,
      });
    await expect(result.cleanup()).rejects.toMatchObject({
      code: "OS_UNAVAILABLE",
    });
    expect(await f.runtime.cleanupSmokeGateway()).toEqual({ cleaned: true });
    expect(
      f.requests.filter(
        (r) => r.path === "/global/config" && r.method === "PATCH",
      ),
    ).toHaveLength(1);
    expect(
      f.requests.filter(
        (r) => r.path === "/auth/deepseek" && r.method === "PUT",
      ),
    ).toHaveLength(1);
    expect(
      f.requests.filter(
        (r) => r.path === "/global/config/raw" && r.method === "PUT",
      ),
    ).toHaveLength(stage === "raw" ? 2 : 1);
    expect(
      f.requests.filter(
        (r) => r.path === "/auth/deepseek" && r.method === "DELETE",
      ),
    ).toHaveLength(stage === "auth" ? 2 : 1);
  },
);
it("configuration cannot be overwritten concurrently and loopback admin origin is test-only", async () => {
  const f = await fixture(),
    first = await f.runtime.configureSmokeGateway({
      origin: "http://host.docker.internal:43210",
      token: f.token,
    });
  await expect(
    f.runtime.configureSmokeGateway({
      origin: "http://host.docker.internal:43211",
      token: f.token,
    }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  expect(f.runtime.reader()).not.toHaveProperty("cleanupSmokeGateway");
  await first.cleanup();
  vi.stubEnv("NODE_ENV", "production");
  await expect(
    f.runtime.configureSmokeGateway({
      origin: "http://127.0.0.1:43210",
      token: f.token,
    }),
  ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
});
