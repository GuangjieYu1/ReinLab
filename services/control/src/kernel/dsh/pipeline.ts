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
  /** Persist the run's terminal state, including an unconfirmed stop. */
  onState: (
    state: "completed" | "failed" | "cancelled" | "cancel_unconfirmed",
  ) => void | Promise<void>;
  /** Release the run-scoped files once the runtime is gone. */
  release: () => Promise<void>;
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
  let resolveHarness: (harness: HarnessLike) => void;
  const harnessReady = new Promise<HarnessLike>((resolve) => {
    resolveHarness = resolve;
  });

  const done = (async () => {
    try {
      const outcome = await runTurn({
        plan: request.plan,
        prompt: request.prompt,
        resume: request.resume,
        factory: dependencies.factory,
        onEvent: (event) => dependencies.onEvent(event),
        onHarness: (harness) => {
          owned = harness;
          resolveHarness(harness);
        },
      });
      await dependencies.onState(outcome.state);
      return outcome;
    } catch (error) {
      await dependencies.onState("failed");
      throw error;
    } finally {
      await dependencies.release().catch(() => {});
    }
  })();

  return {
    done,
    harness: harnessReady,
    cancel: async () => {
      const harness = owned ?? (await harnessReady.catch(() => undefined));
      const receipt = await cancelRun({
        close: () => (harness ? harness.close() : Promise.resolve()),
        pidAlive: () => pidAlive(request.plan.paths.pidFile),
        onState: (state) => dependencies.onState(state),
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
