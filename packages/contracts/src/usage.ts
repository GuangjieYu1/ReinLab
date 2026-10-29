import { z } from "zod";
/** Accounting provenance only; a source label does not authenticate a callback. */
export const UsageAccountingSource = z.enum([
  "direct_provider_usage",
  "gateway_callback",
]);
export type UsageAccountingSource = z.infer<typeof UsageAccountingSource>;
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const modelLabel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
const count = z.number().int().nonnegative().safe().nullable();
/** Reserved normalized callback data. No handler or signature verification is implemented. */
export const GatewayUsageCallback = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("gateway_callback"),
    eventId: identity,
    accountId: z.string().uuid(),
    dossierId: z.string().uuid(),
    runId: z.string().uuid(),
    requestId: identity,
    provider: modelLabel,
    model: modelLabel,
    reportedAt: z.string().max(64).datetime({ offset: true }),
    tokens: z
      .object({
        input: count,
        output: count,
        reasoning: count,
        cacheRead: count,
        cacheWrite: count,
      })
      .strict(),
    nativeCost: z
      .object({
        currency: z.enum(["CNY", "USD"]),
        amount: z
          .string()
          .regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/)
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type GatewayUsageCallback = z.infer<typeof GatewayUsageCallback>;
