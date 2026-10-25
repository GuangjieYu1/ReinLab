import { createApp } from "./app";
import type { RuntimeConfiguration } from "../configuration";
import { pricingFromEnvironment } from "../budget/pricing";
import { loadToolRegistry, loadBenchBundle } from "../harness/manifest";
import { HarnessStore } from "../harness/store";
import { Database } from "../db/database";

/** The one-shot operator serves the production API, with the protected file configuration. */
export async function createSmokeApp(
  options: Parameters<typeof createApp>[0],
  configuration: RuntimeConfiguration
) {
  const registry = await loadToolRegistry();
  const harness =
    options.harness ??
    new HarnessStore(
      new Database(options.pool),
      await loadBenchBundle({
        benchId: "research",
        version: "1.1.0",
        registry,
      }),
      registry
    );
  return createApp({
    ...options,
    harness,
    pricing: pricingFromEnvironment(configuration),
  });
}
