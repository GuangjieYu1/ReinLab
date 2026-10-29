export type CancelState = "cancelled" | "cancel_unconfirmed";

export type CancelDependencies = {
  /** Close the transport that owns the kernel child. Best effort. */
  close: () => Promise<void>;
  /** True while the kernel process is still verifiably alive inside its runtime. */
  pidAlive: () => Promise<boolean>;
  /** Persist the terminal (or unconfirmed) run state. */
  onState: (state: CancelState) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cancel one run and only claim success once the kernel process is confirmed
 * gone. A dead transport handle is not evidence: the in-runtime process is the
 * authority. An unconfirmed stop leaves the session leased and is reported as
 * such instead of pretending the run stopped.
 */
export async function cancelRun(
  dependencies: CancelDependencies,
): Promise<{ status: CancelState; waitedMs: number }> {
  const started = Date.now();
  try {
    await dependencies.close();
  } catch {
    // The transport may already be gone; the liveness probe decides.
  }
  const pollMs = dependencies.pollMs ?? 150,
    timeoutMs = dependencies.timeoutMs ?? 8000;
  for (;;) {
    let alive = true;
    try {
      alive = await dependencies.pidAlive();
    } catch {
      alive = true;
    }
    if (!alive) {
      await dependencies.onState("cancelled");
      return { status: "cancelled", waitedMs: Date.now() - started };
    }
    if (Date.now() - started >= timeoutMs) {
      await dependencies.onState("cancel_unconfirmed");
      return { status: "cancel_unconfirmed", waitedMs: Date.now() - started };
    }
    await sleep(pollMs);
  }
}
