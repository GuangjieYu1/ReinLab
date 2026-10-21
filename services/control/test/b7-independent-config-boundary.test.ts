import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it.each(["missing", "enabled"])("B7 independent B6 check: raw config thinking %s fails closed and removes temporary state", async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reinlab-b7-config-review-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const pluginUrl = pathToFileURL(resolve("plugins/reinlab-os-plugin/index.js")).href;
  const project = await prepareRoleProject({ root, dossierId: randomUUID(), role: {
    id: "independent-config-review", prompt: "fixture", toolGrants: {}, writeTargets: [], steps: 1,
  }, model: "deepseek/deepseek-v4-flash", memory: "", pluginUrl });
  const original = JSON.stringify({ plugin: [pluginUrl], fixtureOriginal: true });
  const requests: Array<{ path: string; method: string; body: any }> = [];
  let applied: any;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const path = new URL(req.url!, "http://fixture").pathname;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path, method: req.method!, body });
    res.setHeader("content-type", "application/json");
    if (path === "/global/config/raw") {
      let content = original;
      if (applied) {
        const corrupted = structuredClone(applied);
        const options = corrupted.provider.deepseek.models["deepseek-v4-flash"].options;
        if (mode === "missing") delete options.thinking;
        else options.thinking = { type: "enabled" };
        content = JSON.stringify(corrupted);
      }
      res.end(JSON.stringify(req.method === "GET" ? { content, path: "/fixture/config.json" } : {}));
    } else if (path === "/global/config") {
      if (req.method === "PATCH") applied = body;
      res.end(JSON.stringify({ plugin: [pluginUrl] }));
    } else if (path === "/provider") {
      res.end(JSON.stringify(applied ? { connected: ["deepseek"], all: [{ id: "deepseek", models: {
        "deepseek-v4-flash": { status: "active", api: { id: "deepseek-flash" },
          limit: { context: 1048576, output: 1024 }, capabilities: { reasoning: false } },
      } }], default: {} } : { connected: [], all: [], default: {} }));
    } else if (path === "/auth/deepseek") res.end("true");
    else res.writeHead(404).end("{}");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const runtime = new RoleRuntime({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "x".repeat(43), project, timeoutMs: 1000 });
  await expect(runtime.configureSmokeGateway({ origin: "http://host.docker.internal:43210", token: "y".repeat(43) }))
    .rejects.toMatchObject({ code: "OS_UNAVAILABLE" });
  expect(requests.filter(r => r.path === "/global/config" && r.method === "PATCH")).toHaveLength(1);
  expect(requests.find(r => r.path === "/global/config" && r.method === "PATCH")!.body.provider.deepseek.models["deepseek-v4-flash"].options.thinking).toEqual({ type: "disabled" });
  expect(requests.filter(r => r.path === "/global/config/raw" && r.method === "PUT").map(r => r.body)).toEqual([{ content: original }]);
  expect(requests.filter(r => r.path === "/auth/deepseek" && r.method === "DELETE")).toHaveLength(1);
  expect(requests.some(r => /prompt|session|chat/.test(r.path))).toBe(false);
  const before = requests.length;
  expect(await runtime.cleanupSmokeGateway()).toEqual({ cleaned: true });
  expect(requests).toHaveLength(before);
});
