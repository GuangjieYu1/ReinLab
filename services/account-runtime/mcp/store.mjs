import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  lstat,
  realpath,
  rm,
  readdir,
  rename,
} from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const uuid = (v) => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
const fail = () => {
  throw Error("MCP_ACCOUNT_DENIED");
};
export async function bootstrapMcp(root, body, controlUrl) {
  if (
    !uuid(body.runId) ||
    typeof body.token !== "string" ||
    body.token.length > 4096 ||
    body.controlUrl !== controlUrl
  )
    fail();
  const parts = body.token.split(".");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  } catch {
    fail();
  }
  if (
    claims.run !== body.runId ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= Date.now() / 1000
  )
    fail();
  const dir = root + "/mcp-clients";
  await mkdir(dir, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  const st = await lstat(dir);
  if (!st.isDirectory() || st.mode & 0o077 || (await realpath(dir)) !== dir)
    fail();
  const file = dir + "/" + body.runId + ".json";
  const temp = file + "." + randomUUID() + ".pending";
  const h = await open(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await h.writeFile(
      JSON.stringify({ controlUrl, token: body.token, expiresAt: claims.exp }),
    );
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(temp, file);
  return { installed: true };
}
export async function accountFiles(root, body) {
  if (
    Object.keys(body).some(
      (k) => !["dossier", "operation", "args", "writeTargets"].includes(k),
    ) ||
    !body.args ||
    typeof body.args !== "object" ||
    !uuid(body.dossier) ||
    !["list", "read", "write", "patch", "undo", "importPaper"].includes(
      body.operation,
    ) ||
    !Array.isArray(body.writeTargets) ||
    body.writeTargets.some((t) => typeof t !== "string")
  )
    fail();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [fileURLToPath(new URL("./files.py", import.meta.url))],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("MCP_FILES_UNAVAILABLE"));
    }, 30000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("MCP_FILES_UNAVAILABLE"));
    });
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) child.kill();
      else chunks.push(c);
    });
    child.stdin.on("error", () => {});
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(Buffer.concat(chunks));
        if (!value.result || value.error) fail();
        resolve(value.result);
      } catch {
        reject(Error("MCP_FILES_DENIED"));
      }
    });
    child.stdin.end(JSON.stringify({ root, ...body }));
  });
}
/** Expired configs cannot be refreshed by models; credentials remain outside project and backups. */
export async function cleanupMcp(root) {
  let files;
  try {
    files = await readdir(root + "/mcp-clients");
  } catch {
    return;
  }
  for (const name of files) {
    if (!/^[a-f0-9-]{36}\.json(?:\.[a-f0-9-]{36}\.pending)?$/.test(name))
      continue;
    const file = root + "/mcp-clients/" + name;
    let h;
    try {
      h = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const s = await h.stat();
      if (!s.isFile() || s.nlink !== 1 || s.size > 32768) continue;
      let value;
      try {
        value = JSON.parse(await h.readFile("utf8"));
      } catch {
        if (name.endsWith(".pending") && Date.now() - s.mtimeMs > 7200000)
          await rm(file);
        continue;
      }
      if (
        typeof value.expiresAt === "number" &&
        value.expiresAt <= Date.now() / 1000
      )
        await rm(file);
    } catch {
    } finally {
      await h?.close();
    }
  }
}

export async function removeMcp(root, runId) {
  if (!uuid(runId)) fail();
  await rm(root + "/mcp-clients/" + runId + ".json", { force: true });
  let names = [];
  try {
    names = await readdir(root + "/mcp-clients");
  } catch {}
  for (const name of names)
    if (
      name.startsWith(runId + ".json.") &&
      /\.[a-f0-9-]{36}\.pending$/.test(name)
    )
      await rm(root + "/mcp-clients/" + name, { force: true });
  return { removed: true };
}
