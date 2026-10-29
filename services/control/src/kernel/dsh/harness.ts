import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { HarnessFactory, HarnessLike } from "./session";

const require = createRequire(import.meta.url);

/** Absolute path of the pinned dsh executable module the shim launches. */
export function resolveDshModule(): string {
  const manifestUrl = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = require("@deepseek-ai/dsh/package.json") as {
    bin?: string | Record<string, string>;
  };
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
  if (!bin) throw new Error("DSH_MODULE_UNAVAILABLE");
  return resolve(dirname(manifestUrl), bin);
}

/** Path of the run-scoped shim module the SDK client spawns as `dshBin`. */
export const SHIM_MODULE = resolve(dirname(new URL(import.meta.url).pathname), "shim.mjs");

/** The real SDK client, narrowed to the driver's interface. */
export function createHarnessFactory(): HarnessFactory {
  return (options) => new DeepSeekHarness(options as never) as unknown as HarnessLike;
}
