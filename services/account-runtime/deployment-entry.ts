import { installAccountNetworkGuard } from "./network-guard.mjs";
// This is a deployment transport adapter. Upstream CLI and trusted plugin SDK stay intact.
if (process.argv.length !== 3 || process.argv[2] !== "--version") {
  const at = process.argv.indexOf("--port"),
    port = Number(process.argv[at + 1]);
  if (
    process.argv[2] !== "serve" ||
    at < 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error("ACCOUNT_COMMAND_INVALID");
  installAccountNetworkGuard(Bun, {
    file: process.env.REINLAB_ACCOUNT_CREDENTIAL_FILE,
    accountId: process.env.REINLAB_ACCOUNT_ID,
    port,
  });
}
await import("./upstream/backend/cli/src/bootstrap.ts");
