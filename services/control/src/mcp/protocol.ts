import type { Hono } from "hono";
import { z } from "zod";
import { ApiFailure } from "../api/errors";
import { mutate, type ApiEnv } from "../api/context";
import { CapabilityEngine } from "./engine";
const servers = ["files", "memory", "cards", "papers"] as const;
const rpc = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(200), z.number().int()]).optional(),
    method: z.string().max(100),
    params: z.record(z.unknown()).optional(),
  })
  .strict();
/** Stateless Streamable HTTP: JSON responses, no server-initiated messages or resumable sessions. */
export function registerMcp(app: Hono<ApiEnv>, engine: CapabilityEngine) {
  app.all("/mcp/:server", async (c) => {
    const server = c.req.param("server");
    if (!servers.some((s) => s === server))
      return c.json({ error: "NOT_FOUND" }, 404);
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin)
      return c.json({ error: "ORIGIN_DENIED" }, 403);
    if (c.req.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const accept = c.req.header("accept") ?? "";
    if (
      !accept.includes("application/json") ||
      !accept.includes("text/event-stream")
    )
      return c.json({ error: "ACCEPT_REQUIRED" }, 400);
    if (!(c.req.header("content-type") ?? "").startsWith("application/json"))
      return c.json({ error: "CONTENT_TYPE_REQUIRED" }, 400);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > 5 * 1024 * 1024)
      return c.json({ error: "PAYLOAD_TOO_LARGE" }, 413);
    const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    let id: string | number | null = null;
    try {
      const data = await c.req.text();
      if (Buffer.byteLength(data) > 5 * 1024 * 1024)
        throw new ApiFailure("PAYLOAD_TOO_LARGE", 413, "请求过大。");
      const message = rpc.parse(JSON.parse(data));
      id = message.id ?? null;
      if (message.method === "tools/call") {
        const params = z
          .object({
            name: z.string(),
            arguments: z
              .object({
                args: z.record(z.unknown()),
                requestId: z.string().optional(),
                approvalId: z.string().optional(),
              })
              .strict(),
          })
          .strict()
          .parse(message.params);
        const name = server + "." + params.name;
        const result = await engine.call(
          server as (typeof servers)[number],
          token,
          { capability: name, ...params.arguments },
        );
        return c.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          },
        });
      }
      const auth = await engine.authority.validate(token);
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (message.method === "initialize")
        return c.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "reinlab-" + server, version: "0.1.0" },
          },
        });
      if (message.method === "ping")
        return c.json({ jsonrpc: "2.0", id, result: {} });
      if (message.method === "tools/list")
        return c.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: auth.scope.grants
              .filter((g) => g.name.startsWith(server + "."))
              .map((g) => ({
                name: g.name.slice(server.length + 1),
                description: g.name,
                inputSchema: {
                  type: "object",
                  properties: {
                    args: auth.catalog.capabilities[g.name].input,
                    requestId: { type: "string" },
                    approvalId: { type: "string" },
                  },
                  required: ["args"],
                  additionalProperties: false,
                },
              })),
          },
        });
      return c.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "METHOD_NOT_FOUND" },
      });
    } catch (error) {
      const known = error instanceof ApiFailure;
      return c.json({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: known ? error.code : "INVALID_REQUEST",
          data: {
            ...(known && "approvalId" in error
              ? { approvalId: error.approvalId }
              : {}),
            status: known ? error.status : 400,
          },
        },
      });
    }
  });
  app.post("/v1/mcp/approvals/:id/decision", async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success)
      throw new ApiFailure("INVALID_INPUT", 400, "审批编号无效。");
    return mutate(
      c,
      engine.authority.db,
      z.object({ decision: z.enum(["approve", "reject"]) }).strict(),
      async (client, input) => ({
        status: 200,
        body: await engine.decideClient(
          client,
          c.get("accountId"),
          id.data,
          input.decision,
        ),
      }),
    );
  });
  app.post("/v1/runs/:id/capabilities/revoke", async (c) => {
    const run = z.string().uuid().safeParse(c.req.param("id"));
    if (!run.success)
      throw new ApiFailure("INVALID_INPUT", 400, "运行编号无效。");
    return mutate(
      c,
      engine.authority.db,
      z.object({}).strict(),
      async (client) => {
        await engine.authority.revokeClient(
          client,
          c.get("accountId"),
          run.data,
        );
        return { status: 200, body: { revoked: true } };
      },
    );
  });
}
