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
   * A read turn that stops short of the promised layers gets exactly one
   * reminder turn; if it is still short the run ends as it really is.
   */
  layers?: {
    minimum: number;
    /** How many layer cards this run already wrote. */
    count: () => Promise<number>;
    reminder: (have: number, minimum: number) => string;
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
      if (outcome.state === "completed" && !cancelRequested && dependencies.layers) {
        const { minimum, count, reminder } = dependencies.layers;
        const have = await count();
        if (have < minimum) {
          // 模型以为讲完了：同一次运行里提醒它补写，只补一层是一层，不丢已经写下的。
          const again = await runTurn({
            plan: request.plan,
            prompt: reminder(have, minimum),
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
          if (again.state === "completed") {
            const after = await count();
            if (after < minimum)
              console.error(
                JSON.stringify({
                  code: "KERNEL_LAYERS_SHORT",
                  run: request.plan.run,
                  layers: after,
                  minimum,
                }),
              );
          }
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
