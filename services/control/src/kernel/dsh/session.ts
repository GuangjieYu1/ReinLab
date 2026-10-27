import type { LaunchPlan } from "./launch";

/** One kernel session event as delivered by the SDK transport. */
export type HarnessEvent = { type: string; data?: Record<string, unknown> };
export type HarnessNotification = { method: string; params?: unknown };

export type TurnResult = {
  sessionId: string;
  events: HarnessEvent[];
  finalResponse: string;
};
export type HarnessSessionHandle = {
  run: (
    text: string,
    options: { onNotification?: (notification: HarnessNotification) => void },
  ) => Promise<TurnResult>;
};
/** The subset of the official SDK client this driver relies on. */
export type HarnessLike = {
  session: (id: string) => HarnessSessionHandle;
  resumeSession: (id: string) => Promise<unknown>;
  close: () => Promise<void>;
};
export type HarnessFactory = (options: LaunchPlan["options"]) => HarnessLike;

export type TurnOutcome = {
  state: "completed" | "failed";
  errorCode: string | null;
  finalResponse: string;
  sessionId: string;
};

const failedReason = (reason: unknown) => {
  const kind =
    typeof reason === "object" && reason !== null
      ? (reason as { kind?: unknown }).kind
      : undefined;
  if (kind === "completed") return null;
  if (kind === "max-tokens") return "KERNEL_MAX_TOKENS";
  if (kind === "aborted" || kind === "interrupted") return "KERNEL_INTERRUPTED";
  if (kind === "blocked") return "KERNEL_BLOCKED";
  return "KERNEL_FAILED";
};

/**
 * Drive one kernel turn and close the runtime afterwards.
 *
 * The runtime is one child per turn: resuming the saved session is how a
 * dossier keeps its conversation. Usage is deliberately not written here —
 * the model endpoint is the single authoritative usage writer.
 */
export async function runTurn(input: {
  plan: LaunchPlan;
  prompt: string;
  resume: boolean;
  factory: HarnessFactory;
  onEvent: (event: HarnessEvent) => void | Promise<void>;
  /** The exact runtime owning this turn, so a cancel closes this child only. */
  onHarness?: (harness: HarnessLike) => void | Promise<void>;
}): Promise<TurnOutcome> {
  const harness = input.factory(input.plan.options);
  await input.onHarness?.(harness);
  try {
    const handle = input.resume
      ? ((await harness.resumeSession(input.plan.sessionId)) as HarnessSessionHandle)
      : harness.session(input.plan.sessionId);
    // Events are queued so they reach the business record in wire order even
    // though the transport delivers them synchronously.
    let queue: Promise<void> = Promise.resolve();
    const result = await handle.run(input.prompt, {
      onNotification: (notification) => {
        if (notification?.method !== "session.event") return;
        const event = (notification.params as { event?: HarnessEvent } | undefined)?.event;
        if (event && typeof event.type === "string")
          queue = queue.then(() => Promise.resolve(input.onEvent(event))).catch(() => {});
      },
    });
    await queue;
    let errorCode: string | null = "KERNEL_FAILED";
    for (const event of result.events)
      if (event.type === "turn/end") errorCode = failedReason(event.data?.reason);
    return {
      state: errorCode === null ? "completed" : "failed",
      errorCode,
      finalResponse: result.finalResponse,
      sessionId: result.sessionId,
    };
  } finally {
    await harness.close().catch(() => {});
  }
}
