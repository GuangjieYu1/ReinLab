import { requireNativeArtifact } from "../../account-runtime/artifact.mjs";
requireNativeArtifact();
import { it, expect } from "vitest";
import { serve } from "@hono/node-server";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mcpFixture } from "./mcp-fixture";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilityEngine } from "../src/mcp/engine";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { materializeHarnessRole } from "../src/harness/materialize";
import { loadToolRegistry } from "../src/harness/manifest";
import { DEEPSEEK_PRICING_VERSION } from "../src/bridge/openscience/deepseek-pricing";
import { bootstrapMcp } from "../../account-runtime/mcp/store.mjs";
import { startNativeRoleServer } from "./fixtures/role-provider";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { createApp } from "../src/api/app";
import { PaperHttp } from "../src/mcp/paper-http";
import { paperHandlers } from "../src/mcp/papers";
it.each([true,false])("native2.0.150 candidates=%s routes SDK HTTP through cap and waits for human input without auto-picking", async (found) => {
  const f = await mcpFixture(undefined, false, "1.2.0", "research-clarify"),
    root = await realpath(await mkdtemp(join(tmpdir(), "reinlab-b7-native-")));
  let native: any, server: any, runtime: RoleRuntime | undefined, accepted: any;
  const requests: any[] = [];
  try {
    await f.admin.query("update run set state='queued' where id=$1", [f.run]);
    await f.admin.query(
      "insert into read_clarification(account_id,dossier_id)values($1,$2)",
      [f.account, f.dossier]
    );
    await f.admin.query(
      "insert into read_clarify_run(account_id,dossier_id,run_id)values($1,$2,$3)",
      [f.account, f.dossier, f.run]
    );
    const role = materializeHarnessRole(f.effective, await loadToolRegistry(), {
      dossierId: f.dossier,
      roleId: "research-clarify",
      modelRoutes: { cheap: "deepseek/deepseek-v4-flash" },
      memory: "",
    });
    const binding = await new BindingStore(f.db).prepare(f.account, f.run, {
      role,
      message: "native fixture only",
    });
    await f.admin.query(
      "update os_binding set pricing_context=$2 where run_id=$1",
      [
        f.run,
        {
          currency: "CNY",
          window: "peak",
          pricingVersion: DEEPSEEK_PRICING_VERSION,
          usdCnyRate: "7.2",
          validFrom: 1,
          validUntil: Date.now() + 3600000,
        },
      ]
    );
    await f.admin.query("update run set state='running' where id=$1", [f.run]);
    const authority = new CapabilityAuthority(
        f.db,
        new CapabilitySigner(generateKeyPairSync("ed25519").privateKey)
      ),
      token = await authority.issue(f.account, f.run),
      modelToken = await authority.issueModel(f.account, f.run, token);
    const http = new PaperHttp({
      dns: async () => ["93.184.216.34"],
      wire: async (url) => {
        expect(url.hostname).toBe("api.openalex.org");
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          bytes: Buffer.from(
            JSON.stringify({
              results: found ? [
                {
                  id: "https://openalex.org/W1",
                  title: "Grounded fixture paper",
                  authorships: [
                    { author: { display_name: "Actual Fixture Author" } },
                  ],
                  biblio: { first_page: "1", last_page: "12" },
                  open_access: { is_oa: true },
                  primary_location: {
                    source: { display_name: "Fixture Journal" },
                  },
                },
              ] : [],
            })
          ),
        };
      },
    });
    const mcp = new CapabilityEngine(
      authority,
      paperHandlers(
        f.db,
        join(root, "cache"),
        async () => {
          throw Error("CLARIFY_MUST_NOT_DOWNLOAD");
        },
        http
      )
    );
    const app = await createApp({
      pool: f.pool,
      auth: {
        issuer: "http://fixture/auth/v1",
        secret: new Uint8Array(48).fill(7),
      },
      mcp,
      testOnlyClarifyModelTransport: async (bytes) => {
        const body = JSON.parse(bytes.toString());
        requests.push(body);
        const index = requests.length;
        const args =
          index === 1
            ? {
                capability: "papers.search",
                args: { query: "attention", limit: 1 },
              }
            : {
                reason: "planning",
                questions: [
                  {
                    header: "REINLAB_PAPER_PICK",
                    question: "请选择",
                    options: [
                      {
                        label: "Invented (Recommended)",
                        description: "AI cannot choose",
                      },
                      { label: "Other", description: "x" },
                    ],
                    multiple: true,
                  },
                ],
              };
        const tool = index === 1 ? "literature" : "question";
        const chunk = {
          id: "chatcmpl_fixture_" + index,
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-flash",
        };
        return new Response(
          "data: " +
            JSON.stringify({
              ...chunk,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_" + index,
                        type: "function",
                        function: {
                          name: tool,
                          arguments: JSON.stringify(args),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }) +
            "\n\ndata: " +
            JSON.stringify({
              ...chunk,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }) +
            "\n\ndata: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } }
        );
      },
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    if (!server.listening)
      await new Promise<void>((r) => server.once("listening", r));
    const url = "http://127.0.0.1:" + server.address().port;
    await bootstrapMcp(
      root,
      { runId: f.run, token, modelToken, controlUrl: url },
      url
    );
    native = await startNativeRoleServer(
      root,
      "http://127.0.0.1:9",
      undefined,
      true
    );
    const auth = await authority.validate(token),
      project = await prepareRoleProject({
        ...role,
        root,
        mcp: {
          runId: f.run,
          aliases: { literature: ["papers.search"] },
          grants: auth.scope.grants.map((g) => ({
            name: g.name,
            permission: g.permission,
            risk: auth.catalog.capabilities[g.name].risk,
          })),
        },
        pluginUrl: pathToFileURL(resolve("plugins/reinlab-os-plugin/index.js"))
          .href,
      });
    runtime = new RoleRuntime({
      baseUrl: native.baseUrl,
      token: native.token,
      project,
    });
    await runtime.createSession("Clarify native fixture", binding.sessionId);
    accepted = await runtime.prompt({
      sessionID: binding.sessionId,
      requestID: binding.requestId,
      message: "Find a paper. Native fixture only, wait for human selection.",
    });
    await expect
      .poll(
        async () => {
          const snap = await runtime!.snapshot(binding.sessionId);
          return {
            questions: snap.questions.length,
            requests: requests.length,
            runs: snap.runs.map((r: any) => r.state),
          };
        },
        { timeout: 30000 }
      )
      .toMatchObject({ questions: 1, requests: 2 });
    const snap = await runtime.snapshot(binding.sessionId);
    expect(snap.questions[0].questions[0]).toMatchObject(found ? {
      header:'REINLAB_PAPER_PICK',multiple:false,options:[{label:'W1',description:'Grounded fixture paper'},{label:'都不是'}],
    } : {header:'REINLAB_CLARIFY',multiple:false,options:[{label:'补充说明'}]});
    const usage=(await runtime.messages(binding.sessionId)).flatMap((m:any)=>m.parts??[]).filter((p:any)=>p.type==='step-finish');
    expect(usage.length).toBeGreaterThan(0);expect(usage[0].usage).toMatchObject({provider:'deepseek',route:'byok'});
    expect(
      (
        await f.admin.query(
          "select chosen_id from read_clarification where dossier_id=$1",
          [f.dossier]
        )
      ).rows[0].chosen_id
    ).toBeNull();
    const candidates=(await f.admin.query('select metadata from read_candidate where run_id=$1',[f.run])).rows;
    if(found)expect(candidates[0].metadata).toMatchObject({title:'Grounded fixture paper',authors:'Actual Fixture Author',pages:12});
    else expect(candidates).toHaveLength(0);
    for (const body of requests) {
      expect(body).toMatchObject({
        model: "deepseek-flash",
        max_tokens: 256,
        thinking: { type: "disabled" },
      });
      expect(body.tools.map((t: any) => t.function.name).sort()).toEqual([
        "literature",
        "question",
      ]);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        fixtureOnly: true,
        requests: requests.map((b) => ({
          bytes: Buffer.byteLength(JSON.stringify(b)),
          max_tokens: b.max_tokens,
          model: b.model,
          tools: b.tools?.map((t: any) => t.function.name),
        })),
        fence: (
          await f.admin.query(
            "select maximum_micros,state from clarify_model_request where run_id=$1",
            [f.run]
          )
        ).rows,
        events: (
          await f.admin.query(
            "select action,payload->>'reason' reason from event where run_id=$1",
            [f.run]
          )
        ).rows,
      })
    );
    throw error;
  } finally {
    if (runtime && accepted)
      await runtime
        .cancel("ses_rl" + f.run.replaceAll("-", ""), accepted.runID)
        .catch(() => {});
    await native?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
