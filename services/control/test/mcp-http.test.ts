import { it, expect } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityEngine } from "../src/mcp/engine";
import { dataHandlers } from "../src/mcp/data-handlers";
import { registerMcp } from "../src/mcp/protocol";
import { implementedCatalog, mcpFixture } from "./mcp-fixture";
it("T-MCP-2 an external MCP HTTP client with no plugin cannot invoke ungranted capabilities", async () => {
  const f = await mcpFixture(await implementedCatalog());
  try {
    const a = new CapabilityAuthority(
        f.db,
        new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
      ),
      token = await a.issue(f.account, f.run),
      app = new Hono();
    registerMcp(app as any, new CapabilityEngine(a, dataHandlers(f.db)));
    const send = async (
      method: string,
      params: unknown,
      auth = token,
      origin?: string,
    ) =>
      app.request("http://localhost/mcp/memory", {
        method: "POST",
        headers: {
          authorization: "Bearer " + auth,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    expect(
      (await (await send("initialize", {})).json()).result.serverInfo.name,
    ).toBe("reinlab-memory");
    const read = await (
      await send("tools/call", { name: "read", arguments: { args: {} } })
    ).json();
    expect(read).toMatchObject({
      result: { structuredContent: { items: [] } },
    });
    const denied = await (
      await send("tools/call", {
        name: "write",
        arguments: { args: {}, requestId: randomUUID() },
      })
    ).json();
    expect(denied.error.message).toBe("CAPABILITY_DENIED");
    expect(
      (
        await (
          await send(
            "tools/call",
            { name: "read", arguments: { args: {} } },
            "invalid",
          )
        ).json()
      ).error.message,
    ).toBe("CAPABILITY_TOKEN_INVALID");
    expect(
      (await send("tools/list", {}, token, "https://evil.example")).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
});
