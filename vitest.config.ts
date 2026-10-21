import { availableParallelism } from "node:os";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Native processes and the shared real PostgreSQL fixture compete for CPU/IO.
// Bound file workers while retaining every assertion and the default timeouts.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)) },
  }),
);
