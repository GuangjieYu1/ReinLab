import { requireNativeArtifact } from "../../account-runtime/artifact.mjs";
requireNativeArtifact();
import { it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { mcpFixture } from "./mcp-fixture";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityEngine } from "../src/mcp/engine";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { materializeHarnessRole } from "../src/harness/materialize";
import { loadToolRegistry } from "../src/harness/manifest";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { createApp } from "../src/api/app";
import { localPeakPricing } from "../src/model/peak-pricing";
import { bootstrapMcp } from "../../account-runtime/mcp/store.mjs";
import { startNativeRoleServer } from "./fixtures/role-provider";
it.each([{clarify:true,version:"1.2.0",output:256},{clarify:true,version:"1.2.1",output:512},{clarify:false,version:"1.1.0",output:1024}])(
  "native real-mode role $version clarify=$clarify routes actual SDK body through host-only runtime audience",
  async ({clarify,version,output}) => {
    const f = await mcpFixture(
        undefined,
        false,
        version,
        clarify ? "research-clarify" : "research-read",
      ),
      root = await realpath(
        await mkdtemp(join(tmpdir(), "reinlab-b8-runtime-native-")),
      );
    let server: any,
      native: any,
      runtime: RoleRuntime | undefined,
      accepted: any,
      boundSession = "";
    const requests: any[] = [],
      outbound: any[] = [];
    try {
      await f.admin.query("update run set state='queued' where id=$1", [f.run]);
      if (clarify) {
        await f.admin.query(
          "insert into read_clarification(account_id,dossier_id)values($1,$2)",
          [f.account, f.dossier],
        );
        await f.admin.query(
          "insert into read_clarify_run(account_id,dossier_id,run_id)values($1,$2,$3)",
          [f.account, f.dossier, f.run],
        );
        await f.admin.query(
          "update budget_hold set maximum_cny=.05 where id=$1",
          [f.hold],
        );
      }
      const role = {
        ...materializeHarnessRole(f.effective, await loadToolRegistry(), {
          dossierId: f.dossier,
          roleId: clarify ? "research-clarify" : "research-read",
          modelRoutes: {
            cheap: "deepseek/deepseek-v4-flash",
            strong: "deepseek/deepseek-v4-flash",
          },
          memory: "",
        }),
        modelGateway: true as const,
      };
      const binding = await new BindingStore(f.db).prepare(f.account, f.run, {
        role,
        message: "fixture only",
      });
      expect(binding.role.modelGateway).toBe(true);
      boundSession = binding.sessionId;
      await f.admin.query(
        "update os_binding set hold_id=$2,pricing_context=$3 where run_id=$1",
        [f.run, f.hold, localPeakPricing()],
      );
      await f.admin.query("update run set state='running' where id=$1", [
        f.run,
      ]);
      const authority = new CapabilityAuthority(
          f.db,
          new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
        ),
        token = await authority.issue(f.account, f.run),
        modelToken = await authority.issueRuntimeModel(f.account, f.run, token);
      const mcp = new CapabilityEngine(authority, {});
      const app = await createApp({
        pool: f.pool,
        auth: {
          issuer: "http://fixture/auth/v1",
          secret: new Uint8Array(48).fill(7),
        },
        mcp,
        testOnlyRuntimeModelTransport: async (bytes) => {
          const body = JSON.parse(bytes.toString());
          requests.push(body);
          return new Response(
            "data: " +
              JSON.stringify({
                id: "chatcmpl_fixture",
                object: "chat.completion.chunk",
                created: 1,
                model: "deepseek-flash",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "Fixture only." },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }) +
              "\n\ndata: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      server = serve({
        fetch: async (req) => {
          if (new URL(req.url).pathname === "/mcp/runtime-model") {
            const b = (await req.clone().json()) as any;
            outbound.push({
              model: b.model,
              max_tokens: b.max_tokens,
              thinking: b.thinking,
              tools: b.tools?.map((t: any) => t.function?.name),
            });
          }
          return app.fetch(req);
        },
        port: 0,
        hostname: "127.0.0.1",
      });
      if (!server.listening)
        await new Promise<void>((r) => server.once("listening", r));
      const url = "http://127.0.0.1:" + server.address().port;
      await bootstrapMcp(
        root,
        { runId: f.run, token, modelToken, controlUrl: url },
        url,
      );
      if (clarify) {
        for (const [name, args] of [
          ["fetch", { paperId: "W1" }],
          ["pages", { assetId: f.dossier, pages: [1] }],
        ] as const) {
          const response = await app.request("/mcp/papers", {
            method: "POST",
            headers: {
              authorization: "Bearer " + token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: name,
              method: "tools/call",
              params: {
                name,
                arguments: { args, requestId: "denied-" + name },
              },
            }),
          });
          const result = (await response.json()) as any;
          expect(result.error).toBeDefined();
        }
        expect(
          (
            await f.admin.query(
              "select 1 from paper_asset where account_id=$1",
              [f.account],
            )
          ).rowCount,
        ).toBe(0);
        await expect(
          readFile(join(root, "dossiers", f.dossier, "papers")),
        ).rejects.toBeDefined();
      }
      native = await startNativeRoleServer(
        root,
        "http://127.0.0.1:9",
        undefined,
        true,
      );
      const auth = await authority.validate(token),
        project = await prepareRoleProject({
          ...binding.role,
          root,
          mcp: {
            runId: f.run,
            aliases: {
              literature: auth.scope.grants
                .filter((g) => g.name.startsWith("papers."))
                .map((g) => g.name),
            },
            grants: auth.scope.grants.map((g) => ({
              name: g.name,
              permission: g.permission,
              risk: auth.catalog.capabilities[g.name].risk,
            })),
          },
          pluginUrl: pathToFileURL(
            resolve("plugins/reinlab-os-plugin/index.js"),
          ).href,
        });
      const configText = await readFile(
        join(project.directory, "openscience.json"),
        "utf8",
      );
      expect(configText).toContain("https://reinlab-model.invalid/v1");
      expect(configText).not.toContain(modelToken);
      expect(configText).not.toContain(token);
      runtime = new RoleRuntime({
        baseUrl: native.baseUrl,
        token: native.token,
        project,
      });
      await runtime.createSession("Runtime model fixture", binding.sessionId);
      accepted = await runtime.prompt({
        sessionID: binding.sessionId,
        requestID: binding.requestId,
        message: "Fixture only.",
      });
      await expect
        .poll(
          async () => ({
            requests: requests.length,
            completed: (await runtime!.snapshot(binding.sessionId)).runs.some(
              (r: any) => r.state === "completed",
            ),
          }),
          { timeout: 30000 },
        )
        .toEqual({ requests: 1, completed: true });
      expect(requests[0]).toMatchObject({
        model: "deepseek-flash",
        thinking: { type: "disabled" },
        max_tokens: output,
      });
      expect(
        (
          await f.admin.query(
            "select state from runtime_model_request where run_id=$1",
            [f.run],
          )
        ).rows[0].state,
      ).toBe("completed");
      const usage = (await runtime.messages(binding.sessionId))
        .flatMap((m: any) => m.parts ?? [])
        .find((p: any) => p.type === "step-finish");
      expect(usage.usage).toMatchObject({
        provider: "deepseek",
        route: "byok",
      });
    } catch (error) {
      await writeFile(
        "/tmp/reinlab-b8-runtime-native-diagnostic.json",
        JSON.stringify({
          fixtureOnly: true,
          outbound,
          stopped: (
            await f.admin.query(
              "select payload->>'reason' reason from event where run_id=$1 and action in ('model_http_stopped','clarify_model_stopped')",
              [f.run],
            )
          ).rows,
          runs: runtime
            ? (await runtime.snapshot(boundSession)).runs.map((r: any) => ({
                state: r.state,
              }))
            : [],
        }),
      );
      throw error;
    } finally {
      if (runtime && accepted)
        await runtime.cancel(boundSession, accepted.runID).catch(() => {});
      await native?.close();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
