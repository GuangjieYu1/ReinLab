import { getuid } from "node:process";
import { it, expect } from "vitest";
import { mkdtemp, realpath, writeFile, chmod, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAccountCredentials } from "../../account-runtime/credentials.mjs";
import { installAccountNetworkGuard } from "../../account-runtime/network-guard.mjs";

it("independent account credential types and permission checks reject without disclosure", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-account-review-")),
  );
  const accountId = randomUUID(),
    auth = randomBytes(32).toString("base64url");
  const bundle = {
    schema: "account_credentials@1",
    accountId,
    auth,
    container: randomBytes(32).toString("base64url"),
  };
  const file = join(root, "account.json");
  const denied = () => {
    let error: unknown;
    try {
      readAccountCredentials(file, { accountId });
    } catch (caught) {
      error = caught;
    }
    expect(
      error instanceof Error && error.message === "ACCOUNT_CREDENTIALS_INVALID",
    ).toBe(true);
  };
  try {
    for (const value of [
      [],
      [bundle],
      null,
      { ...bundle, auth: [auth] },
      { ...bundle, container: [bundle.container] },
      { ...bundle, accountId: [accountId] },
      { ...bundle, schema: [bundle.schema] },
    ]) {
      await writeFile(file, JSON.stringify(value), { mode: 0o600 });
      denied();
    }
    await writeFile(file, JSON.stringify(bundle));
    await chmod(root, 0o755);
    denied();
    await chmod(root, 0o700);
    let wrongOwner = false;
    try {
      readAccountCredentials(file, {
        accountId,
        owner: (getuid?.() ?? 0) + 1,
      });
    } catch (error) {
      wrongOwner =
        error instanceof Error &&
        error.message === "ACCOUNT_CREDENTIALS_INVALID";
    }
    expect(wrongOwner).toBe(true);
    expect(
      Object.values(process.env).some((value) => value?.includes(auth)),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("independent reload guard retains auth and preserves original Request, Host and Origin", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-account-review-")),
  );
  const accountId = randomUUID(),
    auth = randomBytes(32).toString("base64url"),
    file = join(root, "account.json");
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
      seen: Request | undefined,
      binds = 0;
    const server = {
      reload(next: any) {
        captured = { ...captured, ...next };
      },
    };
    const bun = {
      serve(options: any) {
        captured = options;
        binds++;
        return server;
      },
    };
    installAccountNetworkGuard(bun, { file, accountId, environment: {} });
    let getterCalled = false;
    for (const options of [
      {
        hostname: "127.0.0.1",
        port: 4096,
        fetch: () => new Response(),
        routes: {},
      },
      {
        hostname: "127.0.0.1",
        port: 4096,
        fetch: () => new Response(),
        static: {},
      },
      Object.create({
        hostname: "127.0.0.1",
        port: 4096,
        fetch: () => new Response(),
      }),
      {
        hostname: "127.0.0.1",
        port: 4096,
        get fetch() {
          getterCalled = true;
          return () => new Response();
        },
      },
    ])
      expect(() => bun.serve(options)).toThrow("ACCOUNT_LISTENER_UNEXPECTED");
    expect(getterCalled).toBe(false);
    expect(binds).toBe(0);
    bun.serve({
      hostname: "127.0.0.1",
      port: 4096,
      fetch: () => new Response("initial"),
    });
    for (const next of [
      { routes: {} },
      { static: {} },
      { fetch: undefined },
      { fetch: null },
      Object.create({ fetch: () => new Response() }),
    ])
      expect(() => server.reload(next)).toThrow("ACCOUNT_LISTENER_UNEXPECTED");
    server.reload({
      fetch: (request: Request) => {
        seen = request;
        return new Response("replacement");
      },
    });
    expect(
      (await captured.fetch(new Request("http://127.0.0.1:4096/"))).status,
    ).toBe(401);
    const request = new Request("http://127.0.0.1:4096/", {
      headers: {
        authorization: "Bearer " + auth,
        host: "synthetic.invalid",
        origin: "https://synthetic.invalid",
      },
    });
    expect((await captured.fetch(request)).status).toBe(200);
    expect(
      seen === request &&
        seen?.headers.get("host") === "synthetic.invalid" &&
        seen?.headers.get("origin") === "https://synthetic.invalid",
    ).toBe(true);
    server.reload({});
    expect(
      (await captured.fetch(new Request("http://127.0.0.1:4096/"))).status,
    ).toBe(401);
    expect(binds).toBe(1);
    for (const key of [
      "DATABASE_URL",
      "DATABASE_URL_APP",
      "DATABASE_URL_PROVISIONER",
    ])
      expect(() =>
        installAccountNetworkGuard(
          { serve() {} },
          { file, accountId, environment: { [key]: "synthetic value" } },
        ),
      ).toThrow("ACCOUNT_SECRET_ENV_FORBIDDEN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
