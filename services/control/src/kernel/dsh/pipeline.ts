import type { HarnessFactory, HarnessLike } from "./session";
import { runTurn, type HarnessEvent, type TurnOutcome } from "./session";
import { cancelRun, type CancelState } from "./cancel";
import type { LaunchPlan } from "./launch";

export type RunRequest = {
  plan: LaunchPlan;
  prompt: string;
  resume: boolean;
  token: string;
};

export type PipelineDependencies = {
  factory: HarnessFactory;
  /** Persist one kernel event as the dossier's business record. */
  onEvent: (event: HarnessEvent) => void | Promise<void>;
  /** Persist the session actually used (a stale resume starts a fresh one). */
  onSession?: (sessionId: string, resumed: boolean) => void | Promise<void>;
  /** Persist the run's terminal state, including an unconfirmed stop. */
  onState: (
    state: "completed" | "failed" | "cancelled" | "cancel_unconfirmed",
    detail?: string,
  ) => void | Promise<void>;
  /** Release the run-scoped files once the runtime is gone. */
  release: () => Promise<void>;
  /**
   * One extra turn when the turn ended while a product promise is still unmet
   * (讲解层没写满 / 候选还没交给用户选)。补完还不够就照实结束，并记下 code。
   */
  followUp?: {
    /** Return the reminder to send, or null when nothing is missing. */
    reminder: () => Promise<string | null>;
    /** Logged when the reminder turn left the same thing missing. */
    code: string;
    detail: () => Promise<string>;
  };
};

export type RunHandle = {
  done: Promise<TurnOutcome>;
  /** Present once the runtime exists, so a cancel closes exactly this child. */
  harness: Promise<HarnessLike>;
  cancel: () => Promise<CancelState>;
};

/**
 * One run = one kernel child. The handle exposes the owning runtime so a cancel
 * stops that child only and is only reported once the process is confirmed gone.
 */
export function executeRun(
  dependencies: PipelineDependencies,
  request: RunRequest,
): RunHandle {
  let owned: HarnessLike | undefined;
  let cancelRequested = false;
  let resolveHarness: (harness: HarnessLike) => void;
  const harnessReady = new Promise<HarnessLike>((resolve) => {
    resolveHarness = resolve;
  });

  const done = (async () => {
    try {
      let outcome = await runTurn({
        plan: request.plan,
        prompt: request.prompt,
        resume: request.resume,
        factory: dependencies.factory,
        onEvent: (event) => dependencies.onEvent(event),
        onHarness: (harness) => {
          owned = harness;
          resolveHarness(harness);
        },
        onSession: (sessionId, resumed) =>
          dependencies.onSession?.(sessionId, resumed),
      });
      if (
        outcome.state === "failed" &&
        !cancelRequested &&
        outcome.errorCode === "MALFORMED_RESPONSE"
      ) {
        // 模型有一次把工具参数写成了不合法 JSON：同一次运行里让它重发一次，
        // 不因为一次格式错误就整轮失败。
        const again = await runTurn({
          plan: request.plan,
          prompt:
            "上一次的工具调用参数不是合法 JSON，整轮因此中断。请把那次调用重发一次，参数保持简短（长引用可以拆成几次写）。",
          resume: true,
          factory: dependencies.factory,
          onEvent: (event) => dependencies.onEvent(event),
          onHarness: (harness) => {
            owned = harness;
          },
          onSession: (sessionId, resumed) => dependencies.onSession?.(sessionId, resumed),
        });
        outcome = again;
      }
      if (outcome.state === "completed" && !cancelRequested && dependencies.followUp) {
        const followUp = dependencies.followUp;
        const reminder = await followUp.reminder();
        if (reminder) {
          // 模型以为这一轮已经结束：同一次运行里提醒一次，补到什么算什么。
          const again = await runTurn({
            plan: request.plan,
            prompt: reminder,
            resume: true,
            factory: dependencies.factory,
            onEvent: (event) => dependencies.onEvent(event),
            onHarness: (harness) => {
              owned = harness;
            },
            onSession: (sessionId, resumed) =>
              dependencies.onSession?.(sessionId, resumed),
          });
          outcome = again;
          if (again.state === "completed" && (await followUp.reminder()))
            console.error(
              JSON.stringify({
                code: followUp.code,
                run: request.plan.run,
                detail: await followUp.detail(),
              }),
            );
        }
      }
      await dependencies.onState(
        outcome.state,
        outcome.state === "failed"
          ? [outcome.errorCode ?? "KERNEL_FAILED", outcome.errorDetail]
              .filter(Boolean)
              .join("：")
          : undefined,
      );
      return outcome;
    } catch (error) {
      if (cancelRequested) {
        // The cancel path already wrote the terminal state after confirming the
        // process stop; a closed transport must not overwrite it with "failed".
        throw error;
      }
      // Stable code + message only: enough to diagnose, no prompt or token text.
      console.error(
        JSON.stringify({
          code: "KERNEL_RUN_FAILED",
          run: request.plan.run,
          message: String((error as Error)?.message ?? error).slice(0, 500),
        }),
      );
      await dependencies.onState(
        "failed",
        String((error as Error)?.message ?? error).slice(0, 300),
      );
      throw error;
    } finally {
      await dependencies.release().catch(() => {});
    }
  })();

  return {
    done,
    harness: harnessReady,
    cancel: async () => {
      cancelRequested = true;
      const harness = owned ?? (await harnessReady.catch(() => undefined));
      const receipt = await cancelRun({
        close: () => (harness ? harness.close() : Promise.resolve()),
        pidAlive: () => pidAlive(request.plan.paths.pidFile),
        onState: async (state) => {
          await dependencies.onState(state);
        },
      });
      return receipt.status;
    },
  };
}

async function pidAlive(pidFile: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  let pid: number;
  try {
    pid = Number((await readFile(pidFile, "utf8")).trim());
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
