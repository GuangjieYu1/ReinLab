/**
 * `local:up22` 的命令行开关（`pnpm local:up22 [--real-models] [--lan]`）。
 *
 * 只认这几个：未知参数直接报错，别让人以为传了开关就生效了。
 */
import { parseArgs } from "node:util";

export type LocalArgs = {
  realModels: boolean;
  /** 手机/iPad 用的可信局域网 HTTPS 入口（固定主机名 + 本机 CA + 同源反代构建前端）。 */
  lan: boolean;
  /** 固定主机名（默认 reinlab.local，用 mDNS 广播到局域网）。 */
  lanHost?: string;
  /** 固定端口（默认 8443）；换了端口 origin 就变了，离线缓存要重做准备。 */
  lanPort?: number;
};

export function localArgs(args: string[], env: NodeJS.ProcessEnv): LocalArgs {
  const values = parseArgs({
    args,
    options: {
      "real-models": { type: "boolean" },
      lan: { type: "boolean" },
      "lan-host": { type: "string" },
      "lan-port": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  }).values;
  const realModels = values["real-models"] === true;
  if (realModels && (env.CI || env.NODE_ENV === "test" || env.DEEPSEEK_API_KEY))
    throw Error("LOCAL_REAL_MODELS_FORBIDDEN");
  const host = values["lan-host"];
  if (host !== undefined && !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host))
    throw Error("LOCAL_LAN_HOST_INVALID");
  let port: number | undefined;
  if (values["lan-port"] !== undefined) {
    port = Number(values["lan-port"]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("LOCAL_LAN_PORT_INVALID");
  }
  if ((host || port !== undefined) && values.lan !== true) throw Error("LOCAL_LAN_FLAG_REQUIRED");
  return {
    realModels,
    lan: values.lan === true,
    ...(host ? { lanHost: host } : {}),
    ...(port !== undefined ? { lanPort: port } : {}),
  };
}
