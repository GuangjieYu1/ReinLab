import { join } from "node:path";
import { localPaths } from "./paths";
// Only a protected configuration path enters the process environment.
if (process.env.DEEPSEEK_API_KEY || process.env.HATCHET_CLIENT_TOKEN)
  throw Error("WORKER_CREDENTIAL_ENV_FORBIDDEN");
process.env.REINLAB_WORKER_CONFIG_FILE = join(
  localPaths().state,
  "hatchet/worker.env"
);
await import("../../services/worker/src/main");
