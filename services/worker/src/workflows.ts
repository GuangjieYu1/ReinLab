import type { HatchetClient } from "@hatchet-dev/typescript-sdk";
import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk";
import { z } from "zod";
import type { RecoveryDiscovery } from "./discovery";

export type RecoveryPort = {
  recoverable(accountId: string): Promise<readonly string[]>;
  reconcileRun(accountId: string, runId: string): Promise<unknown>;
};
const Account = z.object({ accountId: z.string().uuid() }).strict();
const Run = Account.extend({ runId: z.string().uuid() }).strict();
const queued = (expression: string) => ({
  expression,
  maxRuns: 1,
  limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
});
/** Names and input contain identifiers only. No model prompt, approval or resource mutation port. */
export function recoveryWorkflows(
  hatchet: HatchetClient,
  discovery: RecoveryDiscovery,
  recovery: RecoveryPort
) {
  const observe = hatchet.task<
    { accountId: string; runId: string },
    { checked: boolean }
  >({
    name: "run.observe",
    concurrency: queued("input.accountId"),
    idempotency: {
      expression: "input.accountId + ':' + input.runId",
      strategy: "status",
      fallbackTtlMs: 600_000,
    },
    executionTimeout: "90s",
    retries: 2,
    fn: async (input) => {
      const ids = Run.parse(input);
      await recovery.reconcileRun(ids.accountId, ids.runId);
      return { checked: true };
    },
  });
  const account = hatchet.task<{ accountId: string }, { queued: number }>({
    name: "account.reconcile",
    concurrency: queued("input.accountId"),
    idempotency: {
      expression: "input.accountId",
      strategy: "status",
      fallbackTtlMs: 600_000,
    },
    executionTimeout: "2m",
    retries: 2,
    fn: async (input) => {
      const { accountId } = Account.parse(input);
      const runs = await recovery.recoverable(accountId);
      for (const runId of runs)
        await observe.runNoWait({
          accountId,
          runId: z.string().uuid().parse(runId),
        });
      return { queued: runs.length };
    },
  });
  const discover = hatchet.task<Record<string, never>, { accounts: number }>({
    name: "account.discover",
    onCrons: ["* * * * *"],
    concurrency: queued("'global'"),
    executionTimeout: "2m",
    retries: 2,
    fn: async () => {
      // A fresh sweep starts at the beginning, including randomly ordered newly created UUIDs.
      let after: string | undefined,
        count = 0;
      const through = await discovery.ceiling();
      if (!through) return { accounts: 0 };
      for (;;) {
        const page = await discovery.page(after, 100, through);
        for (const accountId of page) await account.runNoWait({ accountId });
        count += page.length;
        if (page.length < 100) break;
        after = page.at(-1);
      }
      return { accounts: count };
    },
  });
  return { discover, account, observe };
}
