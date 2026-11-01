/**
 * 对话模型调用的预算闸门（07 契约「预算」；09 §9）。
 *
 * 这条路径原来是「先花完再记」：没有任何拦截。这里只验闸门本身——
 * 不够就拒绝、而且一个字节都没往外发；够就照常转发。
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync } from "node:crypto";
import { KernelAuth } from "../src/kernel/auth";
import { registerMessagesProxy, type RecordedUsage } from "../src/model/messages-proxy";

const auth = new KernelAuth(generateKeyPairSync("ed25519").privateKey);
const now = () => Math.floor(Date.now() / 1000);
const claims = {
  account: "6f1b0f2e-2f7f-4b5a-9a42-3c5f0c1d2e3f",
  dossier: "8f0a2b3c-4d5e-4f60-8172-93a4b5c6d7e8",
  run: "0a1b2c3d-4e5f-4061-8273-94a5b6c7d8e9",
};
const token = auth.issue(claims, now());

const providerBody = {
  content: [{ type: "text", text: "好的" }],
  usage: { input_tokens: 100, output_tokens: 20 },
};

function build(options: {
  guard?: () => Promise<{ ok: boolean; availableCny?: number; message?: string }>;
}) {
  const app = new Hono();
  const forwarded: string[] = [];
  const recorded: RecordedUsage[] = [];
  registerMessagesProxy(app, {
    auth,
    now,
    providerBaseUrl: "https://provider.example/anthropic",
    providerKey: "host-key",
    forward: async () => {
      forwarded.push("call");
      return new Response(JSON.stringify(providerBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    record: async (usage) => {
      recorded.push(usage);
    },
    estimate: () => 0.02,
    ...(options.guard ? { guard: options.guard } : {}),
  });
  return { app, forwarded, recorded };
}

const call = (app: Hono, body: unknown) =>
  app.request("/llm/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": token,
    },
    body: JSON.stringify(body),
  });

describe("对话模型调用的预算闸门", () => {
  it("额度不够就拒绝，而且一次都不往外发", async () => {
    const { app, forwarded, recorded } = build({
      guard: async () => ({ ok: false, availableCny: 0.004, message: "本月可用额度只剩 ¥0.00" }),
    });
    const response = await call(app, { model: "m", max_tokens: 4096, messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("budget_exceeded");
    expect(body.error.message).toContain("可用额度");
    // 关键：拦住了就是没花，不是「先花完再说」。
    expect(forwarded).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("额度够就照常转发，并把用量记下来（未知也照实记）", async () => {
    const { app, forwarded, recorded } = build({
      guard: async () => ({ ok: true }),
    });
    const response = await call(app, { model: "m", max_tokens: 4096, messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ account: claims.account, dossier: claims.dossier, known: true, inputTokens: 100, outputTokens: 20 });
    expect(recorded[0].purpose).toBe("planning");
  });

  it("带图的那一轮记成读图；没配单价（不拦）也照常转发", async () => {
    const { app, forwarded, recorded } = build({});
    const response = await call(app, {
      model: "m",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看看这张" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AA==" } },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(recorded[0].purpose).toBe("vision");
  });
});
