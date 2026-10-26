import {
  Card,
  type JsonValue,
  type LedgerEvent,
  type Risk,
} from "@reinlab/contracts";
import { z } from "zod";
import { scrub } from "../../ledger";
export type P111CardTool =
  | "card_answer"
  | "card_approval"
  | "plan_propose"
  | "finding_record"
  | "verdict_record";
export type MappingContext = {
  toolGrants: Readonly<
    Record<string, { risk: Risk; permission: "allow" | "ask" | "deny" }>
  >;
  trustedP111Tools?: ReadonlySet<P111CardTool>;
};
export type RuntimeTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};
export type RuntimeUsage = {
  sessionID: string;
  messageID: string;
  partID: string;
  status: "observed" | "unknown";
  tokens: RuntimeTokens | null;
  upstreamCost: number | null;
  providerId: string | null;
  modelId: string | null;
  route: string | null;
  tier: string | null;
  time: number | null;
  unknownReasons: string[];
};
export type MappedApproval = {
  kind: "permission" | "question";
  sessionID: string;
  requestID: string;
  state: "historical_pending" | "resolved" | "cancelled" | "rejected";
};
/** 这张事件能不能影响费用完整性：默认 none，只有明确认识到的坏用量才是 uncertain。
 *  不能从 kind=error 推断——未知事件、未知 part、被容忍的展示字段都属于 none。 */
export type AccountingImpact = "none" | "uncertain";
export type CompatDiagnostic = {
  code: string;
  eventType?: string;
  fieldPaths?: string[];
};
export type MappedRuntimeEvent = {
  kind: LedgerEvent["kind"];
  action: string;
  payload: Record<string, JsonValue>;
  risk?: Risk;
  approval?: MappedApproval;
  usage?: RuntimeUsage;
  runState?: "accepted" | "completed" | "failed" | "cancelled" | "interrupted";
  accountingImpact?: AccountingImpact;
  diagnostic?: CompatDiagnostic;
};
const id = z.string().min(1).max(500),
  number = z.number().finite().nonnegative(),
  count = number.int().safe();
const record = z.record(z.unknown()),
  sid = { sessionID: id },
  mid = { ...sid, messageID: id },
  rid = { ...sid, requestID: id };
const object = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough();
const Envelope = z
  .object({
    sequence: count.positive(),
    sessionID: id,
    runID: id,
    type: id,
    properties: record,
    time: count,
  })
  .strict();
type Envelope = z.infer<typeof Envelope>;
const reply = z.enum(["once", "session", "project", "always", "reject"]);
const ErrorInfo = object({ name: id, data: record.optional() });
const question = object({
  question: z.string(),
  header: z.string(),
  options: z.array(object({ label: z.string(), description: z.string() })),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
});
const grant = object({
  id: id,
  path: z.string(),
  access: z.enum(["read", "write"]),
  scope: z.enum(["once", "session", "project", "installation"]),
  source: z.enum([
    "workspace",
    "project",
    "skill",
    "permission",
    "api",
    "tool",
    "handoff",
    "parent",
  ]),
  time: object({
    created: number,
    consumed: number.optional(),
    revoked: number.optional(),
  }),
});
const status = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("compacting") }),
  z.object({
    type: z.literal("retry"),
    attempt: number,
    message: z.string(),
    next: number,
  }),
]);
const schemas: Record<string, z.ZodTypeAny> = {
  "runtime.accepted": object({
    acceptedAt: count,
    effort: z.enum(["normal", "ultra"]),
  }),
  "runtime.completed": object({ messageID: id }),
  "runtime.failed": object({
    message: z.string(),
    messageID: id.optional(),
    recovered: z.boolean().optional(),
  }),
  "runtime.cancelled": object({
    source: z.enum(["user", "runner_timeout"]),
    messageID: id.optional(),
    recovered: z.boolean().optional(),
  }),
  "message.updated": object({
    info: object({
      id,
      ...sid,
      role: z.enum(["user", "assistant"]),
      time: object({ created: number, completed: number.optional() }),
    }),
  }),
  "message.removed": object(mid),
  "message.part.updated": object({
    part: record,
    delta: z.string().optional(),
  }),
  "message.part.removed": object({ ...mid, partID: id }),
  "permission.asked": object({
    id,
    ...sid,
    permission: id,
    patterns: z.array(z.string()),
    metadata: record,
    always: z.array(z.string()),
    tool: object({ messageID: id, callID: id }).optional(),
  }),
  "permission.cancelled": object(rid),
  "permission.replied": object({ ...rid, reply }),
  "question.asked": object({
    id,
    ...sid,
    questions: z.array(question),
    tool: object({ messageID: id, callID: id }).optional(),
  }),
  "question.replied": object({ ...rid, answers: z.array(z.array(z.string())) }),
  "question.cancelled": object(rid),
  "question.rejected": object(rid),
  "session.status": object({ ...sid, status }),
  "session.idle": object(sid),
  "session.diff": object({
    ...sid,
    diff: z.array(
      object({
        file: z.string(),
        before: z.string(),
        after: z.string(),
        additions: number,
        deletions: number,
      }),
    ),
  }),
  "session.error": object({ ...sid, error: ErrorInfo }),
  "session.filesystem.changed": object({
    ...sid,
    projectID: id,
    grant,
    narrowing: z.boolean().optional(),
  }),
  "session.context": object({
    ...sid,
    tokens: object({
      system: number,
      text: number,
      reasoning: number,
      tool: number,
      skills: number,
      image: number,
      document: number.optional(),
    }),
    images: number,
    total: number,
    budget: object({
      total: number,
      newest: number,
      history: number,
      usable: number,
      soft: number,
      hard: number,
    }).optional(),
  }),
  "session.compaction": object({
    ...sid,
    trigger: z.enum(["proactive", "overflow", "manual"]),
    mechanism: z.enum(["prune", "summary"]),
    before: number.optional(),
    after: number.optional(),
    reclaimed: number,
  }),
  // 进度只是展示：身份严格，其余字段容忍未知值与缺失，不让订阅因展示字段断掉。
  "session.request.progress": object({ ...mid }),
  "session.compacted": object(sid),
  "todo.updated": object({
    ...sid,
    todos: z.array(
      object({
        id,
        content: z.string(),
        status: z.string(),
        priority: z.string(),
      }),
    ),
  }),
  "command.executed": object({ ...mid, name: id, arguments: z.string() }),
};
const toolStates = z.discriminatedUnion("status", [
  object({ status: z.literal("pending"), input: record, raw: z.string() }),
  object({
    status: z.literal("running"),
    input: record,
    raw: z.string().optional(),
    title: z.string().optional(),
    metadata: record.optional(),
    time: object({ start: number }),
  }),
  object({
    status: z.literal("completed"),
    input: record,
    raw: z.string().optional(),
    output: z.string(),
    title: z.string(),
    metadata: record,
    time: object({ start: number, end: number, compacted: number.optional() }),
    attachments: z.array(record).optional(),
  }),
  object({
    status: z.literal("error"),
    input: record,
    raw: z.string().optional(),
    error: z.string(),
    metadata: record.optional(),
    time: object({ start: number, end: number }),
  }),
]);
const partBase = { id, ...mid };
const fields: Record<string, z.ZodRawShape> = {
  text: {
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: object({ start: number, end: number.optional() }).optional(),
    metadata: record.optional(),
  },
  reasoning: {
    text: z.string(),
    time: object({ start: number, end: number.optional() }),
    metadata: record.optional(),
  },
  file: {
    mime: z.string(),
    url: z.string(),
    filename: z.string().optional(),
    source: record.optional(),
  },
  subtask: {
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: object({ providerID: id, modelID: id }).optional(),
    command: z.string().optional(),
    attachments: z.array(record).optional(),
  },
  agent: {
    name: z.string(),
    source: object({
      value: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    }).optional(),
  },
  conversation: {
    sourceSessionID: id,
    throughMessageID: id,
    snapshotID: id,
    label: id,
    text: z.string(),
  },
  retry: {
    attempt: number,
    error: ErrorInfo,
    time: object({ created: number }),
  },
  compaction: {
    auto: z.boolean(),
    focus: z.string().optional(),
    handoffFile: z.string().optional(),
    trigger: z.enum(["proactive", "overflow", "manual"]).optional(),
    rootID: id.optional(),
    before: count.optional(),
    after: count.optional(),
  },
  "step-start": { snapshot: z.string().optional() },
  "step-finish": {
    reason: z.string(),
    snapshot: z.string().optional(),
    tier: z.string().optional(),
  },
  snapshot: { snapshot: z.string() },
  patch: { hash: z.string(), files: z.array(z.string()) },
  tool: {
    callID: id,
    tool: id,
    state: toolStates,
    metadata: record.optional(),
  },
};
const partSchemas = Object.fromEntries(
  Object.entries(fields).map(([type, shape]) => [
    type,
    object({ ...partBase, type: z.literal(type), ...shape }),
  ]),
);
const tokenSchema = z.object({
  input: count,
  output: count,
  reasoning: count,
  cache: z.object({ read: count, write: count }),
});
// Labels are pricing identities, not arbitrary provider text or credentials.
const metadataLabel = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$/)
  .refine((value) => value.length <= 200 && scrub(value) === value);
const observationIdentity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((value) => value.length <= 200 && scrub(value) === value);
const usageMeta = z.object({
  route: z.enum([
    "managed",
    "byok",
    "chatgpt",
    "subscription",
    "local",
    "custom",
  ]),
  provider: metadataLabel,
  model: metadataLabel,
  time: number,
});
const grantSchema = z.object({
  risk: z.enum(["read", "write", "danger"]),
  permission: z.enum(["allow", "ask", "deny"]),
});
const cardKinds: Record<P111CardTool, string> = {
  card_answer: "answer",
  card_approval: "approval",
  plan_propose: "plan",
  finding_record: "finding",
  verdict_record: "verdict",
};

/** Bound all copied values before the shared ledger scrubber sees them. */
function bounded(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const copy = (item: unknown, depth: number): JsonValue => {
    if (++nodes > 2048 || depth > 16) throw Error("payload_limit");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string")
      return item.length > 8192 ? item.slice(0, 8192) + "[TRUNCATED]" : item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item !== "object" || !item) throw Error("invalid_json");
    if (seen.has(item)) throw Error("cyclic_json");
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 128) throw Error("payload_limit");
        return item.map((v) => (v === undefined ? null : copy(v, depth + 1)));
      }
      const entries = Object.entries(item);
      if (entries.length > 128) throw Error("payload_limit");
      return Object.fromEntries(
        entries
          .filter(([, v]) => v !== undefined)
          .map(([key, v]) => [key.slice(0, 500), copy(v, depth + 1)]),
      );
    } finally {
      seen.delete(item);
    }
  };
  const result = copy(value, 0);
  if (JSON.stringify(result).length > 65536) throw Error("payload_limit");
  return scrub(result);
}
function source(event: Envelope) {
  return {
    sequence: event.sequence,
    sessionID: event.sessionID,
    runID: event.runID,
    type: event.type,
    time: event.time,
  };
}
function unmapped(
  reason: string,
  event?: Envelope,
  fieldPaths?: string[],
): MappedRuntimeEvent {
  // 未知/无法解析不等于费用出问题：默认不影响记账，只留可对账的诊断。
  return {
    kind: "error",
    action: "unmapped_event",
    accountingImpact: "none",
    diagnostic: diagnostic(reason, event?.type, fieldPaths),
    payload: bounded({
      reason,
      ...(event ? { source: source(event) } : {}),
      diagnostic: diagnostic(reason, event?.type, fieldPaths),
    }) as Record<string, JsonValue>,
  };
}
/** 有界、脱敏的兼容诊断：只留类型/字段名，不留原始载荷。 */
function diagnostic(
  code: string,
  eventType?: string,
  fieldPaths?: string[],
): CompatDiagnostic {
  return {
    code: code.slice(0, 64),
    ...(eventType ? { eventType: eventType.slice(0, 120) } : {}),
    ...(fieldPaths?.length
      ? {
          fieldPaths: [...new Set(fieldPaths)]
            .slice(0, 8)
            .map((path) => path.slice(0, 120)),
        }
      : {}),
  };
}
const progressPhases = new Set([
  "preparing",
  "connecting",
  "waiting_first_token",
  "streaming",
  "conflict_wait",
  "retry_wait",
  "done",
  "error",
]);
const displayNumbers = [
  "since",
  "elapsedMs",
  "retryAfterMs",
  "firstOutputMs",
  "lastOutputAt",
  "stalls",
  "attempt",
] as const;
/** 进度只保留展示需要的字段；耗时等辅助值缺失或无效就省略，并记一条诊断。 */
function progressView(body: Record<string, any>) {
  const dropped: string[] = [],
    view: Record<string, unknown> = {
      sessionID: body.sessionID,
      messageID: body.messageID,
    };
  const phase = typeof body.phase === "string" ? body.phase.slice(0, 64) : "",
    missing: string[] = [];
  if (phase) view.phase = phase;
  else if (body.phase !== undefined) dropped.push("properties.phase");
  else missing.push("properties.phase");
  if (phase && !progressPhases.has(phase)) dropped.push("properties.phase");
  for (const key of ["agent", "providerID", "modelID"] as const) {
    const value = body[key];
    if (typeof value === "string" && value && value.length <= 120)
      view[key] = value;
    else if (value !== undefined) dropped.push("properties." + key);
  }
  for (const key of displayNumbers) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      view[key] = value;
    else if (value !== undefined) dropped.push("properties." + key);
  }
  if (typeof body.detail === "string")
    view.detail = body.detail.slice(0, 500);
  // 缺可选字段是正常的（省略即可）；只有「给了但用不了」或未知 phase 才留诊断。
  const paths = [...dropped, ...missing];
  return {
    view,
    diagnostic: dropped.length
      ? diagnostic(
          phase && !progressPhases.has(phase)
            ? "unknown_phase"
            : "progress_field_tolerated",
          "session.request.progress",
          paths,
        )
      : undefined,
  };
}
function usage(part: Record<string, unknown>): RuntimeUsage {
  if (
    ![part.sessionID, part.messageID, part.id].every(
      (value) => observationIdentity.safeParse(value).success,
    )
  )
    throw Error("usage_identity_invalid");
  const tokens = tokenSchema.safeParse(part.tokens),
    cost = number.safeParse(part.cost),
    meta = usageMeta.safeParse(part.usage),
    tier = metadataLabel.optional().safeParse(part.tier);
  const reasons = [
    ...(!tokens.success ? ["tokens_missing_or_invalid"] : []),
    ...(!cost.success ? ["cost_missing_or_invalid"] : []),
    ...(!meta.success ? ["model_usage_missing_or_invalid"] : []),
    ...(!tier.success ? ["tier_invalid"] : []),
  ];
  return {
    sessionID: String(part.sessionID),
    messageID: String(part.messageID),
    partID: String(part.id),
    status: reasons.length ? "unknown" : "observed",
    tokens: tokens.success ? tokens.data : null,
    upstreamCost: cost.success ? cost.data : null,
    providerId: meta.success ? meta.data.provider : null,
    modelId: meta.success ? meta.data.model : null,
    route: meta.success ? meta.data.route : null,
    tier: tier.success ? (tier.data ?? null) : null,
    time: meta.success ? meta.data.time : null,
    unknownReasons: reasons,
  };
}
function projectPart(
  part: Record<string, any>,
  context: MappingContext,
): Omit<MappedRuntimeEvent, "payload"> & { card?: z.infer<typeof Card> } {
  if (part.type === "step-finish") {
    const observed = usage(part);
    return {
      kind: "cost",
      action: "usage_observed",
      usage: observed,
      ...(observed.status === "unknown"
        ? { accountingImpact: "uncertain" as const }
        : { accountingImpact: "none" as const }),
    };
  }
  if (part.type === "tool") {
    if (!context.toolGrants || !Object.hasOwn(context.toolGrants, part.tool))
      throw Error("tool_grant_missing");
    const parsed = grantSchema.safeParse(context.toolGrants[part.tool]);
    if (!parsed.success) throw Error("tool_grant_invalid");
    const authorization = parsed.data;
    if (
      Object.hasOwn(cardKinds, part.tool) &&
      context.trustedP111Tools?.has(part.tool as P111CardTool) &&
      part.state.status === "completed" &&
      authorization.permission !== "deny" &&
      authorization.risk !== "danger"
    ) {
      const card = Card.safeParse(part.state.metadata.data);
      if (
        !card.success ||
        card.data.kind !== cardKinds[part.tool as P111CardTool]
      )
        throw Error("card_data_invalid");
      return {
        kind: "card",
        action: "card_created",
        risk: authorization.risk,
        card: card.data,
      };
    }
    return {
      kind: "tool",
      action: "tool_" + part.state.status,
      risk: authorization.risk,
    };
  }
  if (part.type === "subtask" || part.type === "agent")
    return { kind: "delegation", action: "part_" + part.type };
  if (["step-start", "retry", "compaction"].includes(part.type))
    return { kind: "gate", action: "part_" + part.type.replaceAll("-", "_") };
  return { kind: "message", action: "part_" + part.type };
}
/** Pure projection; no runtime submission, decision, filesystem, or price operation. */
export function mapRuntimeEvent(
  raw: unknown,
  context: MappingContext,
): MappedRuntimeEvent {
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) return unmapped("invalid_envelope");
  const event = parsed.data;
  try {
    if (!Object.hasOwn(schemas, event.type))
      return unmapped("unknown_event_type", event);
    const properties = schemas[event.type].safeParse(event.properties);
    if (!properties.success) return unmapped("invalid_event_properties", event);
    const body = properties.data as Record<string, any>;
    let projection: Omit<MappedRuntimeEvent, "payload"> = {
      kind: "gate",
      action: event.type.replaceAll(".", "_"),
    };
    let card: z.infer<typeof Card> | undefined;
    if (event.type === "message.part.updated") {
      const type = body.part.type;
      if (typeof type !== "string" || !Object.hasOwn(partSchemas, type))
        return unmapped("unknown_part_type", event);
      const part = partSchemas[type].safeParse(body.part);
      if (!part.success) return unmapped("invalid_part_properties", event);
      const result = projectPart(part.data, context);
      ({ card, ...projection } = result);
    } else if (
      event.type === "message.updated" ||
      event.type === "message.removed" ||
      event.type === "message.part.removed"
    )
      projection.kind = "message";
    else if (
      event.type.startsWith("permission.") ||
      event.type.startsWith("question.")
    ) {
      const [kind, suffix] = event.type.split(".");
      const state =
        suffix === "asked"
          ? "historical_pending"
          : suffix === "replied"
            ? "resolved"
            : suffix === "rejected"
              ? "rejected"
              : "cancelled";
      projection.kind = "approval";
      if (
        ![body.sessionID, suffix === "asked" ? body.id : body.requestID].every(
          (value) => observationIdentity.safeParse(value).success,
        )
      )
        throw Error("approval_identity_invalid");
      projection.approval = {
        kind: kind as "permission" | "question",
        sessionID: body.sessionID,
        requestID: suffix === "asked" ? body.id : body.requestID,
        state,
      };
    } else if (event.type === "runtime.accepted")
      projection.runState = "accepted";
    else if (event.type === "runtime.completed")
      projection.runState = "completed";
    else if (event.type === "runtime.cancelled")
      projection.runState = "cancelled";
    else if (event.type === "runtime.failed") {
      projection.kind = "error";
      projection.runState = body.recovered === true ? "interrupted" : "failed";
    } else if (event.type === "session.error") projection.kind = "error";
    if (
      event.type === "message.part.updated" &&
      body.part.type === "tool" &&
      (body.part.tool === "read_quiz_write" ||
        ["cards.read_quiz_write", "cards.card.quiz"].includes(
          body.part.state?.input?.capability,
        ))
    ) {
      const p = body.part;
      body.part = {
        id: p.id,
        sessionID: p.sessionID,
        messageID: p.messageID,
        type: "tool",
        tool: p.tool,
        callID: p.callID,
        state: {
          status: p.state.status,
          ...(p.state.time ? { time: p.state.time } : {}),
        },
      };
    }
    // 进度只存展示字段；缺字段/未知 phase 留诊断，但仍是记账无关事件。
    const progress =
      event.type === "session.request.progress" ? progressView(body) : undefined;
    // Every outward field, including projections outside payload, shares the
    // same final bound and scrub pass. Numeric observations remain numeric.
    return bounded({
      ...projection,
      ...(projection.accountingImpact
        ? {}
        : { accountingImpact: "none" as const }),
      ...(progress?.diagnostic ? { diagnostic: progress.diagnostic } : {}),
      payload: bounded({
        source: source(event),
        properties: progress?.view ?? body,
        ...(progress?.diagnostic
          ? { diagnostic: progress.diagnostic as unknown as JsonValue }
          : {}),
        ...(card ? { card } : {}),
      }) as Record<string, JsonValue>,
    }) as MappedRuntimeEvent;
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
        ? error.message
        : "invalid_event_properties";
    return unmapped(reason, event);
  }
}
