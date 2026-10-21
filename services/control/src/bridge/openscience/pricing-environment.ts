import { PricingWindowSnapshot } from "./run-bridge";
import { DEEPSEEK_PRICING_VERSION } from "./deepseek-pricing";
import { ApiFailure } from "../../api/errors";
/** Explicit verified interval only; no holiday/time-window or currency inference. */
export function runtimePricingFromEnvironment(
  env: Record<string, string | undefined> = process.env,
) {
  const keys = [
    "DEEPSEEK_BILLING_CURRENCY",
    "DEEPSEEK_PRICE_WINDOW",
    "DEEPSEEK_PRICE_VALID_FROM",
    "DEEPSEEK_PRICE_VALID_UNTIL",
  ] as const;
  if (keys.every((key) => env[key] === undefined)) return undefined;
  const date = (raw: string | undefined) => {
    if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw))
      return NaN;
    const time = Date.parse(raw);
    return Number.isFinite(time) && new Date(time).toISOString() === raw
      ? time
      : NaN;
  };
  const parsed = PricingWindowSnapshot.safeParse({
    currency: env.DEEPSEEK_BILLING_CURRENCY,
    window: env.DEEPSEEK_PRICE_WINDOW,
    usdCnyRate: env.MODEL_USD_CNY_RATE,
    pricingVersion: DEEPSEEK_PRICING_VERSION,
    validFrom: date(env.DEEPSEEK_PRICE_VALID_FROM),
    validUntil: date(env.DEEPSEEK_PRICE_VALID_UNTIL),
  });
  if (!parsed.success)
    throw new ApiFailure(
      "PRICE_WINDOW_UNVERIFIED",
      503,
      "实际费用需要完整且经确认的币种、价格窗口与固定汇率。",
    );
  return Object.freeze(parsed.data);
}
