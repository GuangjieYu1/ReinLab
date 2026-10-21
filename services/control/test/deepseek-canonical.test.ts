import { expect, it } from "vitest";
import { UsageAccountingSource } from "@reinlab/contracts";
import {
  priceDeepSeekUsage,
  DEEPSEEK_PRICING_VERSION,
} from "../src/bridge/openscience/deepseek-pricing";
const context = {
  currency: "CNY" as const,
  window: "offpeak" as const,
  usdCnyRate: "7.2" as const,
  requestedModel: "deepseek/deepseek-v4-flash",
  pricingVersion: DEEPSEEK_PRICING_VERSION,
};
const part = (model = "DeepSeek-V4.1-Flash-1017") => ({
  type: "step-finish",
  id: "prt_canonical",
  sessionID: "ses_canonical",
  messageID: "msg_canonical",
  usage: { provider: "deepseek", model, route: "byok", time: 1792562400000 },
  tokens: {
    input: 1000000,
    output: 1000000,
    reasoning: 0,
    cache: { read: 1000000, write: 0 },
  },
});
it("prices the documented canonical actual model while keeping the requested legacy route", () => {
  const result = priceDeepSeekUsage(part(), context);
  expect(result.costCny).toBe("5.020000");
  expect(result.metadata).toMatchObject({
    requestedModel: "deepseek/deepseek-v4-flash",
    actualModel: "DeepSeek-V4.1-Flash-1017",
    status: "priced",
    source: "direct_provider_usage",
  });
  expect(UsageAccountingSource.parse(result.metadata.source)).toBe(
    "direct_provider_usage",
  );
});
it("does not replace the requested legacy route with the canonical response model", () => {
  expect(
    priceDeepSeekUsage(part(), {
      ...context,
      requestedModel: "deepseek/DeepSeek-V4.1-Flash-1017",
    }),
  ).toMatchObject({
    costCny: null,
    metadata: { unknownReason: "REQUESTED_MODEL_MISMATCH" },
  });
});
it.each([
  "deepseek-v4.1-flash-1017",
  "DeepSeek-V4.1-Flash-1018",
  "DeepSeek-V4.1-Pro-1017",
])("keeps undocumented near matches unknown: %s", (model) => {
  expect(priceDeepSeekUsage(part(model), context)).toMatchObject({
    costCny: null,
    metadata: { unknownReason: "UNSUPPORTED_MODEL" },
  });
});
