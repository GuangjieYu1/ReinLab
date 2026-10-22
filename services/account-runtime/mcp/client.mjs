import path from "node:path";
import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
const file = process.argv[2],
  server = process.argv[3];
if (
  !["files", "memory", "cards", "papers"].includes(server) ||
  !path.isAbsolute(file ?? "") ||
  path.basename(path.dirname(file)) !== "mcp-clients" ||
  !/^[a-f0-9-]{36}\.json$/.test(path.basename(file))
)
  throw Error("MCP_CONFIG_DENIED");
const parent = await lstat(path.dirname(file));
if (
  !parent.isDirectory() ||
  parent.mode & 0o077 ||
  (await realpath(file)) !== file
)
  throw Error("MCP_CONFIG_DENIED");
const handle = await open(
  file,
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
);
let config;
try {
  const s = await handle.stat();
  if (!s.isFile() || s.nlink !== 1 || s.mode & 0o077 || s.size > 32768)
    throw Error("MCP_CONFIG_DENIED");
  config = JSON.parse(await handle.readFile("utf8"));
} finally {
  await handle.close();
}
const url = new URL(config.controlUrl);
if (
  !["https:", "http:"].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash ||
  typeof config.token !== "string"
)
  throw Error("MCP_CONFIG_DENIED");
// Capability credential stays in this process. No argv/env/role-project copy.
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let id = null;
  try {
    if (Buffer.byteLength(line) > 5 * 1024 * 1024) throw Error();
    const message = JSON.parse(line);
    id = message.id ?? null;
    const response = await fetch(url.origin + "/mcp/" + server, {
      method: "POST",
      headers: {
        authorization: "Bearer " + config.token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: line,
      redirect: "error",
      signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) throw Error();
    if (response.status !== 202) {
      const text = await response.text();
      if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw Error();
      process.stdout.write(text + "\n");
    }
  } catch {
    if (id !== null)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "MCP_UNAVAILABLE" },
        }) + "\n",
      );
  }
}
