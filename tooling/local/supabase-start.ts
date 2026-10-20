export async function startLocalSupabase(start: () => Promise<void>, wait: (ms: number) => Promise<void>) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await start(); return; }
    catch (error) {
      // Only CLI infrastructure startup is retried. No Auth signup, business
      // transaction, provider request or model prompt is in this operation.
      const code = (error as Error)?.message;
      if (attempt === 3 || !['LOCAL_COMMAND_FAILED', 'LOCAL_SERVICE_UNHEALTHY'].includes(code)) throw error;
      await wait(attempt * 2000);
    }
  }
}
