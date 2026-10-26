/** One user-authorized attempt. Changing any binding requires a new reviewed commit. */
export const thirdSmokeBinding = Object.freeze({
  authorization: "user-third-authorization-20261026",
  authorizationLabel: "第三次授权",
  executor: "Codex",
  directory: "mcp10-third-authorization-20261026",
  validFrom: "2026-10-26T01:00:00.000Z",
  validUntil: "2026-10-26T03:50:00.000Z",
  window: "peak",
  version: "1.1.0",
  budgetCny: 1,
});
export function validateSmokeBinding(input: unknown, now: number) {
  const fail = () => {
    throw Error("MCP10_BINDING_INVALID");
  };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail();
  const keys = Object.keys(thirdSmokeBinding),
    value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some(
      (key) =>
        value[key] !== thirdSmokeBinding[key as keyof typeof thirdSmokeBinding],
    ) ||
    !Number.isSafeInteger(now) ||
    now < Date.parse(thirdSmokeBinding.validFrom) ||
    now + 600_000 >= Date.parse(thirdSmokeBinding.validUntil)
  )
    return fail();
  return thirdSmokeBinding;
}
