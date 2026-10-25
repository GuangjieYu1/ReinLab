import { mcpTools } from "./mcp-tools.js";
import { clarificationHooks, humanQuestion } from "./clarify-model.js";
import path from "node:path";
import { constants } from "node:fs";
import { open, realpath, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const denied = () => {
  throw new Error("SCOPE_DENIED");
};
const sha = (data) => createHash("sha256").update(data).digest("hex");
const inside = (parent, file) => file.startsWith(parent + path.sep);
async function regular(file) {
  const h = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1 || s.size > 262144) denied();
    return await h.readFile();
  } finally {
    await h.close();
  }
}
async function singleLink(file) {
  let h;
  try {
    h = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const s = await h.stat();
    if ((!s.isFile() && !s.isDirectory()) || (s.isFile() && s.nlink !== 1))
      denied();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  } finally {
    await h?.close();
  }
}
async function destination(file) {
  const tail = [];
  let current = path.resolve(file);
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail.reverse());
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      tail.push(path.basename(current));
      const next = path.dirname(current);
      if (next === current) denied();
      current = next;
    }
  }
}
/** P1-10 only: enforce the generated role's exact native-tool boundary.
 * Structured cards, control-plane callbacks and approvals remain P1-11 work. */
export const ReinLabPlugin = async ({ directory }) => {
  const file = path.join(directory, ".role-policy.json");
  let initial;
  try {
    initial = await regular(file);
  } catch (e) {
    if (e.code === "ENOENT") return {};
    denied();
  }
  const policy = JSON.parse(initial.toString("utf8"));
  if (
    policy.schemaVersion !== 1 ||
    policy.directory !== (await realpath(directory)) ||
    !policy.dossierDirectory ||
    !policy.tools ||
    !Array.isArray(policy.writeTargets)
  )
    denied();
  const verify = async () => {
    try {
      if (
        (await readdir(directory)).some(
          (name) =>
            !["openscience.json", "AGENTS.md", ".role-policy.json"].includes(
              name
            )
        )
      )
        denied();
      if (
        sha(await regular(file)) !== sha(initial) ||
        sha(await regular(path.join(directory, "openscience.json"))) !==
          policy.configSha256 ||
        sha(await regular(path.join(directory, "AGENTS.md"))) !==
          policy.memorySha256
      )
        denied();
      if ((await realpath(policy.dossierDirectory)) !== policy.dossierDirectory)
        denied();
    } catch {
      denied();
    }
  };
  await verify();
  return {
    ...clarificationHooks(policy, verify),
    tool: mcpTools(policy, verify),
    "experimental.chat.system.transform": async () => {
      await verify();
    },
    "tool.execute.before": async ({ tool }, { args }) => {
      await verify();
      if (!Object.hasOwn(policy.tools, tool)) denied();
      const grant = policy.tools[tool];
      if (
        tool === "task" ||
        !grant ||
        grant.permission === "deny" ||
        grant.risk === "danger"
      )
        denied();
      if (tool === "read") {
        const target = await realpath(path.resolve(directory, args.filePath));
        if (
          target !== path.join(directory, "AGENTS.md") &&
          !inside(policy.dossierDirectory, target)
        )
          denied();
        await singleLink(target);
      }
      if (tool === "question") await humanQuestion(policy, verify, args);
      if (["write", "edit", "patch", "apply_patch", "multiedit"].includes(tool))
        denied();
    },
  };
};
