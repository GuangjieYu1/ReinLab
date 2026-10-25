import { availableParallelism } from "node:os";
import { defineConfig, mergeConfig, configDefaults } from "vitest/config";
import viteConfig from "./vite.config";

// Native processes and the shared real PostgreSQL fixture compete for CPU/IO.
// Keep two file workers: native kernels, fsync/Python file versions and shared PostgreSQL
// compete for fixture capacity. Retain parallel execution, every assertion and default timeouts.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: { globalSetup:["./tooling/native-preflight.mjs"], exclude:[...configDefaults.exclude,"**/dist/**","**/.artifacts/**"], maxWorkers: Math.max(1, Math.min(2, availableParallelism() - 1)) },
  }),
);
