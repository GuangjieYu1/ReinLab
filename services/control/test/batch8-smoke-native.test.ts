import { requireNativeArtifact } from "../../account-runtime/artifact.mjs";
requireNativeArtifact();
import { it, expect, vi } from "vitest";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SignJWT } from "jose";
import { serve } from "@hono/node-server";
import { mcpFixture } from "./mcp-fixture";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner, hash } from "../src/mcp/token";
import { CapabilityEngine } from "../src/mcp/engine";
import { fileHandlers } from "../src/mcp/files";
import { dataHandlers } from "../src/mcp/data-handlers";
import { paperHandlers } from "../src/mcp/papers";
import { PaperHttp } from "../src/mcp/paper-http";
import { HarnessStore } from "../src/harness/store";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { RuntimePipeline } from "../src/bridge/openscience/pipeline";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { createSmokeApp } from "../src/api/smoke-app";
import { bootstrapMcp, removeMcp } from "../../account-runtime/mcp/store.mjs";
import { startNativeRoleServer } from "./fixtures/role-provider";
import { startMcpSmokeGuard } from "../../../tooling/local/mcp-smoke-guard";
import { smokeFetchArguments } from "../scripts/smoke-policy";
import { testEvidenceDirectory } from "./fixtures/test-evidence";
import { DEEPSEEK_PRICING_VERSION } from "../src/bridge/openscience/deepseek-pricing";

function fixturePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 45 >>\nstream\nBT /F1 12 Tf 10 100 Td (PAGE_ONE) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  return Buffer.from(
    text +
      "xref\n0 6\n0000000000 65535 f \n" +
      offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
it("third smoke rehearses real native SDK, all five MCP capabilities and exact once approvals with fixture model only", async () => {
  const f = await mcpFixture(undefined, false, "1.1.0"),
    root = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-b8-smoke-native-")),
    );
  const token = randomBytes(32).toString("base64url"),
    requests: any[] = [],
    approved: string[] = [];
  let native: any,
    server: any,
    pipeline: RuntimePipeline | undefined,
    guard: any,
    runtime: RoleRuntime | undefined,
    runId = "",
    mcpUrl = "";
  const secret = randomBytes(48),
    issuer = "http://smoke.fixture/auth/v1",
    ids = {
      search: "fixture-search",
      fetch: "fixture-fetch",
      pages: "fixture-pages",
      write: "fixture-write",
      card: "fixture-card",
    };
  const writeArgs = {
    path: "findings/fixture-once.md",
    content: "FIXTURE_APPROVED_WRITE",
  };
  const transport = fetch;
  vi.stubGlobal(
    "fetch",
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (String(input) === "https://models.dev/api.json")
        return Response.json({
          deepseek: {
            models: {
              "deepseek-v4-flash": {
                cost: { input: 0.3, output: 1.2 },
                limit: { context: 1000000, output: 4000 },
              },
            },
          },
        });
      return transport(input, init);
    },
  );
  try {
    const registry = await loadToolRegistry(),
      bundle = await loadBenchBundle({
        benchId: "research",
        version: "1.1.0",
        registry,
      });
    const authority = new CapabilityAuthority(
      f.db,
      new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
    );
    const http = new PaperHttp({
      dns: async () => ["93.184.216.34"],
      wire: async (url) => ({
        status: 200,
        headers: {
          "content-type":
            url.hostname === "arxiv.org"
              ? "application/pdf"
              : "application/json",
        },
        bytes:
          url.hostname === "arxiv.org"
            ? fixturePdf()
            : Buffer.from(
                JSON.stringify(
                  url.pathname === "/works"
                    ? {
                        results: [
                          {
                            id: "https://openalex.org/W4387156572",
                            title: "Fixture paper",
                            open_access: { is_oa: true },
                          },
                        ],
                      }
                    : {
                        id: "https://openalex.org/W4387156572",
                        title: "Fixture paper",
                        open_access: { is_oa: true },
                        best_oa_location: {
                          is_oa: true,
                          pdf_url: "https://arxiv.org/pdf/1234.12345",
                          license: "cc-by",
                        },
                      },
                ),
              ),
      }),
    });
    const mcp = new CapabilityEngine(authority, {
      ...fileHandlers(root),
      ...dataHandlers(f.db),
      ...paperHandlers(f.db, join(root, "cache"), async () => {}, http),
    });
    guard = await startMcpSmokeGuard({
      incomingToken: token,
      upstreamKey: "fixture-upstream-not-a-real-key",
      markerPath: join(root, "consumed"),
      authorizationEndsAt: Date.now() + 120000,
      testOnlyTransport: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        expect(body.thinking).toEqual({ type: "disabled" });
        expect(body.max_tokens).toBeLessThanOrEqual(1024);
        const outputs = body.messages
          .filter((m: any) => m.role === "tool")
          .map((m: any) => JSON.parse(m.content));
        const index = requests.length,
          asset = outputs.find((o: any) => o.status === "full_text")?.assetId;
        const next = [
          {
            name: "literature",
            capability: "papers.search",
            args: { query: "fixture", limit: 1 },
            id: ids.search,
          },
          {
            name: "literature",
            capability: "papers.fetch",
            args: { paperId: "W4387156572" },
            id: ids.fetch,
          },
          {
            name: "literature",
            capability: "papers.pages",
            args: { assetId: asset, pages: [1] },
            id: ids.pages,
          },
          {
            name: "finding_record",
            capability: "files.write",
            args: writeArgs,
            id: ids.write,
          },
          {
            name: "finding_record",
            capability: "cards.card.finding",
            args: {
              card: {
                text: "Fixture finding",
                evidence: [{ paperId: asset, page: 1, quote: "PAGE_ONE" }],
                confidence: "low",
                status: "hypothesis",
              },
            },
            id: ids.card,
          },
        ][index - 1];
        const delta = next
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_" + index,
                  type: "function",
                  function: {
                    name: next.name,
                    arguments: JSON.stringify({
                      capability: next.capability,
                      args: next.args,
                      requestId: next.id,
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Fixture complete." };
        const base = {
          id: "chatcmpl_fixture_" + index,
          object: "chat.completion.chunk",
          model: "deepseek-flash",
          created: 1,
        };
        return new Response(
          "data: " +
            JSON.stringify({
              ...base,
              choices: [{ index: 0, delta, finish_reason: null }],
            }) +
            "\n\ndata: " +
            JSON.stringify({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: next ? "tool_calls" : "stop",
                },
              ],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 10,
                total_tokens: 110,
              },
            }) +
            "\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    native = await startNativeRoleServer(
      root,
      "http://127.0.0.1:9",
      undefined,
      true,
    );
    let configured = false;
    pipeline = new RuntimePipeline(f.db, {
      pricingContext: {
        currency: "CNY", window: "peak", usdCnyRate: "7.2",
        pricingVersion: DEEPSEEK_PRICING_VERSION,
        validFrom: 1, validUntil: Date.now() + 120000,
      },
      cleanupCapabilities: async (_, run) => removeMcp(root, run),
      prepareCapabilities: async (a, run) =>
        bootstrapMcp(
          root,
          {
            runId: run,
            token: await authority.issue(a, run),
            controlUrl: mcpUrl,
          },
          mcpUrl,
        ),
      factory: async (_, role) => {
        const value = new RoleRuntime({
          baseUrl: native.baseUrl,
          token: native.token,
          project: await prepareRoleProject({
            ...role,
            root,
            pluginUrl: pathToFileURL(
              resolve("plugins/reinlab-os-plugin/index.js"),
            ).href,
          }),
        });
        if (!configured) {
          await value.configureSmokeGateway({
            origin: "http://127.0.0.1:" + guard.port,
            token,
          });
          configured = true;
          runtime = value;
        }
        return value;
      },
    });
    const app = await createSmokeApp(
      {
        pool: f.pool,
        harness: new HarnessStore(f.db, bundle, registry),
        pipeline,
        mcp,
        auth: { issuer, secret },
      },
      {
        MODEL_ROUTE_CHEAP: "deepseek/deepseek-v4-flash",
        MODEL_ROUTE_MID: "deepseek/deepseek-v4-flash",
        MODEL_ROUTE_STRONG: "deepseek/deepseek-v4-flash",
        MODEL_USD_CNY_RATE: "7.2",
      },
    );
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    if (!server.listening)
      await new Promise<void>((r) => server.once("listening", r));
    mcpUrl = "http://127.0.0.1:" + server.address().port + "/";
    const jwt = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject(f.account)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
    const post = async (path: string, body: any) => {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + jwt,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        console.error({
          fixtureOnly: true,
          path,
          status: response.status,
          code: ((await response.clone().json()) as any).code,
        });
      return response;
    };
    const dossier = (await (
      await post("/v1/dossiers", {
        bench: "research",
        title: "Fixture full chain",
      })
    ).json()) as any;
    const quote = (await (
      await post("/v1/runs/estimate", { dossierId: dossier.id, mode: "read" })
    ).json()) as any;
    const confirmed = await post("/v1/runs", {
      dossierId: dossier.id,
      mode: "read",
      roleId: "research-read",
      budget: { cny: 1 },
      estimateId: quote.id,
      confirmed: true,
      input: {
        question: "Fixture chain",
        limits: { maxSteps: 6 },
        memoryRefs: [],
      },
    });
    expect(confirmed.status).toBe(201);
    runId = ((await confirmed.json()) as any).id;
    for (let i = 0; i < 300; i++) {
      const rows = (
        await f.admin.query(
          "select id,effects from approval where run_id=$1 and os_request_id is not null and state='pending'",
          [runId],
        )
      ).rows;
      for (const a of rows) {
        const meta = a.effects
          .map((e: any) => (e.properties ?? e).metadata?.reinlabMcp)
          .find(Boolean);
        expect(meta).toBeDefined();
        const sessionId = (
          await f.admin.query(
            "select session_id from os_binding where run_id=$1",
            [runId],
          )
        ).rows[0].session_id;
        await runtime!.restoreSession(sessionId);
        const messages = await runtime!.messages(sessionId),
          tools = messages
            .flatMap((m: any) => m.parts ?? [])
            .filter((p: any) => p.type === "tool");
        const input = tools.find(
          (p: any) => p.state?.input?.requestId === meta.requestId,
        )?.state.input;
        expect(meta.argsHash).toBe(
          hash({ capability: input.capability, args: input.args }),
        );
        expect(meta.capability).toBe(input.capability);
        if (meta.requestId === ids.fetch) {
          expect(input.args).toEqual(
            smokeFetchArguments(tools, ids.search, "W4387156572"),
          );
        } else if (meta.requestId === ids.write) {
          expect(input.args).toEqual(writeArgs);
          expect(
            (
              await f.admin.query(
                "select 1 from paper_page_read where run_id=$1 and page=1",
                [runId],
              )
            ).rowCount,
          ).toBe(1);
          await expect(
            readFile(join(root, "dossiers", dossier.id, writeArgs.path)),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(meta.requestId).toBe(ids.card);
          expect(input.args.card.evidence[0].quote).toBe("PAGE_ONE");
          expect(
            await readFile(
              join(root, "dossiers", dossier.id, writeArgs.path),
              "utf8",
            ),
          ).toBe(writeArgs.content);
        }
        expect(
          (
            await post("/v1/approvals/" + a.id + "/decide", {
              decision: "approve",
              scope: "once",
            })
          ).status,
        ).toBe(202);
        approved.push(meta.capability);
      }
      const r = (
        await f.admin.query("select state,ended_at from run where id=$1", [
          runId,
        ])
      ).rows[0];
      if (r.ended_at) {
        // The loopback fixture is classified local by the unchanged kernel.
        // Its cash usage must stay unknown, so control preserves the hold.
        expect(r.state).toBe("paused_budget");
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(approved).toEqual([
      "papers.fetch",
      "files.write",
      "cards.card.finding",
    ]);
    expect(requests).toHaveLength(6);
    const usage = (await f.admin.query("select cost_cny,metadata from os_usage where run_id=$1",[runId])).rows;
    expect(usage).toHaveLength(6);
    expect(usage.every(row => row.cost_cny === null && row.metadata.unknownReason === "UNSUPPORTED_BILLING_ROUTE")).toBe(true);
    expect(guard.status()).toMatchObject({ forwardCount: 6, unknown: false });
    const calls = (
      await f.admin.query(
        "select payload->>'capability' name from event where run_id=$1 and action='capability.call' and payload->>'success'='true' order by seq",
        [runId],
      )
    ).rows.map((r) => r.name);
    expect(calls).toEqual([
      "papers.search",
      "papers.fetch",
      "papers.pages",
      "files.write",
      "cards.card.finding",
    ]);
    const evidence = await testEvidenceDirectory("batch8-smoke-native");
    await writeFile(
      join(evidence, "native-chain.json"),
      JSON.stringify({
        fixtureOnly: true,
        realModelRequests: 0,
          fixtureCashUsage: "unknown_local_route",
        nativeVersion: native.version,
        passed: true,
        forwardCount: requests.length,
        approved,
        calls,
      }),
    );
  } catch(error) {
    if(runId) console.error({fixtureOnly:true,requests:requests.length,usage:(await f.admin.query("select metadata->>'unknownReason' reason,metadata->>'actualRoute' route,metadata->>'actualModel' model from os_usage where run_id=$1",[runId])).rows});
    throw error;
  } finally {
    await guard?.close();
    await pipeline?.shutdown();
    await native?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await f.close();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  }
}, 60000);
