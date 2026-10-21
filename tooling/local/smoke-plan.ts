import { DEEPSEEK_PRICING_VERSION } from "../../services/control/src/bridge/openscience/deepseek-pricing";
/** Fixed operator-selected attempts; this selector is not user authorization. */
export function smokeAuthorization(selector: unknown) {
  if (selector === undefined)
    return Object.freeze({ id: "first-authorization", label: "第一次授权", directory: "p110-one-shot" });
  if (selector === "second-authorization")
    return Object.freeze({ id: "second-authorization", label: "第二次授权", directory: "p110-second-authorization" });
  throw new Error("SMOKE_AUTHORIZATION_INVALID");
}
/** The operator verifies currency/time window. This parser never infers holidays. */
export function smokePlan(input: unknown, now: number) {
  const invalid = () => new Error("SMOKE_PLAN_INVALID");
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Number.isSafeInteger(now)
  )
    throw invalid();
  const value = input as Record<string, unknown>,
    keys = ["currency", "window", "validFrom", "validUntil"];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.currency !== "CNY" ||
    !["peak", "offpeak"].includes(String(value.window))
  )
    throw invalid();
  const date = (raw: unknown) => {
    if (
      typeof raw !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    )
      throw invalid();
    const parsed = Date.parse(raw);
    if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== raw)
      throw invalid();
    return parsed;
  };
  const validFrom = date(value.validFrom),
    validUntil = date(value.validUntil);
  if (
    validFrom > now ||
    validUntil - now < 120000 ||
    validUntil - validFrom > 24 * 3600000
  )
    throw invalid();
  return Object.freeze({
    pricingContext: Object.freeze({
      currency: "CNY" as const,
      window: value.window as "peak" | "offpeak",
      usdCnyRate: "7.2" as const,
      pricingVersion: DEEPSEEK_PRICING_VERSION,
      validFrom,
      validUntil,
    }),
    model: "deepseek/deepseek-v4-flash" as const,
    budgetCny: 1 as const,
    maxSteps: 1 as const,
  });
}
