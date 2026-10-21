import { z } from "zod";
import { UsageAccountingSource, type JsonValue } from "@reinlab/contracts";
import { scrub } from "../../ledger";

export const DEEPSEEK_PRICING_VERSION = "deepseek-official-2026-10-20";
export type DeepSeekPricingContext = {
  currency: "CNY" | "USD";
  window: "peak" | "offpeak";
  usdCnyRate: "7.2";
  requestedModel: string;
  pricingVersion: string;
};
export type DeepSeekUsagePrice = {
  costCny: string | null;
  metadata: Record<string, JsonValue>;
};

const count = z.number().finite().int().nonnegative().safe();
const sourceId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,160}$/)
  .refine((value) => label(value) !== null);
const identity = z.object({
  type: z.literal("step-finish"),
  id: sourceId,
  sessionID: sourceId,
  messageID: sourceId,
});
const provenance = z.object({
  provider: z.string().min(1).max(160),
  model: z.string().min(1).max(160),
  route: z.enum([
    "managed",
    "byok",
    "chatgpt",
    "subscription",
    "local",
    "custom",
  ]),
  time: count.positive(),
});
const tokens = z.object({
  input: count,
  output: count,
  reasoning: count,
  cache: z.object({ read: count, write: count }),
});
// Official pricing page: legacy Flash aliases are served by this exact canonical version.
const actualModels = new Set([
  "deepseek-v4-flash",
  "deepseek-flash",
  "DeepSeek-V4.1-Flash-1017",
]);
const directSource = UsageAccountingSource.parse("direct_provider_usage");
// Exact native-currency micros per million tokens, independently verified in
// the official CNY and USD tables. Never reinterpret CNY prices as USD prices.
const rates = {
  CNY: { input: 1000000n, cacheRead: 20000n, output: 4000000n },
  USD: { input: 150000n, cacheRead: 3000n, output: 600000n },
} as const;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function label(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9._/-]{1,160}$/.test(value))
    return null;
  // Restrict labels before provenance checks as well as sanitizing the final
  // output. Credential-shaped source IDs must never authorize priced usage.
  if (
    /(?:^|[._/-])(?:sk[-_]|gh[pousr]_|sb_secret_|AIza|AKIA)/i.test(value) ||
    scrub(value) !== value
  )
    return null;
  return value;
}
function decimal(micros: bigint): string {
  return `${micros / 1000000n}.${String(micros % 1000000n).padStart(6, "0")}`;
}

/** Price one native step only. The caller supplies the verified billing window;
 * this function neither infers time/holidays nor reconciles provider invoices. */
export function priceDeepSeekUsage(
  usage: unknown,
  context: DeepSeekPricingContext,
): DeepSeekUsagePrice {
  const part = record(usage),
    billing = record(context),
    observed = record(part.usage);
  const parsedIdentity = identity.safeParse(part),
    parsedUsage = provenance.safeParse(part.usage),
    parsedTokens = tokens.safeParse(part.tokens);
  const currency =
    billing.currency === "CNY" || billing.currency === "USD"
      ? billing.currency
      : null;
  const window =
    billing.window === "peak" || billing.window === "offpeak"
      ? billing.window
      : null;
  const counts = parsedTokens.success ? parsedTokens.data : null;
  const total = counts
    ? BigInt(counts.input) +
      BigInt(counts.cache.read) +
      BigInt(counts.cache.write) +
      BigInt(counts.output)
    : null;
  const metadata: Record<string, JsonValue> = {
    source: directSource,
    status: "unknown",
    usageSource: "openscience_normalized_step_finish",
    normalizationVersion: "2.0.150",
    sourcePartId: label(part.id),
    sourceSessionId: label(part.sessionID),
    sourceMessageId: label(part.messageID),
    requestedModel: label(billing.requestedModel),
    actualProvider: label(observed.provider),
    actualModel: label(observed.model),
    actualRoute: label(observed.route),
    providerTime: parsedUsage.success ? parsedUsage.data.time : null,
    billingCurrency: currency,
    priceWindow: window,
    priceWindowSource: "caller_explicit_no_clock_inference",
    pricingVersion: label(billing.pricingVersion),
    usdCnyRate: billing.usdCnyRate === "7.2" ? "7.2" : null,
    conversionApplied: false,
    fxSource: "fixed_product_configuration",
    counts: counts
      ? {
          input: counts.input,
          output: counts.output,
          reasoning: counts.reasoning,
          cacheRead: counts.cache.read,
          cacheWrite: counts.cache.write,
        }
      : null,
    totalBilledTokens: total?.toString() ?? null,
    inputAlreadyExcludesCache: true,
    reasoningIncludedInOutput: true,
    cacheWritePricing: "input_cache_miss",
    rounding: "ceil_once_to_micro_CNY",
    maximumLedgerCostCny: "999999.999999",
    providerInvoiceReconciled: false,
    includesSearchFetchFees: false,
  };
  // Every return path uses the same structured scrub, including invalid input
  // and partially calculated usage; no diagnostic branch can bypass it.
  const result = (
    costCny: string | null,
    extra: Record<string, JsonValue> = {},
  ): DeepSeekUsagePrice => ({
    costCny,
    metadata: scrub({ ...metadata, ...extra }) as Record<string, JsonValue>,
  });
  const unknown = (reason: string): DeepSeekUsagePrice =>
    result(null, { unknownReason: reason });
  if (billing.window === undefined || billing.window === null)
    return unknown("MISSING_WINDOW");
  if (!currency || !window || billing.usdCnyRate !== "7.2")
    return unknown("INVALID_CONTEXT");
  if (billing.pricingVersion !== DEEPSEEK_PRICING_VERSION)
    return unknown("UNSUPPORTED_PRICE_VERSION");
  if (billing.requestedModel !== "deepseek/deepseek-v4-flash")
    return unknown("REQUESTED_MODEL_MISMATCH");
  const multiplier = window === "peak" ? 2n : 1n;
  const price = {
    input: rates[currency].input * multiplier,
    cacheRead: rates[currency].cacheRead * multiplier,
    output: rates[currency].output * multiplier,
  };
  metadata.pricingSource =
    currency === "CNY"
      ? "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"
      : "https://api-docs.deepseek.com/quick_start/pricing/";
  metadata.pricingVerifiedOn = "2026-10-20";
  metadata.priceUnit = "native_currency_per_million_tokens";
  metadata.pricesPerMillion = {
    input: decimal(price.input),
    cacheRead: decimal(price.cacheRead),
    cacheWrite: decimal(price.input),
    output: decimal(price.output),
  };
  if (!parsedIdentity.success) return unknown("UNSUPPORTED_PART");
  if (part.usage === undefined || part.usage === null)
    return unknown("MISSING_USAGE");
  if (!parsedUsage.success) return unknown("INVALID_USAGE_PROVENANCE");
  if (parsedUsage.data.provider !== "deepseek")
    return unknown("UNSUPPORTED_PROVIDER");
  if (!actualModels.has(parsedUsage.data.model))
    return unknown("UNSUPPORTED_MODEL");
  // The native finish-step classifier uses BYOK for direct API credentials.
  // Other routes do not establish a DeepSeek API cash billing relationship.
  if (parsedUsage.data.route !== "byok")
    return unknown("UNSUPPORTED_BILLING_ROUTE");
  if (!counts || counts.reasoning > counts.output)
    return unknown("INVALID_TOKEN_COUNTS");
  if (total === 0n) return unknown("ZERO_NORMALIZED_USAGE");
  const nativeNumerator =
    (BigInt(counts.input) + BigInt(counts.cache.write)) * price.input +
    BigInt(counts.cache.read) * price.cacheRead +
    BigInt(counts.output) * price.output;
  // Keep the original currency amount as an exact rational. Convert USD before
  // the single final ceiling, rather than rounding native currency first.
  metadata.nativeCost = {
    numerator: nativeNumerator.toString(),
    denominator: "1000000000000",
    currency,
  };
  const numerator =
    currency === "USD" ? nativeNumerator * 72n : nativeNumerator;
  const denominator = currency === "USD" ? 10000000n : 1000000n;
  const cnyMicros = (numerator + denominator - 1n) / denominator;
  metadata.calculatedCnyMicros = cnyMicros.toString();
  if (cnyMicros > 999999999999n) return unknown("USAGE_RANGE_INVALID");
  metadata.status = "priced";
  metadata.conversionApplied = currency === "USD";
  return result(decimal(cnyMicros));
}
