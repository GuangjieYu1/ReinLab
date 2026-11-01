/**
 * 对话模型出口（07 契约「预算」；09 §9）。
 *
 * 按用户要求不做上限拦截：这里验转发与用量记录本身（用量照实记，不做预算拒绝）。
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

function build() {
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

describe("对话模型出口", () => {
  it("没有令牌就 401", async () => {
    const { app } = build();
    const response = await app.request("/llm/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(response.status).toBe(401);
  });

  it("照常转发，并把用量记下来（token 有就记账，未知照实记未知）", async () => {
    const { app, forwarded, recorded } = build();
    const response = await call(app, { model: "m", max_tokens: 4096, messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ account: claims.account, dossier: claims.dossier, known: true, inputTokens: 100, outputTokens: 20 });
    expect(recorded[0].purpose).toBe("planning");
  });

  it("带图的那一轮记成读图", async () => {
    const { app, forwarded, recorded } = build();
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
