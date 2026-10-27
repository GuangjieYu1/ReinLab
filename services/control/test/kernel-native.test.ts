import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { launchPlan, materializeLaunch } from "../src/kernel/dsh/launch";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { runTurn } from "../src/kernel/dsh/session";
import { cancelRun } from "../src/kernel/dsh/cancel";
import { createHarnessFactory, resolveDshModule, SHIM_MODULE } from "../src/kernel/dsh/harness";

const PLUGIN = "file://" + resolve("plugins/reinlab-read-plugin/index.js");

let provider: Server;
let control: Server;
let base = "";
const seen: Array<{ path: string; body: unknown }> = [];
let decisionDelayMs = 0;

const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const textAnswer = (text: string) =>
  sse(
    { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  );
const toolAnswer = (name: string, input: unknown) =>
  sse(
    { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } },
    { type: "message_stop" },
  );

beforeAll(async () => {
  provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: request.url ?? "", body });
      if (request.url?.endsWith("/llm/anthropic/v1/messages")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const hasToolResult = messages.some(
          (message: any) =>
            Array.isArray(message.content) &&
            message.content.some((block: any) => block.type === "tool_result"),
        );
        const toolNames = Array.isArray(body.tools) ? body.tools.map((tool: any) => tool.name) : [];
        if (hasToolResult) response.end(textAnswer("搜到 1 篇"));
        else if (toolNames.includes("papers_search"))
          response.end(toolAnswer("papers_search", { query: "toolformer" }));
        else response.end(textAnswer("没有可用工具"));
        return;
      }
      if (request.url === "/kernel/tool") {
        if (decisionDelayMs) await new Promise((r) => setTimeout(r, decisionDelayMs));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result: { papers: [{ paperId: "W1", title: "Toolformer" }] } }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", () => done()));
  const port = (provider.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  control = provider;
});
afterAll(async () => {
  await new Promise<void>((done) => control.close(() => done()));
});

function realNode(): string {
  if (process.env.SHIM_NODE) return process.env.SHIM_NODE;
  const candidates = execFileSync(
    "sh",
    ["-c", "ls -1 ~/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1; command -v node"],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const found = candidates.find((path) => !/DSH Desktop|electron/i.test(path));
  if (!found) throw new Error("REAL_NODE_REQUIRED");
  return found;
}

function planFor(directory: string) {
  const protect = join(directory, "restrict.patch.yml");
  writeFileSync(
    protect,
    [
      "- id: tool-bash\n  disabled: true",
      "- id: tool-pwsh\n  disabled: true",
      "- id: tool-fs\n  disabled: true",
      "- id: tool-fs-search\n  disabled: true",
      "- id: tool-jobs\n  disabled: true",
      "- id: tool-skill\n  disabled: true",
      "- id: tool-subagent\n  disabled: true",
      "- id: tool-subagent-control\n  disabled: true",
      "- id: tool-subagent-list-agents\n  disabled: true",
      "- id: tool-workflow\n  disabled: true",
      "- id: tool-todo\n  disabled: true",
      "- id: tool-goal\n  disabled: true",
      "- id: tool-web\n  disabled: true",
      "- id: tool-working-directory\n  disabled: true",
      "- id: plan-mode\n  disabled: true",
      "- id: tool-subagent-fork\n  disabled: true",
      "",
    ].join("\n"),
  );
  const account = randomUUID(),
    dossier = randomUUID(),
    run = randomUUID();
  const plan = launchPlan({
    account,
    dossier,
    run,
    sessionId: "ds-" + randomUUID(),
    controlUrl: base,
    model: "deepseek-v4-flash",
    maxTokens: 4096,
    home: directory,
    bundler: {
      shimModule: SHIM_MODULE,
      shimContainerModule: SHIM_MODULE,
      dshModule: resolveDshModule(),
      restrictPatch: protect,
      pluginEntry: PLUGIN,
    },
  });
  plan.options.env.SHIM_MODE = "host";
  // dsh boots only under a real Node binary, not the Electron-embedded one.
  plan.options.env.SHIM_NODE = realNode();
  plan.options.dshHome = join(directory, "home");
  plan.options.cwd = join(directory, "work");
  return plan;
}

async function prepared(directory: string) {
  const plan = planFor(directory);
  const io = {
    mkdir: async (path: string) => void (await mkdir(path, { recursive: true, mode: 0o700 })),
    write: async (path: string, body: string, mode?: number) =>
      void (await writeFile(path, body, { mode: mode ?? 0o600 })),
    remove: async (path: string) => void (await rm(path, { force: true })),
  };
  await materializeLaunch(plan, "run-token", io);
  return plan;
}

describe("real dsh kernel", () => {
  it("runs a turn through the pinned runtime and round-trips a reading tool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dsh-native-"));
    const plan = await prepared(directory);
    const events: string[] = [];
    const outcome = await runTurn({
      plan,
      prompt: "帮我找 Toolformer 这篇论文",
      resume: false,
      factory: createHarnessFactory(),
      onEvent: (event) => void events.push(event.type),
    });
    if (outcome.state !== "completed")
      console.error("NATIVE_DEBUG", JSON.stringify({ outcome, events, seen: seen.map((entry) => entry.path) }).slice(0, 4000));
    expect(outcome.state).toBe("completed");
    const toolCalls = events.filter((type) => type === "tool/call");
    expect(toolCalls.length).toBeGreaterThan(0);
    const requests = seen.filter((entry) => entry.path === "/kernel/tool");
    expect(requests.length).toBe(1);
    expect(requests[0].body).toMatchObject({ server: "papers", tool: "search" });
    // The provider never sees a harness coding toolkit: only our reading tools.
    const apiCall = seen.find((entry) => entry.path.endsWith("/v1/messages")) as
      | { body: { tools?: Array<{ name: string }> } }
      | undefined;
    const toolNames = apiCall?.body.tools?.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain("papers_search");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("edit");
  }, 120_000);

  it("cancels by confirming the kernel process actually stopped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dsh-cancel-"));
    const plan = await prepared(directory);
    decisionDelayMs = 60_000;
    let owned: ReturnType<ReturnType<typeof createHarnessFactory>> | undefined;
    const turn = runTurn({
      plan,
      prompt: "现在检索",
      resume: false,
      factory: createHarnessFactory(),
      onEvent: () => {},
      onHarness: (harness) => {
        owned = harness as never;
      },
    }).catch((error) => ({ rejected: String(error) }));
    // Wait until the shim recorded this run's pid.
    for (let i = 0; i < 200 && !existsSync(plan.paths.pidFile); i += 1)
      await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(plan.paths.pidFile)).toBe(true);
    const pid = Number(readFileSync(plan.paths.pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);

    // Cancel is only allowed to report success after the process is really gone.
    const states: string[] = [];
    const receipt = await cancelRun({
      close: () => owned!.close(),
      pidAlive: async () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      onState: async (state) => void states.push(state),
      timeoutMs: 60_000,
      pollMs: 200,
    });
    decisionDelayMs = 0;
    expect(receipt.status).toBe("cancelled");
    expect(states).toEqual(["cancelled"]);
    expect(() => process.kill(pid, 0)).toThrow();
    await turn;
  }, 120_000);
});
