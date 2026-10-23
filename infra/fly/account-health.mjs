import { request } from "node:http";
import { readAccountCredentials } from "../../services/account-runtime/credentials.mjs";
let auth;
try {
  ({ auth } = readAccountCredentials("/run/reinlab-private/account.json", {
    accountId: process.env.REINLAB_ACCOUNT_ID,
    owner: 1000,
    parentOwner: 1000,
  }));
} catch {
  process.exit(1);
}
const local = process.env.REINLAB_ACCOUNT_DRIVER === "docker";
const r = request(
  {
    host: local ? "127.0.0.1" : "::1",
    port: local ? 4097 : 4096,
    path: "/global/health",
    headers: { authorization: "Bearer " + auth },
  },
  (res) => {
    res.resume();
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  },
);
r.setTimeout(4000, () => {
  r.destroy();
  process.exitCode = 1;
});
r.on("error", () => {
  process.exitCode = 1;
});
r.end();
