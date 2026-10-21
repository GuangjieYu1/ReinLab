import { expect, it } from "vitest";
import { smokePlan, smokeAuthorization } from "./local/smoke-plan";
it("keeps the first consumed marker location unchanged and isolates the second explicit authorization", () => {
  expect(smokeAuthorization(undefined)).toEqual({ id: "first-authorization", label: "第一次授权", directory: "p110-one-shot" });
  expect(smokeAuthorization("second-authorization")).toEqual({ id: "second-authorization", label: "第二次授权", directory: "p110-second-authorization" });
});
it.each(["", "first-authorization", "third-authorization", "../new-marker", null, {}, 2])("rejects arbitrary authorization or marker selector %j", (selector) => {
  expect(() => smokeAuthorization(selector)).toThrow("SMOKE_AUTHORIZATION_INVALID");
});
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
