import { expect, it } from "vitest";
import {
  DEEPSEEK_PRICING_VERSION,
  priceDeepSeekUsage,
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
  id: "prt_usage",
  messageID: "msg_usage",
  sessionID: "ses_usage",
  reason: "stop",
  cost: 0,
  usage: {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    route: "byok",
    time: 1792454400000,
  },
  tokens: {
    input: 1000000,
    output: 1000000,
    reasoning: 250000,
    cache: { read: 1000000, write: 0 },
  },
});
it.each([
  ["offpeak", "5.020000"],
  ["peak", "10.040000"],
] as const)(
  "CNY native rates: %s do not multiply by fixed FX",
  (window, expected) => {
    const result = priceDeepSeekUsage(part(), { ...context, window });
    expect(result.costCny).toBe(expected);
    expect(result.metadata).toMatchObject({
      status: "priced",
      billingCurrency: "CNY",
      conversionApplied: false,
      usdCnyRate: "7.2",
    });
  },
);
it("USD official rates convert once to CNY after summing the original currency", () => {
  const result = priceDeepSeekUsage(part(), { ...context, currency: "USD" });
  expect(result.costCny).toBe("5.421600");
  expect(result.metadata).toMatchObject({
    billingCurrency: "USD",
    conversionApplied: true,
    pricesPerMillion: {
      cacheRead: "0.003000",
      input: "0.150000",
      output: "0.600000",
    },
  });
});
it("cache and reasoning respect native normalized semantics without double counting", () => {
  const usage = part();
  usage.tokens = {
    input: 100,
    output: 100,
    reasoning: 80,
    cache: { read: 200, write: 300 },
  };
  const result = priceDeepSeekUsage(usage, context);
  expect(result.costCny).toBe("0.000804");
  expect(result.metadata).toMatchObject({
    counts: {
      input: 100,
      output: 100,
      reasoning: 80,
      cacheRead: 200,
      cacheWrite: 300,
    },
    totalBilledTokens: "700",
  });
});
it("USD peak is the independent USD table doubled, not a relabelled CNY table", () => {
  expect(
    priceDeepSeekUsage(part(), { ...context, currency: "USD", window: "peak" })
      .costCny,
  ).toBe("10.843200");
});
it("ceil only once after exact native summation and USD conversion", () => {
  const usage = part();
  usage.tokens = {
    input: 1,
    output: 1,
    reasoning: 0,
    cache: { read: 1, write: 0 },
  };
  expect(
    priceDeepSeekUsage(usage, { ...context, currency: "USD" }).costCny,
  ).toBe("0.000006");
  usage.tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 1, write: 0 },
  };
  expect(priceDeepSeekUsage(usage, context).costCny).toBe("0.000001");
});
it("preserves exact large counts but refuses a cost above the ledger range", () => {
  const usage = part();
  usage.tokens = {
    input: Number.MAX_SAFE_INTEGER,
    output: 1,
    reasoning: 0,
    cache: { read: 1, write: 0 },
  };
  const result = priceDeepSeekUsage(usage, context);
  expect(result.costCny).toBeNull();
  expect(result.metadata).toMatchObject({
    unknownReason: "USAGE_RANGE_INVALID",
    totalBilledTokens: "9007199254740993",
    nativeCost: {
      numerator: "9007199254740995020000",
      denominator: "1000000000000",
    },
  });
});
it.each(["deepseek-v4-flash", "deepseek-flash"])(
  "accepts only documented Flash API aliases: %s",
  (model) => {
    const usage = part();
    usage.usage.model = model;
    expect(priceDeepSeekUsage(usage, context).costCny).toBe("5.020000");
  },
);
it.each(["openai", "deepseek-proxy", "DeepSeek"])(
  "does not infer an actual DeepSeek provider from the requested route: %s",
  (provider) => {
    const usage = part();
    usage.usage.provider = provider;
    expect(priceDeepSeekUsage(usage, context)).toMatchObject({
      costCny: null,
      metadata: {
        unknownReason: "UNSUPPORTED_PROVIDER",
        actualProvider: provider,
      },
    });
  },
);
it.each([
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-flash,other",
])("unknown actual model is not priced as Flash: %s", (model) => {
  const usage = part();
  usage.usage.model = model;
  expect(priceDeepSeekUsage(usage, context)).toMatchObject({
    costCny: null,
    metadata: { unknownReason: "UNSUPPORTED_MODEL" },
  });
});
it("missing actual provenance cannot be reconstructed from response or assistant model fields", () => {
  const usage: any = part();
  delete usage.usage;
  usage.modelID = "deepseek-v4-flash";
  usage.providerID = "deepseek";
  usage.response = { model: "deepseek-v4-flash" };
  expect(priceDeepSeekUsage(usage, context)).toMatchObject({
    costCny: null,
    metadata: { unknownReason: "MISSING_USAGE", actualModel: null },
  });
});
it.each([undefined, null, [], {}, { type: "assistant" }])(
  "missing or aggregated input is unknown: %j",
  (usage) => {
    expect(priceDeepSeekUsage(usage, context).costCny).toBeNull();
  },
);
it("does not aggregate a mixed model array or accept assistant totals as a second usage source", () => {
  expect(priceDeepSeekUsage([part(), part()], context).costCny).toBeNull();
  expect(
    priceDeepSeekUsage({ ...part(), type: "assistant" }, context).costCny,
  ).toBeNull();
});
it.each([
  -1,
  0.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  "1",
  null,
  undefined,
])(
  "invalid token counters remain unknown instead of being normalized to zero: %s",
  (value) => {
    for (const field of [
      "input",
      "output",
      "reasoning",
      "cacheRead",
      "cacheWrite",
    ]) {
      const usage: any = part();
      if (field === "cacheRead" || field === "cacheWrite")
        usage.tokens.cache[field === "cacheRead" ? "read" : "write"] = value;
      else usage.tokens[field] = value;
      expect(priceDeepSeekUsage(usage, context)).toMatchObject({
        costCny: null,
        metadata: { unknownReason: "INVALID_TOKEN_COUNTS" },
      });
    }
  },
);
it("all-zero normalized usage cannot turn an absent provider bill into known free usage", () => {
  const usage = part();
  usage.tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  usage.cost = 99;
  expect(priceDeepSeekUsage(usage, context)).toMatchObject({
    costCny: null,
    metadata: { unknownReason: "ZERO_NORMALIZED_USAGE" },
  });
});
it("reasoning is a subset of output and cannot exceed it", () => {
  const usage = part();
  usage.tokens.reasoning = usage.tokens.output + 1;
  expect(priceDeepSeekUsage(usage, context).costCny).toBeNull();
});
it.each([
  { window: undefined },
  { window: null },
  { window: "weekday" },
  { currency: "EUR" },
  { usdCnyRate: "7.3" },
  { requestedModel: "openai/other" },
  { pricingVersion: "unverified-version" },
])(
  "uncertain context never silently falls back to a window or table: %j",
  (patch) => {
    expect(
      priceDeepSeekUsage(part(), { ...context, ...patch } as any).costCny,
    ).toBeNull();
  },
);
it("metadata is deterministic JSON and contains pricing provenance rather than raw payload or upstream cost", () => {
  const usage: any = part();
  usage.privatePayload = { token: "fixture-private-marker" };
  usage.cost = 123;
  const before = JSON.stringify(usage),
    first = priceDeepSeekUsage(usage, context),
    second = priceDeepSeekUsage(usage, context);
  expect(first).toEqual(second);
  expect(JSON.stringify(usage)).toBe(before);
  expect(first.metadata).toMatchObject({
    usageSource: "openscience_normalized_step_finish",
    normalizationVersion: "2.0.150",
    sourcePartId: usage.id,
    sourceSessionId: usage.sessionID,
    sourceMessageId: usage.messageID,
    requestedModel: context.requestedModel,
    actualProvider: "deepseek",
    actualModel: "deepseek-v4-flash",
    actualRoute: "byok",
    providerTime: usage.usage.time,
    pricingVersion: DEEPSEEK_PRICING_VERSION,
    priceWindow: "offpeak",
    priceWindowSource: "caller_explicit_no_clock_inference",
    pricingVerifiedOn: "2026-10-20",
    nativeCost: {
      numerator: "5020000000000",
      denominator: "1000000000000",
      currency: "CNY",
    },
    providerInvoiceReconciled: false,
  });
  expect(JSON.stringify(first.metadata)).not.toContain(
    "fixture-private-marker",
  );
  expect(JSON.parse(JSON.stringify(first.metadata))).toEqual(first.metadata);
});
it.each(["id", "sessionID", "messageID"])(
  "a step without its valid %s cannot become attributable usage",
  (field) => {
    const usage: any = part();
    delete usage[field];
    expect(priceDeepSeekUsage(usage, context)).toMatchObject({
      costCny: null,
      metadata: { unknownReason: "UNSUPPORTED_PART" },
    });
  },
);
it.each([0, NaN, Number.MAX_SAFE_INTEGER + 1, undefined])(
  "invalid provider time does not become trusted window evidence: %s",
  (time) => {
    const usage: any = part();
    usage.usage.time = time;
    expect(priceDeepSeekUsage(usage, context)).toMatchObject({
      costCny: null,
      metadata: {
        unknownReason: "INVALID_USAGE_PROVENANCE",
        providerTime: null,
      },
    });
  },
);

it.each(["subscription", "local", "chatgpt", "managed", "custom"])(
  "non-BYOK billing route does not become DeepSeek API cash cost: %s",
  (route) => {
    const usage = part();
    usage.usage.route = route;
    expect(priceDeepSeekUsage(usage, context)).toMatchObject({
      costCny: null,
      metadata: {
        unknownReason: "UNSUPPORTED_BILLING_ROUTE",
        actualRoute: route,
        conversionApplied: false,
      },
    });
  },
);
it.each([
  [999999999998, "999999.999999"],
  [999999999999, null],
] as const)(
  "ceil is checked against the ledger microCNY limit for input=%s",
  (input, expected) => {
    const usage = part();
    usage.tokens = {
      input,
      output: 0,
      reasoning: 0,
      cache: { read: 1, write: 0 },
    };
    const result = priceDeepSeekUsage(usage, context);
    expect(result.costCny).toBe(expected);
    if (expected === null)
      expect(result.metadata.unknownReason).toBe("USAGE_RANGE_INVALID");
  },
);
it.each(["id", "sessionID", "messageID"])(
  "credential-shaped source %s cannot authorize priced usage",
  (field) => {
    const usage: any = part();
    const marker = "sk_" + "fixtureprivate".repeat(3);
    usage[field] = marker;
    const result = priceDeepSeekUsage(usage, context);
    expect(result.costCny).toBeNull();
    expect(result.metadata.unknownReason).toBe("UNSUPPORTED_PART");
    expect(JSON.stringify(result)).not.toContain(marker);
  },
);
it.each(["sk_short", "prt_sk_embedded", "ghp_" + "fixture".repeat(5)])(
  "label rejection also covers short or embedded credential prefixes: %s",
  (marker) => {
    const usage = part();
    usage.id = marker;
    expect(priceDeepSeekUsage(usage, context)).toMatchObject({
      costCny: null,
      metadata: { unknownReason: "UNSUPPORTED_PART", sourcePartId: null },
    });
  },
);
it("all returned metadata labels are bounded even when context or provenance is invalid", () => {
  const marker = "fixturelabel".repeat(20);
  for (const field of ["provider", "model", "route"]) {
    const usage = part();
    (usage.usage as Record<string, unknown>)[field] = marker;
    const result = priceDeepSeekUsage(usage, context);
    expect(result.costCny).toBeNull();
    expect(JSON.stringify(result)).not.toContain(marker);
  }
  for (const field of ["requestedModel", "pricingVersion"]) {
    const result = priceDeepSeekUsage(part(), { ...context, [field]: marker });
    expect(result.costCny).toBeNull();
    expect(JSON.stringify(result)).not.toContain(marker);
  }
});
