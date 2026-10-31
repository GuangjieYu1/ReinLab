/**
 * 局域网 HTTPS 入口（`pnpm local:up22 --lan` 启动的独立进程）。
 *
 * 由 `tooling/local/up.ts` 起停，记录写在状态目录的 lan-server.json 里，
 * 和 control 一样可被下一次启动按记录收掉。
 */
import process from "node:process";
import { startLanServer, advertise } from "./lan";

const host = process.env.REINLAB_LAN_HOST;
const port = Number(process.env.REINLAB_LAN_PORT);
const address = process.env.REINLAB_LAN_ADDRESS;
const cert = process.env.REINLAB_LAN_CERT;
const key = process.env.REINLAB_LAN_KEY;
const dist = process.env.REINLAB_LAN_DIST;
const ca = process.env.REINLAB_LAN_CA;
const controlPort = Number(process.env.REINLAB_CONTROL_PORT ?? 3001);
if (!host || !address || !cert || !key || !dist || !ca || !Number.isInteger(port))
  throw Error("LOCAL_LAN_CONFIG_REQUIRED");

const server = await startLanServer({ host, port, controlPort, dist, cert, key });
const bonjour = advertise(host, port, address);
const marker = process.argv.indexOf("--instance");
const instance = marker < 0 ? undefined : process.argv[marker + 1];
console.log(
  JSON.stringify({
    code: "LOCAL_LAN_READY",
    origin: `https://${host}:${port}`,
    fallback: `https://${address}:${port}`,
    ca,
  }),
);
if (process.connected && process.send && instance && /^[a-f0-9-]{36}$/.test(instance))
  process.send({ type: "reinlab.control.ready", instance, pid: process.pid, port }, () => {});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    bonjour?.kill();
    server.close(() => process.exit(0));
  });
