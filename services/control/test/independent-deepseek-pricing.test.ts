import { it, expect } from "vitest";
import {
  priceDeepSeekUsage,
  DEEPSEEK_PRICING_VERSION,
  type DeepSeekPricingContext,
} from "../src/bridge/openscience/deepseek-pricing";
const context: DeepSeekPricingContext = {
  currency: "CNY",
  window: "offpeak",
  usdCnyRate: "7.2",
  requestedModel: "deepseek/deepseek-v4-flash",
  pricingVersion: DEEPSEEK_PRICING_VERSION,
};
const part = () => ({
  type: "step-finish",
  id: "prt_fixture",
  messageID: "msg_fixture",
  sessionID: "ses_fixture",
  usage: {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    route: "byok",
    time: 1,
  },
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
});
const sentinel = "sk_" + "fixtureprivate".repeat(3);
it.each(["provider", "model", "route"])(
  "unknown usage %s never preserves credential-shaped labels in metadata",
  (field) => {
    const usage = part();
    (usage.usage as Record<string, unknown>)[field] = sentinel;
    const result = priceDeepSeekUsage(usage, context);
    expect(result.costCny).toBeNull();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  },
);
it.each(["requestedModel", "pricingVersion"])(
  "unknown context %s never preserves credential-shaped labels in metadata",
  (field) => {
    const result = priceDeepSeekUsage(part(), {
      ...context,
      [field]: sentinel,
    });
    expect(result.costCny).toBeNull();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  },
);
it.each(["id", "sessionID", "messageID"])(
  "source %s cannot leak a credential-shaped label",
  (field) => {
    const usage = part();
    (usage as Record<string, unknown>)[field] = sentinel;
    expect(JSON.stringify(priceDeepSeekUsage(usage, context))).not.toContain(
      sentinel,
    );
  },
);
it("native CNY is not FX-converted and USD exact conversion remains independent", () => {
  const usage = part();
  usage.tokens = {
    input: 1000000,
    output: 1000000,
    reasoning: 250000,
    cache: { read: 1000000, write: 0 },
  };
  expect(priceDeepSeekUsage(usage, context).costCny).toBe("5.020000");
  expect(
    priceDeepSeekUsage(usage, { ...context, currency: "USD" }).costCny,
  ).toBe("5.421600");
});
it("non-BYOK routes and over-ledger amounts remain unknown with no imputed free usage", () => {
  for (const route of [
    "managed",
    "subscription",
    "local",
    "chatgpt",
    "custom",
  ]) {
    const usage = part();
    usage.usage.route = route;
    expect(priceDeepSeekUsage(usage, context).costCny).toBeNull();
  }
  const usage = part();
  usage.tokens.input = Number.MAX_SAFE_INTEGER;
  const result = priceDeepSeekUsage(usage, context);
  expect(result.costCny).toBeNull();
  expect(result.metadata.unknownReason).toBe("USAGE_RANGE_INVALID");
});
