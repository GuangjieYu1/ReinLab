import { expect, it } from "vitest";
import {
  thirdSmokeBinding,
  validateSmokeBinding,
} from "../scripts/smoke-binding";
import { smokeReadReceipt } from "../scripts/smoke-policy";

const now = Date.parse("2026-10-26T02:00:00.000Z");
it("third authorization is a new immutable directory and explicit peak execution window", () => {
  const binding = validateSmokeBinding(thirdSmokeBinding, now);
  expect(binding.directory).toBe("mcp10-third-authorization-20261026");
  expect(binding.authorization).toBe("user-third-authorization-20261026");
  expect(binding.executor).toBe("Codex");
  expect(binding.window).toBe("peak");
  expect(binding.version).toBe("1.1.0");
  expect(binding.budgetCny).toBe(1);
});
it("write is admitted only after matching full-text fetch and actual page-one read receipts", () => {
  const asset = "12345678-1234-4123-8123-123456789abc";
  const part = (
    capability: string,
    requestId: string,
    args: unknown,
    output: unknown,
  ) => ({
    type: "tool",
    state: {
      status: "completed",
      input: { capability, requestId, args },
      output: JSON.stringify(output),
    },
  });
  const tools = [
    part(
      "papers.fetch",
      "f",
      { paperId: "W1" },
      { assetId: asset, status: "full_text" },
    ),
    part(
      "papers.pages",
      "p",
      { assetId: asset, pages: [1] },
      { pages: [{ page: 1, text: "PAGE_ONE" }] },
    ),
  ];
  expect(smokeReadReceipt(tools, "f", "p")).toEqual({
    assetId: asset,
    page: 1,
    text: "PAGE_ONE",
  });
  for (const invalid of [
    [],
    tools.slice(0, 1),
    [
      tools[0],
      part(
        "papers.pages",
        "p",
        { assetId: randomAsset, pages: [1] },
        { pages: [{ page: 1, text: "PAGE_ONE" }] },
      ),
    ],
    [
      part(
        "papers.fetch",
        "f",
        { paperId: "W1" },
        { assetId: asset, status: "abstract_only" },
      ),
      tools[1],
    ],
  ])
    expect(() => smokeReadReceipt(invalid, "f", "p")).toThrow();
});
const randomAsset = "22345678-1234-4123-8123-123456789abc";
it("old namespace, authority, executor and stale window cannot be revived", () => {
  for (const patch of [
    { directory: "mcp10-authorized-20261024" },
    { authorization: "second-authorization" },
    { executor: "Claude" },
    { validUntil: "2026-10-25T16:00:00.000Z" },
    { budgetCny: 2 },
    { version: "1.2.0" },
    { window: "offpeak" },
  ])
    expect(() =>
      validateSmokeBinding({ ...thirdSmokeBinding, ...patch }, now),
    ).toThrow("MCP10_BINDING_INVALID");
  for (const time of [
    Date.parse("2026-10-26T00:59:59.000Z"),
    Date.parse("2026-10-26T03:50:00.000Z"),
  ])
    expect(() => validateSmokeBinding(thirdSmokeBinding, time)).toThrow(
      "MCP10_BINDING_INVALID",
    );
});
