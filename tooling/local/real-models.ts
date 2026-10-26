import { parseArgs } from "node:util";
export function realModelMode(args: string[], env: NodeJS.ProcessEnv) {
  const values = parseArgs({
    args,
    options: { "real-models": { type: "boolean" } },
    allowPositionals: false,
    strict: true,
  }).values;
  const enabled = values["real-models"] === true;
  if (enabled && (env.CI || env.NODE_ENV === "test" || env.DEEPSEEK_API_KEY))
    throw Error("LOCAL_REAL_MODELS_FORBIDDEN");
  return enabled;
}
