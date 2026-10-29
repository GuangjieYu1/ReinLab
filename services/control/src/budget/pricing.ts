import { createHash } from "node:crypto";
import { z } from "zod";
import { EstimateRequest } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import { micros, decimal } from "./money";

type Tier = "cheap" | "mid" | "strong";
type Config = {
  catalogUrl: string;
  routes: Partial<Record<Tier, string>>;
  usdCny: string;
};
const unavailable = () =>
  new ApiFailure(
    "PRICING_UNAVAILABLE",
    503,
    "尚无可验证的模型价格、模型路由或人民币汇率，请先配置。"
  );
export class PricingService {
  readonly catalogUrl: string;
  private cached?: {
    expires: number;
    request: Promise<{ data: unknown; sha: string }>;
  };
  constructor(private readonly config: Config) {
    this.catalogUrl = config.catalogUrl;
  }
  private async catalog() {
    if (this.cached && this.cached.expires > Date.now())
      return this.cached.request;
    const request = (async () => {
      try {
        const response = await fetch(this.catalogUrl, {
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw unavailable();
        }
        const reader = response.body.getReader(),
          decoder = new TextDecoder(),
          hash = createHash("sha256");
        let bytes = 0,
          text = "";
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 64 * 1024 * 1024) {
              await reader.cancel();
              throw unavailable();
            }
            hash.update(part.value);
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        return { data: JSON.parse(text), sha: hash.digest("hex") };
      } catch {
        this.cached = undefined;
        throw unavailable();
      }
    })();
    this.cached = { expires: Date.now() + 300000, request };
    return request;
  }
  route(tier: Tier): string {
    const value = this.config.routes[tier];
    if (!value || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/.test(value))
      throw unavailable();
    return value;
  }
  async estimate(
    raw: Pick<z.input<typeof EstimateRequest>, "mode" | "modelTier" | "size">,
    policy?: {
      modelTier: Tier;
      defaultBudgetCny: string | null;
      pages?: number;
    }
  ) {
    const input = EstimateRequest.omit({ dossierId: true }).parse(raw),
      tier = input.modelTier ?? policy?.modelTier;
    if (!tier) throw unavailable();
    const route = this.config.routes[tier];
    let rate: bigint;
    try {
      rate = micros(this.config.usdCny);
      if (rate <= 0n || rate > 1000000000n) throw unavailable();
    } catch {
      throw unavailable();
    }
    if (!route) throw unavailable();
    const slash = route.indexOf("/"),
      provider = route.slice(0, slash),
      model = route.slice(slash + 1);
    if (slash < 1 || !model) throw unavailable();
    const { data, sha } = await this.catalog();
    const providers = z.record(z.unknown()).safeParse(data);
    if (!providers.success) throw unavailable();
    const models = z
      .object({ models: z.record(z.unknown()) })
      .safeParse(providers.data[provider]);
    if (!models.success) throw unavailable();
    const parsed = z
      .object({
        cost: z.object({
          input: z.number().finite().nonnegative(),
          output: z.number().finite().nonnegative(),
        }),
        limit: z.object({
          context: z.number().int().positive(),
          output: z.number().int().positive(),
        }),
      })
      .safeParse(models.data.models[model]);
    if (!parsed.success) throw unavailable();
    const record = parsed.data;
    if (record.limit.context < 13000 || record.limit.output < 3000)
      throw unavailable();
    let inputPrice: bigint, outputPrice: bigint;
    try {
      inputPrice = micros(record.cost.input);
      outputPrice = micros(record.cost.output);
    } catch {
      throw unavailable();
    }
    if (inputPrice === 0n && outputPrice === 0n) throw unavailable();
    const size =
        policy?.pages ?? input.size ?? (input.mode === "swarm" ? 8 : 1),
      rounds = input.mode === "auto" ? 16 : input.mode === "swarm" ? 4 : 1;
    const inputTokens = 10000 * size * rounds,
      outputTokens = 3000 * size * rounds;
    const numerator =
        (BigInt(inputTokens) * inputPrice +
          BigInt(outputTokens) * outputPrice) *
        rate *
        2n,
      denominator = 1000000000000n;
    const amount = (numerator + denominator - 1n) / denominator;
    return {
      model: route,
      modelTier: tier,
      estimatedCny: decimal(amount),
      quotaRuns: null,
      gpuMinutes: null,
      defaultBudgetCny: policy?.defaultBudgetCny ?? null,
      usdCnyRate: decimal(rate),
      catalogSha256: sha,
      inputTokens,
      outputTokens,
      assumptions: {
        size,
        rounds,
        inputTokensPerRound: 10000,
        outputTokensPerRound: 3000,
        safetyFactor: 2,
        pricingSource: "models.dev",
        usageIsEstimate: true,
      },
    };
  }
}
export function pricingFromEnvironment(
  env: Record<string, string | undefined> = process.env
): PricingService {
  return new PricingService({
    catalogUrl: "https://models.dev/api.json",
    usdCny: env.MODEL_USD_CNY_RATE ?? "",
    routes: {
      cheap: env.MODEL_ROUTE_CHEAP,
      mid: env.MODEL_ROUTE_MID,
      strong: env.MODEL_ROUTE_STRONG,
    },
  });
}
