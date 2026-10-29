import { createServer } from "vite";
import process from "node:process";
if (
  process.env.DEEPSEEK_API_KEY ||
  process.env.CI ||
  process.env.NODE_ENV === "test"
)
  throw Error("LOCAL_REAL_MODELS_FORBIDDEN");
process.env.VITE_BACKEND = "live";
const server = await createServer({
  server: { host: "127.0.0.1", port: 5183, strictPort: true },
});
await server.listen();
const marker = process.argv.indexOf("--instance"),
  instance = process.argv[marker + 1];
console.log(
  JSON.stringify({
    code: "LOCAL_LIVE_FRONTEND_READY",
    origin: "http://127.0.0.1:5183",
  }),
);
if (
  process.connected &&
  process.send &&
  marker >= 0 &&
  /^[a-f0-9-]{36}$/.test(instance)
)
  process.send({
    type: "reinlab.control.ready",
    instance,
    pid: process.pid,
    port: 5183,
  });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
