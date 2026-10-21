import { expect, it } from "vitest";
import { runtimePricingFromEnvironment } from "../src/bridge/openscience/pricing-environment";
it("no verified window remains unpriced; partial or invalid configuration fails closed", () => {
  expect(runtimePricingFromEnvironment({})).toBeUndefined();
  for (const raw of [
    { DEEPSEEK_BILLING_CURRENCY: "CNY" },
    {
      DEEPSEEK_BILLING_CURRENCY: "CNY",
      DEEPSEEK_PRICE_WINDOW: "free",
      DEEPSEEK_PRICE_VALID_FROM: "2026-10-21T01:00:00.000Z",
      DEEPSEEK_PRICE_VALID_UNTIL: "2026-10-21T04:00:00.000Z",
      MODEL_USD_CNY_RATE: "7.2",
    },
  ])
    expect(() => runtimePricingFromEnvironment(raw)).toThrow();
});
it("verified currency, fixed FX and exact UTC interval become an immutable server price snapshot", () => {
  const value = runtimePricingFromEnvironment({
    DEEPSEEK_BILLING_CURRENCY: "CNY",
    DEEPSEEK_PRICE_WINDOW: "peak",
    DEEPSEEK_PRICE_VALID_FROM: "2026-10-21T01:00:00.000Z",
    DEEPSEEK_PRICE_VALID_UNTIL: "2026-10-21T04:00:00.000Z",
    MODEL_USD_CNY_RATE: "7.2",
  });
  expect(value).toMatchObject({
    currency: "CNY",
    window: "peak",
    usdCnyRate: "7.2",
    validFrom: Date.parse("2026-10-21T01:00:00.000Z"),
  });
  expect(Object.isFrozen(value)).toBe(true);
});
