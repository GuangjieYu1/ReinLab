import { it, expect } from "vitest";
import { mapRuntimeEvent } from "../src/bridge/openscience/mapping";
const part = {
  id: "prt_independent",
  sessionID: "ses_independent",
  messageID: "msg_independent",
  type: "step-finish",
  reason: "stop",
  cost: 0.1,
  tokens: { input: 1, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
  usage: {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    route: "byok",
    time: 1,
  },
};
const event = (patch: Record<string, unknown>) => ({
  sequence: 1,
  sessionID: "ses_independent",
  runID: "run_independent",
  type: "message.part.updated",
  properties: { part: { ...part, ...patch } },
  time: 1,
});
it("all mapped fields remain bounded, including usage metadata outside ledger payload", () => {
  const result = mapRuntimeEvent(event({ tier: "x".repeat(100000) }), {
    toolGrants: {},
  });
  expect(JSON.stringify(result).length).toBeLessThan(70000);
});
it("credential-like usage metadata is not copied unredacted outside the scrubbed payload", () => {
  const result = mapRuntimeEvent(
    event({
      usage: { ...part.usage, model: "Bearer fixture-private-mapping-value" },
    }),
    { toolGrants: {} },
  );
  expect(JSON.stringify(result)).not.toContain("fixture-private-mapping-value");
});
