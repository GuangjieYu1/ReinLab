import { randomUUID } from "node:crypto";
import type { LaunchPlan } from "./launch";

/** One kernel session event as delivered by the SDK transport. */
export type HarnessEvent = { type: string; data?: Record<string, unknown> };
export type HarnessNotification = { method: string; params?: unknown };

export type TurnResult = {
  sessionId: string;
  events: HarnessEvent[];
  finalResponse: string;
};
/** 一轮里可以带的内容：文字，或「文字 + 已编码图片」（SDK 原样发送）。 */
export type PromptImage = { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
export type PromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: PromptImage["mimeType"] };
export type PromptInput = string | PromptBlock[];

export type HarnessSessionHandle = {
  run: (
    input: PromptInput,
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
  errorDetail?: string;
  finalResponse: string;
  sessionId: string;
};

const failedReason = (reason: unknown): { code: string; detail?: string } | null => {
  const value = typeof reason === "object" && reason !== null ? (reason as Record<string, any>) : {};
  const kind = value.kind;
  if (kind === "completed") return null;
  if (kind === "max-tokens") return { code: "KERNEL_MAX_TOKENS" };
  if (kind === "aborted" || kind === "interrupted") return { code: "KERNEL_INTERRUPTED" };
  if (kind === "blocked") return { code: "KERNEL_BLOCKED" };
  if (kind === "error") {
    // Keep the provider/runtime code and message: "KERNEL_FAILED" alone hides
    // the actual cause (e.g. MALFORMED_RESPONSE from an oversized tool payload).
    const failure = value.error ?? {};
    const code = typeof failure.code === "string" ? failure.code : "KERNEL_FAILED";
    const detail = typeof failure.message === "string" ? failure.message : undefined;
    return { code, ...(detail ? { detail } : {}) };
  }
  return { code: "KERNEL_FAILED" };
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
  prompt: PromptInput;
  resume: boolean;
  factory: HarnessFactory;
  onEvent: (event: HarnessEvent) => void | Promise<void>;
  /** The exact runtime owning this turn, so a cancel closes this child only. */
  onHarness?: (harness: HarnessLike) => void | Promise<void>;
  /** Reports the session actually used, including a fresh one after a stale resume. */
  onSession?: (sessionId: string, resumed: boolean) => void | Promise<void>;
}): Promise<TurnOutcome> {
  const harness = input.factory(input.plan.options);
  await input.onHarness?.(harness);
  try {
    let sessionId = input.plan.sessionId;
    let handle: HarnessSessionHandle;
    if (input.resume) {
      try {
        handle = (await harness.resumeSession(sessionId)) as HarnessSessionHandle;
        await input.onSession?.(sessionId, true);
      } catch {
        // The stored id has no persisted runtime state: start a fresh session
        // instead of failing the run, and report the id that was really used.
        sessionId = "ds-" + randomUUID();
        handle = harness.session(sessionId);
        await input.onSession?.(sessionId, false);
      }
    } else {
      handle = harness.session(sessionId);
      await input.onSession?.(sessionId, false);
    }
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
    let failure: { code: string; detail?: string } | null = { code: "KERNEL_FAILED" };
    for (const event of result.events)
      if (event.type === "turn/end") failure = failedReason(event.data?.reason);
    return {
      state: failure === null ? "completed" : "failed",
      errorCode: failure?.code ?? null,
      errorDetail: failure?.detail,
      finalResponse: result.finalResponse,
      sessionId: result.sessionId,
    };
  } finally {
    await harness.close().catch(() => {});
  }
}

/**
 * 一轮的输入：先放用户这句话，再附上这次的参考图。
 * 图片字节已经在控制面读好并编码，这里只负责排好顺序。
 */
export function promptWithImages(text: string, images: PromptImage[] = []): PromptInput {
  if (!images.length) return text;
  return [
    { type: "text" as const, text },
    ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
  ];
}
