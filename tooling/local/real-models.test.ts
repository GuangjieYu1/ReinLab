import { expect, it } from "vitest";
import { realModelMode } from "./real-models";
import { localPeakPricing } from "../../services/control/src/model/peak-pricing";
it("defaults off; explicit opt-in is forbidden in tests/CI and rejects inherited model secrets", () => {
  expect(realModelMode([], {})).toBe(false);
  expect(realModelMode(["--real-models"], {})).toBe(true);
  for (const env of [
    { CI: "true" },
    { NODE_ENV: "test" },
    { DEEPSEEK_API_KEY: "synthetic-not-real" },
  ])
    expect(() => realModelMode(["--real-models"], env)).toThrow();
  expect(() => realModelMode(["--real-models=invalid"], {})).toThrow();
});
it("uses a constant conservative peak estimate", () => {
 expect(localPeakPricing()).toMatchObject({currency:"CNY",window:"peak",usdCnyRate:"7.2"});
});
