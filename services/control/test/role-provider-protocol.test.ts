import { afterEach, expect, it } from "vitest";
import { startRoleProvider } from "./fixtures/role-provider";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

for (const model of ["deepseek-v4-flash", "deepseek-flash"]) {
  it.each([undefined, null, {}, { type: "enabled" }, { type: "Disabled" }])(
    `B-8 fixture ${model} rejects non-disabled thinking %j as DeepSeek does`,
    async (thinking) => {
      const provider = await startRoleProvider();
      cleanup.push(provider.close);
      const response = await fetch(provider.url + "/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model, thinking, max_tokens: 1,
          messages: [{ role: "user", content: "fixture only" }],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          message: expect.stringContaining("reasoning_content"),
        },
      });
      expect(provider.requests).toHaveLength(1);
    },
  );

  it(`B-8 fixture ${model} accepts explicitly disabled thinking`, async () => {
    const provider = await startRoleProvider();
    cleanup.push(provider.close);
    const response = await fetch(provider.url + "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model, thinking: { type: "disabled" }, max_tokens: 1,
        messages: [{ role: "user", content: "fixture only" }],
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("Fixture finished.");
    expect(provider.requests[0].thinking).toEqual({ type: "disabled" });
  });
}
