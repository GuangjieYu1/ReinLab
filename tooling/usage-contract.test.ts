import { expect, it } from "vitest";
import {
  UsageAccountingSource,
  GatewayUsageCallback,
} from "../packages/contracts/src/index";
const uuid = "11111111-1111-4111-8111-111111111111";
const callback = () => ({
  schemaVersion: 1,
  source: "gateway_callback",
  eventId: "gateway_event_1",
  accountId: uuid,
  dossierId: uuid,
  runId: uuid,
  requestId: "run_request_1",
  provider: "deepseek",
  model: "DeepSeek-V4.1-Flash-1017",
  reportedAt: "2026-10-21T06:00:00Z",
  tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  nativeCost: { currency: "CNY", amount: "0.000001" },
});
it("reserves exactly the current direct and future gateway fee sources", () => {
  for (const source of ["direct_provider_usage", "gateway_callback"])
    expect(UsageAccountingSource.parse(source)).toBe(source);
  for (const source of ["client", "verified_gateway", ""])
    expect(UsageAccountingSource.safeParse(source).success).toBe(false);
});
it("preserves a strict callback data envelope and exact native decimal without pricing it", () => {
  const raw = callback();
  raw.nativeCost.amount = "0.000000000001";
  expect(GatewayUsageCallback.parse(raw)).toEqual(raw);
});
it("keeps missing usage explicitly unknown rather than defaulting counts or money to zero", () => {
  const raw = {
    ...callback(),
    tokens: {
      input: null,
      output: null,
      reasoning: null,
      cacheRead: null,
      cacheWrite: null,
    },
    nativeCost: { currency: "USD", amount: null },
  };
  expect(GatewayUsageCallback.parse(raw)).toEqual(raw);
  const missing = { ...callback() } as any;
  delete missing.tokens;
  expect(GatewayUsageCallback.safeParse(missing).success).toBe(false);
});
it("rejects credential and authorization assertions instead of treating schema parse as verification", () => {
  for (const key of [
    "apiKey",
    "authorization",
    "token",
    "verified",
    "approved",
  ])
    expect(
      GatewayUsageCallback.safeParse({ ...callback(), [key]: "fixture-only" })
        .success,
    ).toBe(false);
  expect(
    GatewayUsageCallback.safeParse({
      ...callback(),
      source: "direct_provider_usage",
    }).success,
  ).toBe(false);
});
it("rejects malformed ids, clocks and non-exact or invalid monetary values", () => {
  for (const patch of [
    { accountId: "foreign-path" },
    { eventId: "x".repeat(161) },
    { reportedAt: "not-a-time" },
    { provider: "Bearer fixture-private-value" },
  ])
    expect(
      GatewayUsageCallback.safeParse({ ...callback(), ...patch }).success,
    ).toBe(false);
  for (const amount of [
    0,
    -1,
    "-1",
    "1e-6",
    "0.1234567890123",
    "1 ".repeat(20),
  ])
    expect(
      GatewayUsageCallback.safeParse({
        ...callback(),
        nativeCost: { currency: "CNY", amount },
      }).success,
    ).toBe(false);
});
it("requires safe nonnegative integer counters and does not silently add optional fields", () => {
  for (const input of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(
      GatewayUsageCallback.safeParse({
        ...callback(),
        tokens: { ...callback().tokens, input },
      }).success,
    ).toBe(false);
  expect(
    GatewayUsageCallback.safeParse({
      ...callback(),
      nativeCost: { currency: "CNY", amount: "1", verified: true },
    }).success,
  ).toBe(false);
});
