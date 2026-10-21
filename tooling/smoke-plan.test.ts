import { expect, it } from "vitest";
import { smokePlan } from "./local/smoke-plan";
const now = Date.parse("2026-10-21T10:10:00.000Z");
const valid = {
  currency: "CNY",
  window: "offpeak",
  validFrom: "2026-10-21T10:00:00.000Z",
  validUntil: "2026-10-21T15:59:59.000Z",
};
it("accepts an explicitly verified current CNY window with fixed route, FX and tighter execution limits", () => {
  expect(smokePlan(valid, now)).toEqual({
    pricingContext: {
      currency: "CNY",
      window: "offpeak",
      usdCnyRate: "7.2",
      pricingVersion: "deepseek-official-2026-10-20",
      validFrom: Date.parse(valid.validFrom),
      validUntil: Date.parse(valid.validUntil),
    },
    model: "deepseek/deepseek-v4-flash",
    budgetCny: 1,
    maxSteps: 1,
  });
});
it.each([
  { currency: "USD" },
  { currency: "" },
  { window: "guess" },
  { validFrom: "2026-10-21T11:00:00.000Z" },
  { validUntil: "2026-10-21T10:10:30.000Z" },
  { validUntil: "2026-10-23T00:00:00.000Z" },
  { validUntil: "2026-10-21 12:00" },
  { budgetCny: 2 },
  { maxSteps: 48 },
  { model: "other/model" },
  { usdCnyRate: "8" },
])("rejects invalid or expanded smoke plan %j", (patch) => {
  expect(() => smokePlan({ ...valid, ...patch }, now)).toThrow(
    "SMOKE_PLAN_INVALID",
  );
});
