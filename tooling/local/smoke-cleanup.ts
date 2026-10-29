export type SmokeCleanupName =
  | "run_resolution"
  | "run_cancel"
  | "control_restore"
  | "evidence"
  | "temporary_config"
  | "observer"
  | "http"
  | "guard"
  | "database";
/** Every cleanup is attempted. Only stable component names escape failures. */
export async function cleanupSmoke(
  actions: ReadonlyArray<{
    name: SmokeCleanupName;
    close: () => Promise<void>;
  }>,
): Promise<SmokeCleanupName[]> {
  const failures: SmokeCleanupName[] = [];
  for (const action of actions)
    try {
      await action.close();
    } catch {
      failures.push(action.name);
    }
  return failures;
}
