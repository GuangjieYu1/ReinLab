/** Real local Supabase Auth/RLS/API/SSE and native2.0.150 clarification with a fixture provider.
 * Formal study content below is explicitly synthetic. No real model credentials/calls.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityEngine } from "../src/mcp/engine";
import { PaperHttp } from "../src/mcp/paper-http";
import { paperHandlers } from "../src/mcp/papers";
import { RuntimePipeline } from "../src/bridge/openscience/pipeline";
import { RoleRuntime } from "../src/bridge/openscience/role-runtime";
import { prepareRoleProject } from "../src/bridge/openscience/role-project";
import { bootstrapMcp, removeMcp } from "../../account-runtime/mcp/store.mjs";
import { startNativeRoleServer } from "../test/fixtures/role-provider";
import { applyMigrations } from "../src/db/migrate";
import { serve } from "@hono/node-server";
import { createServer } from "vite";
import { chromium } from "playwright";
import { createApp } from "../src/api/app";
import { Database } from "../src/db/database";
import { PricingService } from "../src/budget/pricing";
import { localPeakPricing } from "../src/model/peak-pricing";
import { appendEvent } from "../src/ledger";
import { localPaths } from "../../../tooling/local/paths";
import { readPrivateEnv } from "../../../tooling/local/config";
import { readRuntimeConfiguration } from "../src/configuration";
const paths = localPaths(),
  config = readRuntimeConfiguration(paths.runtime),
  users = await readPrivateEnv(join(paths.state, "fixture-users.env"));
if (process.env.DEEPSEEK_API_KEY)
  throw Error("FIXTURE_REFUSES_MODEL_CREDENTIAL_ENV");
const out =
  process.env.REINLAB_EVIDENCE_OUT ?? "/tmp/reinlab-read-live-browser";
await mkdir(out, { recursive: true });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL_APP, max: 2 }),
  db = new Database(pool);
const results: { name: string; passed: boolean }[] = [];
let stage = "setup",
  modelRequests = 0,
  runPosts = 0,
  run = "",
  dossier = "",
  account = "",
  token = "",
  approval = "";
const clarifyRuns = new Set<string>();
let native: Awaited<ReturnType<typeof startNativeRoleServer>> | undefined,
  pipeline: RuntimePipeline | undefined,
  root = "",
  mcpUrl = "";
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  vite: Awaited<ReturnType<typeof createServer>> | undefined,
  server: ReturnType<typeof serve> | undefined;
const base = "http://127.0.0.1:5182",
  check = (name: string) => results.push({ name, passed: true });
try {
  const fixtureCatalog = {
    deepseek: {
      models: {
        "deepseek-v4-flash": {
          cost: { input: 0.3, output: 1.2 },
          limit: { context: 1000000, output: 4000 },
        },
      },
    },
  };
  const pricing = new PricingService({
    catalogUrl:
      "data:application/json," +
      encodeURIComponent(JSON.stringify(fixtureCatalog)),
    routes: {
      cheap: "deepseek/deepseek-v4-flash",
      mid: "deepseek/deepseek-v4-flash",
      strong: "deepseek/deepseek-v4-flash",
    },
    usdCny: "7.2",
  });
  const setup = await readPrivateEnv(paths.setup),
    adminUrl = new URL(setup.DATABASE_URL);
  adminUrl.username = "supabase_admin";
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  try {
    await applyMigrations(admin, resolve("infra/supabase/migrations"));
  } finally {
    await admin.end();
  }
  assert.equal(process.env.NODE_ENV, "test");
  root = await realpath(
    await mkdtemp(join(tmpdir(), "reinlab-b7-browser-native-")),
  );
  native = await startNativeRoleServer(
    root,
    "http://127.0.0.1:9",
    undefined,
    true,
  );
  const authority = new CapabilityAuthority(
    db,
    new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
  );
  const http = new PaperHttp({
    dns: async () => ["93.184.216.34"],
    wire: async (url) => {
      assert.equal(url.hostname, "api.openalex.org");
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        bytes: Buffer.from(
          JSON.stringify({
            results: [
              {
                id: "https://openalex.org/W1",
                title: "Adapter verification fixture paper",
                authorships: [{ author: { display_name: "Fixture Author" } }],
                biblio: { first_page: "1", last_page: "12" },
                open_access: { is_oa: true },
                primary_location: {
                  source: { display_name: "Fixture Journal" },
                },
              },
            ],
          }),
        ),
      };
    },
  });
  const mcp = new CapabilityEngine(
    authority,
    paperHandlers(
      db,
      join(root, "cache"),
      async () => {
        throw Error("CLARIFY_CANNOT_DOWNLOAD");
      },
      http,
    ),
  );
  pipeline = new RuntimePipeline(db, {
    realModels: true,
    pricingContext: localPeakPricing(),
    prepareCapabilities: async (a, id) => {
      const token = await authority.issue(a, id);
      await bootstrapMcp(
        root,
        {
          runId: id,
          token,
          modelToken: await authority.issueRuntimeModel(a, id, token),
          controlUrl: mcpUrl,
        },
        mcpUrl,
      );
    },
    cleanupCapabilities: async (_a, id) => {
      await removeMcp(root, id);
    },
    factory: async (_a, role) =>
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
  });
  const app = await createApp({
    pipeline,
    mcp,
    testOnlyRuntimeModelTransport: async (bytes) => {
      modelRequests++;
      const body = JSON.parse(bytes.toString());
      assert.equal(body.thinking.type, "disabled");
      assert.equal(body.max_tokens, 256);
      const search = body.messages.some((m: any) => m.role === "tool");
      const args = search
        ? {
            reason: "planning",
            questions: [
              {
                header: "REINLAB_PAPER_PICK",
                question: "请选择这次精读的论文",
                options: [
                  {
                    label: "AI choice (Recommended)",
                    description: "Must be overwritten",
                  },
                  { label: "Other", description: "x" },
                ],
                multiple: true,
              },
            ],
          }
        : {
            capability: "papers.search",
            args: { query: "Adapter verification fixture paper", limit: 1 },
          };
      const chunk = {
        id: "chatcmpl_browser_" + modelRequests,
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
                      id: "call_" + modelRequests,
                      type: "function",
                      function: {
                        name: search ? "question" : "literature",
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
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    pool,
    pricing,
    session: { url: config.SUPABASE_URL!, anonKey: config.SUPABASE_ANON_KEY! },
    auth: {
      issuer: config.SUPABASE_URL!.replace(/\/$/, "") + "/auth/v1",
      secret: config.SUPABASE_JWT_SECRET
        ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET)
        : undefined,
    },
    onRunQueued: async (a, id) => {
      const queued = await db.withAccount(
        a,
        async (c) =>
          (await c.query("select role_id from run where id=$1", [id])).rows[0],
      );
      if (queued.role_id === "research-clarify") {
        clarifyRuns.add(id);
        await pipeline!.submit(a, id);
        return;
      }
      runPosts++;
      assert.equal(a, account);
      run = id;
      approval = randomUUID();
      await db.withAccount(account, async (c) => {
        const row = (
          await c.query("select dossier_id,input from run where id=$1", [id])
        ).rows[0];
        dossier = row.dossier_id;
        assert.equal(row.input.query, "Adapter verification fixture paper");
        await c.query("update run set state='waiting' where id=$1", [run]);
        await c.query(
          "insert into approval(id,account_id,run_id,kind,title,effects,risk)values($1,$2,$3,'permission','验证用合成论文下载审批',$4,'write')",
          [
            approval,
            account,
            run,
            JSON.stringify({
              operation: "approval.request",
              subject: "验证用合成论文",
              effects: ["本测试只记录批准收据，不下载真实论文"],
            }),
          ],
        );
        await appendEvent(c, account, {
          dossierId: dossier,
          runId: run,
          kind: "approval",
          action: "fixture_waiting",
          payload: { synthetic: true },
          dedupeKey: randomUUID(),
        });
      });
    },
  });
  await new Promise<void>((done) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
      done(),
    );
  });
  const address = server!.address();
  assert(address && typeof address !== "string");
  mcpUrl = "http://127.0.0.1:" + address.port;
  vite = await createServer({
    configFile: resolve("vite.config.ts"),
    logLevel: "silent",
    define: { "import.meta.env.VITE_BACKEND": JSON.stringify("live") },
    server: {
      host: "127.0.0.1",
      port: 5182,
      strictPort: true,
      proxy: {
        "/backend": {
          target: "http://127.0.0.1:" + address.port,
          changeOrigin: false,
          rewrite: (p) => p.replace(/^\/backend/, ""),
        },
      },
    },
  });
  await vite.listen();
  stage = "real_auth";
  const login = await fetch(base + "/backend/auth/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email: users.A_EMAIL, password: users.A_PASSWORD }),
    redirect: "error",
  });
  assert.equal(login.status, 200);
  const identity = (await login.json()) as {
    accountId: string;
    accessToken: string;
  };
  account = identity.accountId;
  token = identity.accessToken;
  const headers = {
    authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  };
  const created = await fetch(base + "/backend/v1/dossiers", {
    method: "POST",
    headers,
    body: JSON.stringify({
      bench: "research",
      title: "精读适配器验证（合成内容）",
    }),
  });
  assert.equal(created.status, 201);
  dossier = ((await created.json()) as { id: string }).id;
  check(stage);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  let pageErrors = 0;
  page.on("pageerror", () => pageErrors++);
  const signIn = async () => {
    await page.getByLabel("用户名或邮箱", { exact: true }).fill(users.A_EMAIL);
    await page.getByPlaceholder("PASSWORD", { exact: true }).fill(users.A_PASSWORD);
    await page.getByRole("button", { name: /REQUEST/ }).click();
    await page.getByLabel("用户名或邮箱", { exact: true }).waitFor({ state: "detached" });
    await page.evaluate(async () => {
      const modulePath = "/src/nav.ts";
      const { navigate } = await import(modulePath);
      navigate('/?preview=workbench&studio=research&file=0');
    });
    await page.locator(".rd-new").waitFor();
    const dialog = page.getByRole("dialog", { name: "上线时待批准" });
    if (await dialog.isVisible())
      await dialog.getByRole("button", { name: /稍后处理/ }).click();
  };
  await page.goto(base + "/?preview=workbench&studio=research&file=0");
  await signIn();
  stage = "native_clarify_human_pick_1_2";
  await page.locator(".rd-new").click();
  await page
    .locator(".ad-input textarea")
    .fill("Adapter verification fixture paper");
  await page.keyboard.press("Enter");
  const paperPick = page
    .locator(".ad .rd-pick li button", {
      hasText: "Adapter verification fixture paper",
    })
    .last();
  stage = "native_question_wait";
  await paperPick.waitFor({ timeout: 30000 });
  assert.equal(await page.locator(".rd-chosen").count(), 0);
  assert.equal(runPosts, 0);
  assert.equal(modelRequests, 2);
  await page.screenshot({ path: join(out, "clarify-pick.png") });
  stage = "human_pick_submit";
  await paperPick.click();
  await page.locator(".rd-chosen").waitFor({ timeout: 20000 });
  assert((await page.locator(".rd-chosen").innerText()).includes("12 页"));
  check(stage);
  stage = "selected_pages_estimate_without_formal_dispatch";
  await page.locator(".rd-start .rd-go").click();
  await page.locator(".rd-estimate").waitFor();
  assert.equal(runPosts, 0);
  await page.screenshot({ path: join(out, "estimate.png") });
  check(stage);
  stage = "confirmed_once_waiting_approval";
  await page.getByRole("button", { name: "确认开始", exact: true }).click();
  await page.locator(".rd-start-ap").waitFor();
  assert.equal(runPosts, 1);
  await page.screenshot({ path: join(out, "waiting.png") });
  await page.locator(".rd-start-ap .rd-go").click();
  for (let i = 0; i < 30; i++) {
    const state = await db.withAccount(account, (c) =>
      c.query("select state from approval where id=$1", [approval]),
    );
    if (state.rows[0].state === "approved") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    (
      await db.withAccount(account, (c) =>
        c.query("select state from approval where id=$1", [approval]),
      )
    ).rows[0].state,
    "approved",
  );
  check(stage);
  stage = "real_sse_synthetic_paper_cards";
  const asset = randomUUID(),
    layer = randomUUID(),
    quiz = randomUUID(),
    finding = randomUUID(),
    quote = "Synthetic page used only for adapter verification.";
  const sha = createHash("sha256").update(quote).digest("hex");
  await db.withAccount(account, async (c) => {
    await c.query(
      "insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,license,status,is_open_access,sha256,path,abstract,view_metadata)values($1,$2,$3,$4,'W-FIXTURE','https://example.invalid/fixture','cc-by','full_text',true,$5,$6,'synthetic',$7)",
      [
        asset,
        account,
        dossier,
        run,
        sha,
        "papers/" + asset + ".pdf",
        JSON.stringify({
          title: "Adapter verification fixture paper",
          authors: ["Synthetic fixture author"],
          venue: "Adapter test fixture",
          sizeBytes: 1234,
        }),
      ],
    );
    await c.query(
      "insert into paper_page_read(account_id,dossier_id,run_id,asset_id,page,text_sha256,page_text)values($1,$2,$3,$4,1,$5,$6)",
      [account, dossier, run, asset, sha, quote],
    );
    const anchor = { paperId: asset, page: 1, quote };
    for (const [type, id, card] of [
      [
        "layer",
        layer,
        {
          paperId: asset,
          no: "1",
          title: "合成验证讲解",
          en: "FIXTURE",
          body: [
            { text: "仅用于适配测试的解释，不能当研究结论。", refs: [anchor] },
          ],
        },
      ],
      [
        "quiz",
        quiz,
        {
          paperId: asset,
          layer: "1",
          q: "合成检查题：这是什么测试？",
          hint: "查看来源",
        },
      ],
      [
        "finding",
        finding,
        {
          n: 37,
          text: "合成发现卡，仅验证映射。",
          evidence: [anchor],
          confidence: "low",
          status: "hypothesis",
          at: new Date().toISOString(),
        },
      ],
    ] as const)
      await appendEvent(c, account, {
        dossierId: dossier,
        runId: run,
        kind: "card",
        action: "card_created",
        payload: {
          cardId: id,
          cardType: type,
          card: JSON.parse(JSON.stringify(card)),
        },
        dedupeKey: randomUUID(),
      });
    await c.query(
      "update run set state='completed',ended_at=now() where id=$1",
      [run],
    );
    await appendEvent(c, account, {
      dossierId: dossier,
      runId: run,
      kind: "tool",
      action: "capability.call",
      payload: {
        capability: "papers.pages",
        success: true,
        summary: { assetId: asset, pages: [1] },
      },
      dedupeKey: randomUUID(),
    });
  });
  await page.locator(".rd-layer").waitFor();
  await page.locator(".rd-finding").waitFor();
  await page.locator('.rd-runbar[data-state="done"]').waitFor();
  assert((await page.locator(".rd-run-cost").innerText()).includes("—"));
  assert((await page.locator(".rd-source").innerText()).includes(quote));
  await page.screenshot({ path: join(out, "results.png") });
  check(stage);
  stage = "honest_unwired_and_no_answers";
  await page.locator(".ad-input textarea").fill("问一个真实追问");
  await page.keyboard.press("Enter");
  await page.getByText("追问未接入", { exact: false }).first().waitFor();
  await page.locator(".en-tabs button").nth(3).click();
  await page.locator(".rd-q textarea").fill("任意答案");
  await page.locator(".rd-q .rh-btn").click();
  await page.getByText("评分暂时不可用", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByText("PRIVATE_QUIZ_FIXTURE_ANSWER", { exact: false })
      .count(),
    0,
  );
  await page.screenshot({ path: join(out, "unwired.png") });
  check(stage);
  stage = "reload_recovers_from_real_ledger";
  await page.reload();
  await signIn();
  await page.locator(".rd-layer").waitFor();
  await page.locator(".rd-finding").waitFor();
  assert.equal(runPosts, 1);
  assert.equal(modelRequests, 2);
  assert.equal(pageErrors, 0);
  check(stage);
  stage = "audit_export";
  const audit = await fetch(
    base + "/backend/v1/dossiers/" + dossier + "/audit",
    { headers: { authorization: "Bearer " + token } },
  );
  assert.equal(audit.status, 200);
  const ledger = await audit.text();
  assert(!ledger.includes(token));
  assert(!ledger.includes("PRIVATE_QUIZ_FIXTURE_ANSWER"));
  await writeFile(join(out, "ledger.jsonl"), ledger);
  check(stage);
  await context.close();
} catch (error) {
  console.log(
    JSON.stringify({
      failureStage: stage,
      failureClass: error instanceof Error ? error.name : "unknown",
    }),
  );
  if (account && pipeline) {
    try {
      const rows = await db.withAccount(
        account,
        async (c) =>
          (
            await c.query(
              "select r.id,r.state,r.dossier_id from run r where role_id='research-clarify' and state in ('running','waiting') order by created_at desc limit 1",
            )
          ).rows,
      );
      for (const r of rows) {
        await pipeline.reconcileRun(account, r.id).catch((e: any) =>
          console.log(
            JSON.stringify({
              reconcileCode: e.code ?? "UNCLASSIFIED",
              source: e.stack?.split("\n").slice(1, 3),
            }),
          ),
        );
      }
    } catch {}
  }
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page && stage !== "real_auth")
      await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  }
  results.push({ name: stage, passed: false });
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const id of clarifyRuns) {
    await pipeline?.decisions.cancel(account, id).catch(() => {});
    await db
      .withAccount(account, async (c) => {
        await c.query(
          "update run set state='interrupted',ended_at=now() where id=$1 and state not in ('completed','failed','cancelled','interrupted')",
          [id],
        );
        await c.query(
          "update budget_hold set state='unpriced' where run_id=$1 and state='reserved'",
          [id],
        );
      })
      .catch(() => {
        results.push({ name: "native_fixture_cleanup", passed: false });
        process.exitCode = 1;
      });
  }
  await pipeline?.shutdown();
  await native?.close();
  if (root) await rm(root, { recursive: true, force: true });
  await vite?.close();
  if (server) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  if (account && run) {
    try {
      await db.withAccount(account, async (client) => {
        await client.query(
          "update run set state='failed',ended_at=now() where id=$1 and state not in ('completed','failed','cancelled','interrupted')",
          [run],
        );
        await client.query(
          "update budget_hold set state='released' where run_id=$1 and state='reserved'",
          [run],
        );
      });
    } catch {
      results.push({ name: "fixture_cleanup", passed: false });
      process.exitCode = 1;
    }
  }
  await pool.end();
  const report = {
    realInfrastructure: true,
    syntheticStudyData: true,
    fixturePricing: true,
    nativeRuntime: true,
    clarificationNative: true,
    formalStudySynthetic: true,
    fixtureModelHttpRequests: modelRequests,
    realModelRequests: 0,
    runPosts,
    passed: results.filter((v) => v.passed).length,
    failed: results.filter((v) => !v.passed).length,
    results,
  };
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
