import { expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
const hooks = vi.hoisted(() => ({
  bodyStarted: undefined as undefined | (() => void),
  markerSynced: undefined as undefined | (() => void),
}));
vi.mock(
  "../../../tooling/local/one-shot-smoke-guard",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../tooling/local/one-shot-smoke-guard")
      >();
    return {
      ...actual,
      readSmokeBody: (...args: Parameters<typeof actual.readSmokeBody>) => {
        hooks.bodyStarted?.();
        return actual.readSmokeBody(...args);
      },
    };
  },
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith("/consumed"))
        return new Proxy(handle, {
          get(target, key) {
            if (key === "sync")
              return async () => {
                await target.sync();
                hooks.markerSynced?.();
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return handle;
    },
  };
});
import { startMcpSmokeGuard } from "../../../tooling/local/mcp-smoke-guard";
const token = "x".repeat(43),
  body = JSON.stringify({
    model: "deepseek-flash",
    thinking: { type: "disabled" },
    max_tokens: 1024,
    messages: [{ role: "user", content: "fixture" }],
  });
it.each(["already-expired", "while-reading-body", "after-marker-sync"])(
  "authorization expiry %s denies the actual upstream fetch",
  async (mode) => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-b8-expiry-")),
    );
    let now = mode === "already-expired" ? 3000 : 2000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now),
      transport = vi.fn(async () =>
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "fixture" },
            },
          ],
        }),
      );
    let guard: Awaited<ReturnType<typeof startMcpSmokeGuard>> | undefined;
    try {
      const options = {
        incomingToken: token,
        upstreamKey: "synthetic-not-real",
        markerPath: join(dir, "consumed"),
        authorizationEndsAt: 3000,
        testOnlyTransport: transport as typeof fetch,
      };
      if (mode === "already-expired") {
        await expect(startMcpSmokeGuard(options)).rejects.toThrow(
          "MCP_SMOKE_CONFIGURATION_INVALID",
        );
        expect(transport).not.toHaveBeenCalled();
        return;
      }
      guard = await startMcpSmokeGuard(options);
      if (mode === "after-marker-sync")
        hooks.markerSynced = () => {
          now = 3000;
        };
      let status: number;
      if (mode === "while-reading-body") {
        let started!: () => void;
        const pending = new Promise<void>((resolve) => {
          started = resolve;
        });
        hooks.bodyStarted = started;
        const req = request({
          host: "127.0.0.1",
          port: guard.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
        });
        const result = new Promise<number>((resolve, reject) => {
          req.on("response", (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode!));
          });
          req.on("error", reject);
        });
        req.write(body.slice(0, 10));
        await pending;
        now = 3000;
        req.end(body.slice(10));
        status = await result;
      } else {
        const response = await fetch(
          "http://127.0.0.1:" + guard.port + "/v1/chat/completions",
          {
            method: "POST",
            headers: { authorization: "Bearer " + token },
            body,
          },
        );
        status = response.status;
        await response.body?.cancel();
      }
      expect(status).toBeGreaterThanOrEqual(400);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      hooks.bodyStarted = undefined;
      hooks.markerSynced = undefined;
      clock.mockRestore();
      await guard?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
