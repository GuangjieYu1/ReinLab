import { tool } from "@synsci/plugin";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
const fail = () => {
  throw new Error("MCP_SCOPE_DENIED");
};
const canonical = (value) =>
  Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
          .join(",") +
        "}"
      : JSON.stringify(value);
async function configuration(runId, root) {
  if (!/^[a-f0-9-]{36}$/.test(runId ?? "")) fail();
  const file = path.join(root, "mcp-clients", runId + ".json"),
    parent = await lstat(path.dirname(file));
  if (
    !parent.isDirectory() ||
    parent.mode & 0o077 ||
    (await realpath(file)) !== file
  )
    fail();
  const h = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1 || s.mode & 0o077 || s.size > 32768)
      fail();
    return JSON.parse(await h.readFile("utf8"));
  } finally {
    await h.close();
  }
}
/** Business aliases preserve the manifest vocabulary; every operation still crosses the MCP server boundary. */
export function mcpTools(policy, verify) {
  if (!policy.mcp) return {};
  return Object.fromEntries(
    Object.entries(policy.mcp.aliases).map(([alias, allowed]) => [
      alias,
      tool({
        description:
          "ReinLab MCP：" +
          allowed.join("、") +
          "。args遵守对应能力参数，所有写入经服务器批准。",
        args: {
          capability: tool.schema.enum(allowed),
          args: tool.schema.record(tool.schema.string(), tool.schema.unknown()),
          requestId: tool.schema.string().max(200).optional(),
        },
        async execute(input, context) {
          await verify();
          if (!allowed.includes(input.capability)) fail();
          const config = await configuration(
              policy.mcp.runId,
              path.resolve(policy.dossierDirectory, "../.."),
            ),
            base = new URL(config.controlUrl);
          if (
            !["http:", "https:"].includes(base.protocol) ||
            base.username ||
            base.password ||
            base.pathname !== "/" ||
            base.search ||
            base.hash
          )
            fail();
          const requestId = input.requestId ?? context.callID ?? randomUUID(),
            server = input.capability.split(".")[0];
          const invoke = async (approvalId) => {
            const response = await fetch(base.origin + "/mcp/" + server, {
              method: "POST",
              headers: {
                authorization: "Bearer " + config.token,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: requestId,
                method: "tools/call",
                params: {
                  name: input.capability.slice(server.length + 1),
                  arguments: {
                    args: input.args,
                    requestId,
                    ...(approvalId ? { approvalId } : {}),
                  },
                },
              }),
              redirect: "error",
              signal: AbortSignal.timeout(35000),
            });
            if (!response.ok) fail();
            const text = await response.text();
            if (Buffer.byteLength(text) > 5 * 1024 * 1024) fail();
            return JSON.parse(text);
          };
          let result = await invoke();
          if (result.error?.message === "APPROVAL_REQUIRED") {
            const approvalId = result.error.data?.approvalId;
            if (!/^[a-f0-9-]{36}$/.test(approvalId ?? "")) fail();
            const argsHash = createHash("sha256")
              .update(
                canonical({ capability: input.capability, args: input.args }),
              )
              .digest("hex");
            await context.ask({
              permission: "reinlab_mcp_approval",
              patterns: [approvalId],
              always: [],
              metadata: {
                reinlabMcp: {
                  approvalId,
                  capability: input.capability,
                  requestId,
                  argsHash,
                },
              },
            });
            result = await invoke(approvalId);
          }
          if (result.error)
            throw new Error(
              typeof result.error.message === "string"
                ? result.error.message
                : "MCP_FAILED",
            );
          return {
            output: JSON.stringify(result.result.structuredContent),
            metadata: { mcp: true, capability: input.capability, requestId },
          };
        },
      }),
    ]),
  );
}
