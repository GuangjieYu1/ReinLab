import { localPaths } from "./paths";

// Only a protected file path crosses the process boundary; values stay in memory.
process.env.REINLAB_RUNTIME_CONFIG_FILE = localPaths().runtime;
await import("../../services/control/src/main");
