import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { getuid } from "node:process";
import { parseEnv } from "node:util";

export type RuntimeConfiguration = Readonly<Record<string, string | undefined>>;
const unsafe = () => Error("RUNTIME_CONFIG_UNSAFE");

/** Protected service input; never assigns credentials to process.env or echoes parser errors. */
export function readRuntimeConfiguration(
  file: string
): Readonly<Record<string, string>> {
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    if (!isAbsolute(file) || realpathSync(file) !== file) throw unsafe();
    const parent = lstatSync(dirname(file));
    if (
      !parent.isDirectory() ||
      parent.uid !== getuid?.() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw unsafe();
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 128 * 1024
    )
      throw unsafe();
    bytes = readFileSync(fd);
    if (bytes.length > 128 * 1024 || bytes.includes(0)) throw unsafe();
    const values = parseEnv(bytes.toString("utf8"));
    if (Object.keys(values).some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key)))
      throw unsafe();
    return Object.freeze(
      Object.fromEntries(
        Object.entries(values).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    );
  } catch {
    throw unsafe();
  } finally {
    if (fd !== undefined) closeSync(fd);
    bytes?.fill(0);
  }
}

const publicNames = new Set([
  "REINLAB_CLARIFY_AUTHORIZATION_FILE",
  "PORT",
  "SUPABASE_URL",
  "STORAGE_BUCKET",
  "PROVISIONER_DRIVER",
  "DOCKER_HOST",
  "ACCOUNT_IMAGE",
  "FLY_APP_ACCOUNTS",
  "REINLAB_CONTROL_URL",
  "REINLAB_MCP_SIGNING_KEY_FILE",
  "REINLAB_KERNEL_SIGNING_KEY_FILE",
  "REINLAB_KERNEL_HOME",
  "REINLAB_KERNEL_TRANSPORT",
  "REINLAB_KERNEL_MODEL",
  "REINLAB_KERNEL_MAX_TOKENS",
  "REINLAB_DOCKER_CREDENTIAL_DIR",
  "MODEL_ROUTE_CHEAP",
  "MODEL_ROUTE_MID",
  "MODEL_ROUTE_STRONG",
  "MODEL_USD_CNY_RATE",
  "MODEL_INPUT_CNY_PER_MILLION",
  "MODEL_OUTPUT_CNY_PER_MILLION",
  "DEEPSEEK_BILLING_CURRENCY",
  "DEEPSEEK_PRICE_WINDOW",
  "DEEPSEEK_PRICE_VALID_FROM",
  "DEEPSEEK_PRICE_VALID_UNTIL",
]);

/** Environment carries only public configuration and the protected configuration file path. */
export function runtimeConfiguration(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfiguration {
  if (env.REINLAB_RUNTIME_CONFIG_FILE)
    return readRuntimeConfiguration(env.REINLAB_RUNTIME_CONFIG_FILE);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) => publicNames.has(key) && value !== undefined
      )
    )
  );
}
