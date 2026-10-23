import { availableParallelism } from "node:os";
import { defineConfig, mergeConfig, configDefaults } from "vitest/config";
import viteConfig from "./vite.config";

// Native processes and the shared real PostgreSQL fixture compete for CPU/IO.
// Bound file workers while retaining every assertion and the default timeouts.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { exclude:[...configDefaults.exclude,"**/dist/**"], maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)) },
  }),
);
