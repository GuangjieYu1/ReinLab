import { it, expect } from "vitest";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { installAccountNetworkGuard } from "../../account-runtime/network-guard.mjs";
it("network guard is installed before bind; forged internal headers cannot bypass it; additional listeners fail closed", async () => {
  const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "reinlab-network-guard-")),
    ),
    accountId = randomUUID(),
    auth = randomBytes(32).toString("base64url");
  const file = path.join(root, "account.json");
  try {
    await writeFile(
      file,
      JSON.stringify({
        schema: "account_credentials@1",
        accountId,
        auth,
        container: randomBytes(32).toString("base64url"),
      }),
      { mode: 0o600 },
    );
    let captured: any,
      dispatches = 0;
    const bun = {
      serve(options: any) {
        captured = options;
        return { url: new URL("http://127.0.0.1:4096") };
      },
    };
    const original = (_req: Request) => {
      dispatches++;
      return new Response("upstream");
    };
    installAccountNetworkGuard(bun, { file, accountId, environment: {} });
    bun.serve({ hostname: "127.0.0.1", port: 4096, fetch: original });
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { "x-openscience-internal": "forged" },
    ]) {
      const result = await captured.fetch(
        new Request("http://127.0.0.1:4096/global/health", { headers }),
      );
      expect(result.status).toBe(401);
    }
    expect(dispatches).toBe(0);
    expect(
      (
        await captured.fetch(
          new Request("http://127.0.0.1:4096/global/health", {
            headers: { authorization: "Bearer " + auth },
          }),
        )
      ).status,
    ).toBe(200);
    expect(dispatches).toBe(1);
    expect(() =>
      bun.serve({ hostname: "127.0.0.1", port: 4096, fetch: original }),
    ).toThrow("ACCOUNT_LISTENER_UNEXPECTED");
    const unexpected = {
      serve() {
        throw Error("must not bind");
      },
    };
    installAccountNetworkGuard(unexpected, {
      file,
      accountId,
      environment: {},
    });
    expect(() =>
      unexpected.serve({
        hostname: "0.0.0.0",
        port: 4096,
        fetch: original,
      } as never),
    ).toThrow("ACCOUNT_LISTENER_UNEXPECTED");
    const routeBypass = {
      serve(_options: any) {
        throw Error("unsafe bind occurred");
      },
    };
    installAccountNetworkGuard(routeBypass, {
      file,
      accountId,
      environment: {},
    });
    expect(() =>
      routeBypass.serve({
        hostname: "127.0.0.1",
        port: 4096,
        fetch: original,
        routes: { "/public": new Response("unsafe") },
      }),
    ).toThrow("ACCOUNT_LISTENER_UNEXPECTED");
    expect(() =>
      installAccountNetworkGuard(
        { serve() {} },
        {
          file,
          accountId,
          environment: { DATABASE_URL_APP: "synthetic forbidden ENV" },
        },
      ),
    ).toThrow("ACCOUNT_SECRET_ENV_FORBIDDEN");
    expect(() =>
      installAccountNetworkGuard(
        { serve() {} },
        {
          file,
          accountId,
          environment: { OPENSCIENCE_AUTH_TOKEN: "synthetic forbidden ENV" },
        },
      ),
    ).toThrow("ACCOUNT_SECRET_ENV_FORBIDDEN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
