import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { KernelAuth } from "../src/kernel/auth";
import { registerMessagesProxy, type RecordedUsage } from "../src/model/messages-proxy";
import { promptWithImages } from "../src/kernel/dsh/session";

const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
const now = () => Math.floor(Date.now() / 1000);
const claims = { account: randomUUID(), dossier: randomUUID(), run: randomUUID() };

function build(recorded: RecordedUsage[]) {
  const app = new Hono();
  const recordedCalls = recorded;
  registerMessagesProxy(app, {
    auth,
    now,
    providerBaseUrl: "https://provider.example/anthropic",
    providerKey: "test-key",
    forward: async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          content: [{ type: "text", text: "看到了" }],
          usage: { input_tokens: 120, output_tokens: 45 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    record: async (usage) => {
      recordedCalls.push(usage);
    },
  });
  return app;
}

const send = async (app: Hono, body: unknown) =>
  app.request("/llm/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": auth.issue(claims, now()),
    },
    body: JSON.stringify(body),
  });

describe("参考图进模型", () => {
  it("带图的一轮：图按给的顺序，每张前面带编号（模型才不会把第几张说反）", () => {
    const input = promptWithImages("看看这张图", [
      { data: "AAAA", mimeType: "image/png", label: "该机位实拍" },
      { data: "BBBB", mimeType: "image/jpeg" },
    ]);
    expect(Array.isArray(input)).toBe(true);
    if (Array.isArray(input)) {
      expect(input[0]).toEqual({ type: "text", text: "看看这张图" });
      expect(input[1]).toEqual({ type: "text", text: "图 1（该机位实拍）：" });
      expect(input[2]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
      expect(input[3]).toEqual({ type: "text", text: "图 2：" });
      expect(input[4]).toEqual({ type: "image", data: "BBBB", mimeType: "image/jpeg" });
    }
    // 没有图就还是纯文字，不改协议形状。
    expect(promptWithImages("只有文字")).toBe("只有文字");
  });

  it("模型通道把带图的请求记成「读图」，纯文字记成「编排」", async () => {
    const recorded: RecordedUsage[] = [];
    const app = build(recorded);
    const withImage = await send(app, {
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "这张图什么色调" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    });
    expect(withImage.status).toBe(200);
    const textOnly = await send(app, {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "排一下计划" }] }],
    });
    expect(textOnly.status).toBe(200);

    expect(recorded.map((row) => row.purpose)).toEqual(["vision", "planning"]);
    expect(recorded[0]).toMatchObject({ known: true, inputTokens: 120, outputTokens: 45, model: "deepseek-v4-flash" });
    expect(recorded[0].account).toBe(claims.account);
    expect(recorded[0].dossier).toBe(claims.dossier);
  });

  it("用量缺失时照实记未知，不写 0", async () => {
    const recorded: RecordedUsage[] = [];
    const app = new Hono();
    registerMessagesProxy(app, {
      auth,
      now,
      providerBaseUrl: "https://provider.example/anthropic",
      providerKey: "test-key",
      forward: async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "嗯" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      record: async (usage) => {
        recorded.push(usage);
      },
    });
    await send(app, { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
    expect(recorded[0]).toMatchObject({ known: false, inputTokens: null, outputTokens: null });
    expect(recorded[0].purpose).toBe("planning");
    vi.restoreAllMocks();
  });
});
