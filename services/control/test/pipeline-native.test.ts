import { fileHandlers } from "../src/mcp/files";
import { serve } from "@hono/node-server";
import { generateKeyPairSync } from "node:crypto";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityEngine } from "../src/mcp/engine";
import { dataHandlers } from "../src/mcp/data-handlers";
import { bootstrapMcp, removeMcp } from "../../account-runtime/mcp/store.mjs";
import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { createApp } from "../src/api/app";
import { PricingService } from "../src/budget/pricing";
import { loadToolRegistry, loadBenchBundle } from "../src/harness/manifest";
import { publishBench, HarnessStore } from "../src/harness/store";
import { RuntimePipeline } from "../src/bridge/openscience/pipeline";
import { DEEPSEEK_PRICING_VERSION } from "../src/bridge/openscience/deepseek-pricing";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import {
  startNativeRoleServer,
  startRoleProvider,
} from "./fixtures/role-provider";
import { testEvidenceDirectory } from "./fixtures/test-evidence";
const admin = new pg.Pool({
    connectionString: "postgres://postgres@127.0.0.1:55432/reinlab_test",
    max: 2,
  }),
  pool = new pg.Pool({
    connectionString: "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
    max: 5,
  }),
  db = new Database(pool);
beforeAll(() => applyMigrations(admin, resolve("infra/supabase/migrations")));
afterAll(async () => {
  await pool.end();
  await admin.end();
});
/** Real API/auth/native protocol, test-only loopback provider; no real model credentials or claims. */
it("ES256 authenticated confirmation binds Harness and model, native usage reaches ledger as unknown exactly once", async () => {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-pipeline-native-")),
    ),
    account = randomUUID(),
    registry = await loadToolRegistry(),
    bundle = await loadBenchBundle({ benchId: "research", registry });
  let provider: Awaited<ReturnType<typeof startRoleProvider>> | undefined,
    native: Awaited<ReturnType<typeof startNativeRoleServer>> | undefined,
    local: Server | undefined,
    pipeline: RuntimePipeline | undefined,
    mcpServer: ReturnType<typeof serve> | undefined,
    mcpUrl = "";
  try {
    await publishBench(admin, bundle, registry);
    await admin.query("insert into account(id) values($1)", [account]);
    const { publicKey, privateKey } = await generateKeyPair("ES256", {
        extractable: true,
      }),
      jwk = {
        ...(await exportJWK(publicKey)),
        kid: "pipeline-fixture",
        alg: "ES256",
        use: "sig",
      };
    local = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/auth/v1/.well-known/jwks.json")
        res.end(JSON.stringify({ keys: [jwk] }));
      else if (req.url === "/catalog")
        res.end(
          JSON.stringify({
            "role-fixture": {
              models: {
                fixture: {
                  cost: { input: 1.5, output: 3 },
                  limit: { context: 200000, output: 16000 },
                },
              },
            },
          }),
        );
      else res.writeHead(404).end("{}");
    });
    await new Promise<void>((done) => local!.listen(0, "127.0.0.1", done));
    const address = local.address();
    if (!address || typeof address === "string")
      throw Error("FIXTURE_LISTEN_FAILED");
    const baseUrl = "http://127.0.0.1:" + address.port,
      issuer = baseUrl + "/auth/v1";
    const jwt = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "pipeline-fixture" })
      .setSubject(account)
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    provider = await startRoleProvider();
    provider.plans.set("PIPELINE_NATIVE_CONFIRMED_2214", [
      {
        name: "memory_read",
        arguments: { capability: "memory.read", args: {} },
      },
      {
        name: "finding_record",
        arguments: {
          capability: "files.write",
          args: {
            path: "findings/native-approved.md",
            content: "MCP_NATIVE_APPROVED_FIXTURE",
          },
          requestId: "native-mcp-once-write",
        },
      },
    ]);
    native = await startNativeRoleServer(root, provider.url);
    expect(native.version).toBe("2.0.150");
    const authority = new CapabilityAuthority(
      db,
      new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
    );
    const mcp = new CapabilityEngine(authority, {
      ...dataHandlers(db),
      ...fileHandlers(root),
    });
    pipeline = new RuntimePipeline(db, {
      cleanupCapabilities: async (_accountId, runId) => {
        await removeMcp(root, runId);
      },
      prepareCapabilities: async (accountId, runId) => {
        await bootstrapMcp(
          root,
          {
            runId,
            token: await authority.issue(accountId, runId),
            controlUrl: mcpUrl,
          },
          mcpUrl,
        );
      },
      factory: async (_account, role) =>
        new RoleRuntime({
          baseUrl: native!.baseUrl,
          token: native!.token,
          project: await prepareRoleProject({
            ...role,
            root,
            pluginUrl: pathToFileURL(
              resolve("plugins/reinlab-os-plugin/index.js"),
            ).href,
          }),
        }),
      pricingContext: {
        currency: "CNY",
        window: "peak",
        usdCnyRate: "7.2",
        pricingVersion: DEEPSEEK_PRICING_VERSION,
        validFrom: 1,
        validUntil: Date.now() + 3600000,
      },
    });
    const pricing = new PricingService({
      catalogUrl: baseUrl + "/catalog",
      usdCny: "7.2",
      routes: { strong: "role-fixture/fixture" },
    });
    const app = await createApp({
      pool,
      mcp,
      auth: { issuer },
      pricing,
      harness: new HarnessStore(db, bundle, registry),
      pipeline,
    });
    mcpServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    if (!mcpServer.listening)
      await new Promise<void>((done) => mcpServer!.once("listening", done));
    const mcpAddress = mcpServer.address();
    if (!mcpAddress || typeof mcpAddress === "string")
      throw Error("MCP_LISTEN_FAILED");
    mcpUrl = "http://127.0.0.1:" + mcpAddress.port + "/";
    const post = async (path: string, body: unknown, key = randomUUID()) =>
      app.request(path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + jwt,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      });
    expect((await app.request("/v1/me")).status).toBe(401);
    const dossierResponse = await post("/v1/dossiers", {
      bench: "research",
      title: "Pipeline native API fixture",
    });
    expect(dossierResponse.status).toBe(201);
    const dossier = (await dossierResponse.json()) as { id: string };
    const estimateResponse = await post("/v1/runs/estimate", {
      dossierId: dossier.id,
      mode: "read",
    });
    expect(estimateResponse.status).toBe(201);
    const quote = (await estimateResponse.json()) as {
      id: string;
      model: string;
    };
    expect(quote.model).toBe("role-fixture/fixture");
    const input = {
        dossierId: dossier.id,
        mode: "read",
        roleId: bundle.manifest.entrypoints.read,
        budget: { cny: 1 },
        estimateId: quote.id,
        confirmed: true,
        input: {
          question: "PIPELINE_NATIVE_CONFIRMED_2214",
          limits: { maxSteps: 1 },
        },
      },
      key = randomUUID();
    const confirmed = await post("/v1/runs", input, key);
    expect(confirmed.status).toBe(201);
    const run = (await confirmed.json()) as { id: string };
    let pendingApproval: string | undefined;
    await expect
      .poll(
        async () => {
          pendingApproval = (
            await admin.query(
              "select id from approval where run_id=$1 and os_request_id is not null and state='pending'",
              [run.id],
            )
          ).rows[0]?.id;
          return Boolean(pendingApproval);
        },
        { timeout: 30000 },
      )
      .toBe(true);
    await expect(
      readFile(
        join(root, "dossiers", dossier.id, "findings/native-approved.md"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const decided = await post("/v1/approvals/" + pendingApproval + "/decide", {
      decision: "approve",
      scope: "once",
    });
    expect(decided.status).toBe(202);
    await expect
      .poll(
        async () =>
          (
            await admin.query(
              "select ended_at is not null ended from run where id=$1",
              [run.id],
            )
          ).rows[0]?.ended,
        { timeout: 30000 },
      )
      .toBe(true);
    const binding = (
      await admin.query(
        "select b.*,h.bench,h.version,h.effective_digest,h.model_route from os_binding b join run_harness h on h.run_id=b.run_id where b.run_id=$1",
        [run.id],
      )
    ).rows[0];
    const usage = (
      await admin.query(
        "select part_id,cost_cny,metadata from os_usage where run_id=$1",
        [run.id],
      )
    ).rows;
    const events = (
      await admin.query(
        "select kind,action,cost_cny,payload from event where run_id=$1 order by seq",
        [run.id],
      )
    ).rows;
    const hold = (
      await admin.query(
        "select state,actual_cny from budget_hold where id=$1",
        [binding.hold_id],
      )
    ).rows[0];
    await expect
      .poll(async () => {
        try {
          await readFile(join(root, "mcp-clients", run.id + ".json"));
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
      })
      .toBe(true);
    expect(binding.phase).toBe("accepted");
    expect(binding.model_route).toBe(quote.model);
    expect(binding.role_options.model).toBe(quote.model);
    expect(binding.pricing_context.requestedModel).toBe(quote.model);
    expect(binding.effective_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(usage).toHaveLength(1);
    expect(usage[0].cost_cny).toBeNull();
    expect(usage[0].metadata.status).toBe("unknown");
    expect(hold).toEqual({ state: "unpriced", actual_cny: null });
    expect(events.some((event) => event.action === "run_queued")).toBe(true);
    expect(events.some((event) => event.action === "runtime_admitted")).toBe(
      true,
    );
    expect(
      events.some((event) => event.kind === "cost" && event.cost_cny === null),
    ).toBe(true);
    expect(
      events.some((event) => event.action === "run_admission_deferred"),
    ).toBe(false);
    expect(provider.requests).toHaveLength(1);
    expect(
      await readFile(
        join(root, "dossiers", dossier.id, "findings/native-approved.md"),
        "utf8",
      ),
    ).toBe("MCP_NATIVE_APPROVED_FIXTURE");
    expect(
      events.some(
        (event) =>
          event.action === "capability.call" &&
          event.payload.capability === "memory.read" &&
          event.payload.success === true,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.action === "capability.call" &&
          event.payload.capability === "files.write" &&
          event.payload.success === true,
      ),
    ).toBe(true);
    const system = provider.requests
      .flatMap((request) =>
        request.messages.filter((message) => message.role === "system"),
      )
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      )
      .join("\n");
    expect(system).toContain(
      await readFile(resolve("prompts/research/research-read.md"), "utf8"),
    );
    expect((await post("/v1/runs", input, key)).status).toBe(201);
    await pipeline.recoverAccount(account);
    expect(provider.requests).toHaveLength(1);
    expect(
      (
        await admin.query(
          "select count(*)::int n from os_usage where run_id=$1",
          [run.id],
        )
      ).rows[0].n,
    ).toBe(1);
    const evidence = await testEvidenceDirectory("pipeline-native");
    await writeFile(
      join(evidence, "pipeline-native-evidence.json"),
      JSON.stringify(
        {
          fixtureOnly: true,
          realModelRequests: 0,
          realModelCost: 0,
          nativeVersion: native.version,
          auth: "ES256 signature verified by local JWKS fixture; not a live Supabase session",
          api: "Hono estimate/confirmed-run real routes",
          model: binding.model_route,
          bench: binding.bench,
          version: binding.version,
          effectiveDigest: binding.effective_digest,
          providerCalls: provider.requests.length,
          usage,
          hold,
          events: events.map(({ kind, action, cost_cny }) => ({
            kind,
            action,
            cost_cny,
          })),
          system,
          requestBodies: provider.requests,
        },
        null,
        2,
      ).replaceAll(root, "<FIXTURE_ROOT>") + "\n",
    );
  } finally {
    await pipeline?.shutdown();
    if (mcpServer)
      await new Promise<void>((done) => mcpServer!.close(() => done()));
    await native?.close();
    await provider?.close();
    if (local) {
      local.closeAllConnections();
      await new Promise<void>((done) => local!.close(() => done()));
    }
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}, 90000);
