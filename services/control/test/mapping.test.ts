import { expect, it } from "vitest";
import {
  mapRuntimeEvent,
  type MappingContext,
} from "../src/bridge/openscience/mapping";
import { mcpAutoReply } from "../src/mcp/approval-bridge";

const context: MappingContext = {
  toolGrants: {
    read: { risk: "read", permission: "allow" },
    write: { risk: "write", permission: "ask" },
  },
};
const base = {
  id: "prt_fixture",
  sessionID: "ses_fixture",
  messageID: "msg_fixture",
};
const event = (type: string, properties: unknown) => ({
  sequence: 1,
  sessionID: "ses_fixture",
  runID: "run_fixture",
  type,
  properties,
  time: 1,
});
const token = {
  input: 2,
  output: 3,
  reasoning: 1,
  cache: { read: 4, write: 5 },
};
const parts: Record<string, unknown> = {
  text: { text: "fixture" },
  reasoning: { text: "fixture", time: { start: 1 } },
  file: { mime: "text/plain", url: "file:///fixture" },
  subtask: { prompt: "fixture", description: "fixture", agent: "research" },
  agent: { name: "research" },
  conversation: {
    sourceSessionID: "ses_source",
    throughMessageID: "msg_source",
    snapshotID: "snapshot",
    label: "fixture",
    text: "fixture",
  },
  retry: {
    attempt: 1,
    error: { name: "APIError", data: { message: "fixture" } },
    time: { created: 1 },
  },
  compaction: { auto: true },
  "step-start": {},
  "step-finish": {
    reason: "stop",
    cost: 0.1,
    tokens: token,
    usage: { route: "byok", provider: "fixture", model: "actual", time: 1 },
  },
  snapshot: { snapshot: "fixture" },
  patch: { hash: "fixture", files: ["fixture.txt"] },
  tool: {
    callID: "call_fixture",
    tool: "read",
    state: {
      status: "completed",
      input: {},
      output: "fixture",
      title: "fixture",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  },
};
const requests = {
  id: "per_fixture",
  sessionID: "ses_fixture",
  permission: "read",
  patterns: ["fixture"],
  metadata: {},
  always: [],
};
const questions = {
  id: "que_fixture",
  sessionID: "ses_fixture",
  questions: [
    {
      question: "fixture?",
      header: "fixture",
      options: [{ label: "yes", description: "fixture" }],
    },
  ],
};
const properties: Record<string, unknown> = {
  "runtime.accepted": { acceptedAt: 1, effort: "normal" },
  "runtime.completed": { messageID: "msg_fixture" },
  "runtime.failed": { message: "fixture" },
  "runtime.cancelled": { source: "user" },
  "message.updated": {
    info: {
      id: "msg_fixture",
      sessionID: "ses_fixture",
      role: "user",
      time: { created: 1 },
    },
  },
  "message.removed": { sessionID: "ses_fixture", messageID: "msg_fixture" },
  "message.part.updated": {
    part: { ...base, type: "text", ...(parts.text as object) },
  },
  "message.part.removed": {
    sessionID: "ses_fixture",
    messageID: "msg_fixture",
    partID: "prt_fixture",
  },
  "permission.asked": requests,
  "permission.cancelled": {
    sessionID: "ses_fixture",
    requestID: "per_fixture",
  },
  "permission.replied": {
    sessionID: "ses_fixture",
    requestID: "per_fixture",
    reply: "once",
  },
  "question.asked": questions,
  "question.replied": {
    sessionID: "ses_fixture",
    requestID: "que_fixture",
    answers: [["yes"]],
  },
  "question.cancelled": { sessionID: "ses_fixture", requestID: "que_fixture" },
  "question.rejected": { sessionID: "ses_fixture", requestID: "que_fixture" },
  "session.status": { sessionID: "ses_fixture", status: { type: "busy" } },
  "session.idle": { sessionID: "ses_fixture" },
  "session.diff": { sessionID: "ses_fixture", diff: [] },
  "session.error": {
    sessionID: "ses_fixture",
    error: { name: "UnknownError", data: { message: "fixture" } },
  },
  "session.filesystem.changed": {
    sessionID: "ses_fixture",
    projectID: "project",
    grant: {
      id: "fsg_fixture",
      path: "/fixture",
      access: "read",
      scope: "session",
      source: "api",
      time: { created: 1 },
    },
  },
  "session.context": {
    sessionID: "ses_fixture",
    tokens: { system: 1, text: 1, reasoning: 0, tool: 0, skills: 0, image: 0 },
    images: 0,
    total: 2,
  },
  "session.compaction": {
    sessionID: "ses_fixture",
    trigger: "manual",
    mechanism: "prune",
    reclaimed: 1,
  },
  "session.request.progress": {
    sessionID: "ses_fixture",
    messageID: "msg_fixture",
    attempt: 1,
    agent: "research",
    providerID: "fixture",
    modelID: "fixture",
    phase: "streaming",
    since: 1,
    elapsedMs: 1,
    stalls: 0,
  },
  "session.compacted": { sessionID: "ses_fixture" },
  "todo.updated": { sessionID: "ses_fixture", todos: [] },
  "command.executed": {
    sessionID: "ses_fixture",
    name: "fixture",
    arguments: "",
    messageID: "msg_fixture",
  },
};
it.each(Object.entries(properties))(
  "maps known runtime event %s",
  (type, body) => {
    const mapped = mapRuntimeEvent(event(type, body), context);
    expect(mapped.action).not.toBe("unmapped_event");
    expect(mapped.payload).toBeTypeOf("object");
  },
);
it.each(Object.entries(parts))("maps known native part %s", (type, body) => {
  const mapped = mapRuntimeEvent(
    event("message.part.updated", {
      part: { ...base, type, ...(body as object) },
    }),
    context,
  );
  expect(mapped.action).not.toBe("unmapped_event");
});
it("maps unknown types, unknown parts, broken required fields and invalid envelopes to ledger errors", () => {
  for (const raw of [
    event("future.type", { secret: "fixture" }),
    event("message.part.updated", { part: { ...base, type: "future" } }),
    event("runtime.completed", {}),
    event("permission.asked", {}),
    event("session.diff", {
      sessionID: "ses_fixture",
      diff: [{ file: "fixture" }],
    }),
    {
      ...event("runtime.completed", { messageID: "msg_fixture" }),
      sequence: NaN,
    },
  ])
    expect(mapRuntimeEvent(raw, context)).toMatchObject({
      kind: "error",
      action: "unmapped_event",
    });
});
it("tolerates unknown progress phases and missing display fields without touching accounting", () => {
  // 新的/未知的 phase 与缺失的耗时字段只影响展示，不该把订阅判死，也不该影响费用完整性。
  const unknownPhase = mapRuntimeEvent(
    event("session.request.progress", {
      sessionID: "ses_fixture",
      messageID: "msg_fixture",
      phase: "folding_context",
      elapsedMs: -1,
      stalls: "3",
      extraField: "fixture",
    }),
    context,
  );
  expect(unknownPhase).toMatchObject({
    kind: "gate",
    action: "session_request_progress",
    accountingImpact: "none",
  });
  expect(unknownPhase.diagnostic).toMatchObject({
    code: "unknown_phase",
    eventType: "session.request.progress",
  });
  const stored = unknownPhase.payload.properties as Record<string, unknown>;
  expect(stored).toMatchObject({
    sessionID: "ses_fixture",
    phase: "folding_context",
  });
  expect(stored.elapsedMs).toBeUndefined();
  expect(stored.extraField).toBeUndefined();
  // 缺可选展示字段：省略即可，不算异常。
  const sparse = mapRuntimeEvent(
    event("session.request.progress", {
      sessionID: "ses_fixture",
      messageID: "msg_fixture",
      phase: "streaming",
    }),
    context,
  );
  expect(sparse).toMatchObject({ accountingImpact: "none" });
  expect(sparse.diagnostic).toBeUndefined();
  // 给了但用不了（负数耗时、字符串 stalls）：省略并留一条被容忍的诊断。
  expect(sparse.payload.properties).toMatchObject({
    sessionID: "ses_fixture",
    phase: "streaming",
  });
  // 身份仍然严格：没有 session/message 还是拒。
  expect(
    mapRuntimeEvent(event("session.request.progress", { phase: "streaming" }), context),
  ).toMatchObject({ kind: "error", action: "unmapped_event" });
});
it("unknown types leave a bounded compatibility diagnostic and no accounting impact", () => {
  const mapped = mapRuntimeEvent(
    event("future.type", { secret: "fixture-value" }),
    context,
  );
  expect(mapped).toMatchObject({
    kind: "error",
    action: "unmapped_event",
    accountingImpact: "none",
  });
  expect(mapped.diagnostic).toMatchObject({
    code: "unknown_event_type",
    eventType: "future.type",
  });
  expect(JSON.stringify(mapped.payload)).not.toContain("fixture-value");
});
it("only an undecided-consumed MCP approval is auto-answered, never a fresh one", () => {
  // run8 R4：人已经批过的 MCP 能力调用，内核再问一次权限时由控制面自动答复。
  expect(mcpAutoReply({ decision: "approve", consumed: false })).toBe("once");
  expect(mcpAutoReply({ decision: "reject", consumed: false })).toBe("reject");
  expect(mcpAutoReply({ decision: "approve", consumed: true })).toBeNull();
  expect(mcpAutoReply({ decision: null, consumed: false })).toBeNull();
  expect(mcpAutoReply(undefined)).toBeNull();
});
it("derives tool risk from own grants and never accepts metadata risk or prototype grants", () => {
  const part = { ...base, type: "tool", ...(parts.tool as object) };
  expect(
    mapRuntimeEvent(
      event("message.part.updated", {
        part: { ...part, metadata: { risk: "danger" } },
      }),
      context,
    ).risk,
  ).toBe("read");
  for (const tool of ["constructor", "toString", "ungranted"])
    expect(
      mapRuntimeEvent(
        event("message.part.updated", { part: { ...part, tool } }),
        context,
      ),
    ).toMatchObject({ kind: "error", action: "unmapped_event" });
});
it("emits one step usage projection, marks missing/invalid fields unknown and never derives usage from assistant totals", () => {
  const part = {
    ...base,
    type: "step-finish",
    ...(parts["step-finish"] as object),
  };
  const mapped = mapRuntimeEvent(
    event("message.part.updated", { part }),
    context,
  );
  expect(mapped.usage).toMatchObject({
    status: "observed",
    tokens: token,
    upstreamCost: 0.1,
    providerId: "fixture",
    modelId: "actual",
  });
  expect(mapped).not.toHaveProperty("costCny");
  for (const patch of [
    { tokens: undefined },
    { tokens: { ...token, input: -1 } },
    { tokens: { ...token, input: NaN } },
    { cost: undefined },
    { cost: Infinity },
    { usage: undefined },
    {
      usage: {
        route: "invented",
        provider: "fixture",
        model: "fixture",
        time: 1,
      },
    },
  ]) {
    const result = mapRuntimeEvent(
      event("message.part.updated", { part: { ...part, ...patch } }),
      context,
    );
    expect(result.usage?.status).toBe("unknown");
  }
  expect(
    mapRuntimeEvent(
      event("message.updated", properties["message.updated"]),
      context,
    ).usage,
  ).toBeUndefined();
});
it("represents pending approvals as historical and preserves recovered interrupted state", () => {
  expect(
    mapRuntimeEvent(event("permission.asked", requests), context).approval,
  ).toMatchObject({
    state: "historical_pending",
    sessionID: "ses_fixture",
    requestID: "per_fixture",
  });
  expect(
    mapRuntimeEvent(
      event("runtime.failed", { message: "stopped", recovered: true }),
      context,
    ).runState,
  ).toBe("interrupted");
});
const cards = {
  card_answer: {
    kind: "answer",
    question: "fixture?",
    options: ["a", "b"],
    multi: false,
  },
  card_approval: {
    kind: "approval",
    title: "fixture",
    effects: ["fixture"],
    risk: "write",
    action: "fixture",
  },
  plan_propose: {
    kind: "plan",
    stage: "fixture",
    steps: ["fixture"],
    budgetCny: 1,
  },
  finding_record: {
    kind: "finding",
    claim: "fixture",
    citations: [{ source: "fixture", locator: "p1" }],
    negative: false,
  },
  verdict_record: {
    kind: "verdict",
    subject: "fixture",
    pass: true,
    reasons: ["fixture"],
  },
} as const;
it.each(Object.entries(cards))(
  "only maps explicitly trusted completed P111 %s data through the strict Card contract",
  (tool, card) => {
    const project: MappingContext = {
      toolGrants: { [tool]: { risk: "write", permission: "allow" } },
      trustedP111Tools: new Set([tool as keyof typeof cards]),
    };
    const part = { ...base, type: "tool", ...(parts.tool as object), tool };
    const state = (part as any).state;
    const raw = (data: unknown, status = "completed") =>
      event("message.part.updated", {
        part: { ...part, state: { ...state, status, metadata: { data } } },
      });
    expect(
      mapRuntimeEvent(raw(card), { toolGrants: project.toolGrants }).kind,
    ).toBe("tool");
    expect(mapRuntimeEvent(raw(card), project)).toMatchObject({
      kind: "card",
      payload: { card },
    });
    for (const bad of [
      { ...card, unexpected: true },
      { ...card, kind: "unknown" },
      tool === "card_answer" ? cards.verdict_record : cards.card_answer,
    ])
      expect(mapRuntimeEvent(raw(bad), project)).toMatchObject({
        kind: "error",
        action: "unmapped_event",
      });
    expect(mapRuntimeEvent(raw(card, "running"), project).kind).toBe("tool");
    expect(
      mapRuntimeEvent(raw(card), {
        ...project,
        toolGrants: { [tool]: { risk: "danger", permission: "deny" } },
      }).kind,
    ).not.toBe("card");
  },
);
it("bounds and scrubs payloads without mutating input or recursing forever", () => {
  const raw = event("message.part.updated", {
    part: {
      ...base,
      type: "text",
      text: "x".repeat(100000),
      metadata: {
        authorization: "Bearer fixture-private-value",
        api_key: "fixture-private-key",
      },
    },
  });
  const result = mapRuntimeEvent(raw, context);
  expect(JSON.stringify(result).length).toBeLessThan(70000);
  expect(JSON.stringify(result)).not.toContain("fixture-private");
  expect((raw.properties as any).part.text).toHaveLength(100000);
  const cycle: any = {};
  cycle.self = cycle;
  expect(
    mapRuntimeEvent(
      event("session.error", { sessionID: "ses_fixture", error: cycle }),
      context,
    ),
  ).toMatchObject({ kind: "error", action: "unmapped_event" });
});

it("invalid outer usage labels become unknown and approval identifiers cannot bypass output scrubbing", () => {
  for (const patch of [
    { tier: "x".repeat(100000) },
    {
      usage: {
        route: "byok",
        provider: "fixture",
        model: "Bearer fixture-private-outer",
        time: 1,
      },
    },
  ]) {
    const result = mapRuntimeEvent(
      event("message.part.updated", {
        part: {
          ...base,
          type: "step-finish",
          ...(parts["step-finish"] as object),
          ...patch,
        },
      }),
      context,
    );
    expect(result.usage?.status).toBe("unknown");
    expect(result.usage?.unknownReasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("fixture-private-outer");
    expect(JSON.stringify(result).length).toBeLessThan(70000);
  }
  for (const patch of [
    { sessionID: "Bearer fixture-private-approval" },
    { id: "Bearer fixture-private-approval" },
  ]) {
    const result = mapRuntimeEvent(
      event("permission.asked", { ...requests, ...patch }),
      context,
    );
    expect(result).toMatchObject({ kind: "error", action: "unmapped_event" });
    expect(JSON.stringify(result)).not.toContain("fixture-private-approval");
  }
});
