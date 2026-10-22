import type { Database } from "../../db/database";
import { ApiFailure, denied } from "../../api/errors";
import { lockBudget } from "../../budget";
import { appendEvent } from "../../ledger";
import {
  RunBridge,
  type RuntimeFactory,
  type RunDefinition,
  type Submission,
} from "./run-bridge";
import { createProductionRuntimeFactory } from "./production-factory";
import { createHarnessRunDefinitionLoader } from "./run-definition";
import { ObservationStore } from "./observation-store";
import {
  ObservationScheduler,
  createObservationAccess,
} from "./observation-scheduler";
import { DecisionService } from "./decisions";
export type RuntimePipelineOptions = {
  factory?: RuntimeFactory;
  definitionLoader?: (
    accountId: string,
    runId: string,
  ) => Promise<RunDefinition>;
  pricingContext?: unknown;
  prepareCapabilities?: (accountId: string, runId: string) => Promise<void>;
  cleanupCapabilities?: (accountId: string, runId: string) => Promise<void>;
  maxConcurrent?: number;
};
/** Production composition. Only explicit submit admits models; recovery exposes read ports only. */
export class RuntimePipeline {
  readonly decisions: DecisionService;
  private readonly bridge: RunBridge;
  private readonly scheduler: ObservationScheduler;
  private closed = false;
  constructor(
    private readonly db: Database,
    options: RuntimePipelineOptions = {},
  ) {
    if (
      (options.factory || options.definitionLoader) &&
      process.env.NODE_ENV !== "test"
    )
      throw new ApiFailure(
        "TEST_DEPENDENCY_FORBIDDEN",
        503,
        "测试执行依赖不能用于生产运行。",
      );
    this.bridge = new RunBridge(
      db,
      options.factory ?? createProductionRuntimeFactory(db),
      options.definitionLoader ?? createHarnessRunDefinitionLoader(db),
      {
        pricingContext: options.pricingContext,
        prepareCapabilities: options.prepareCapabilities,
      },
    );
    const observations = new ObservationStore(db, options.cleanupCapabilities);
    this.scheduler = new ObservationScheduler(
      createObservationAccess(db, this.bridge),
      (account, run) => observations.sink(account, run),
      { maxConcurrent: options.maxConcurrent },
    );
    this.decisions = new DecisionService(db, this.bridge);
  }
  async submit(accountId: string, runId: string): Promise<Submission> {
    if (this.closed)
      throw new ApiFailure("RUNTIME_PIPELINE_CLOSED", 503, "执行管线已关闭。");
    const result = await this.bridge.submit(accountId, runId);
    if (result.status === "accepted") this.scheduler.start(accountId, runId);
    else if (result.status === "indeterminate")
      await this.db.withAccount(accountId, async (client) => {
        await lockBudget(client, accountId);
        const row = (
          await client.query("select dossier_id,role_id from run where id=$1", [
            runId,
          ])
        ).rows[0];
        if (!row) throw denied();
        await appendEvent(client, accountId, {
          dossierId: row.dossier_id,
          runId,
          roleId: row.role_id,
          kind: "gate",
          action: "runtime_submission_indeterminate",
          payload: { code: "SUBMISSION_INDETERMINATE", resubmitted: false },
          dedupeKey: "runtime-submission-indeterminate:" + runId,
        });
      });
    return result;
  }
  async recoverAccount(accountId: string): Promise<number> {
    return this.scheduler.recoverAccount(accountId);
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.scheduler.shutdown();
  }
}
