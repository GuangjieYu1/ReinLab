import { getuid } from "node:process";
import { smokeOperatorArguments, smokeFetchArguments } from "./smoke-policy";
/** Explicit one-workflow operator CLI; never imported by CI. Key stays in host memory. */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import pg from "pg";
import { chromium } from "playwright";
import { readRuntimeConfiguration } from "../src/configuration";
import { Database } from "../src/db/database";
import { createSmokeApp } from "../src/api/smoke-app";
import { CapabilityAuthority } from "../src/mcp/authority";
import { ensureSigningKey, hash } from "../src/mcp/token";
import { CapabilityEngine } from "../src/mcp/engine";
import { accountPort } from "../src/mcp/account-port";
import { dataHandlers } from "../src/mcp/data-handlers";
import { paperHandlers } from "../src/mcp/papers";
import { RuntimePipeline } from "../src/bridge/openscience/pipeline";
import { createProductionRuntimeFactory } from "../src/bridge/openscience/production-factory";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { DEEPSEEK_PRICING_VERSION } from "../src/bridge/openscience/deepseek-pricing";
import { loadToolRegistry, loadBenchBundle } from "../src/harness/manifest";
import { HarnessStore } from "../src/harness/store";
import { materializeHarnessRole } from "../src/harness/materialize";
import { localPaths } from "../../../tooling/local/paths";
import { readPrivateEnv, writePrivateEnv } from "../../../tooling/local/config";
import { authenticateVerificationUser } from "../../../tooling/local/verification-auth";
import {
  stopOwnedControl,
  startControlProcess,
} from "../../../tooling/local/control-process";
import { acquireStartupLock } from "../../../tooling/local/startup-lock";
import {
  privateEvidenceDirectory,
  writePrivateEvidence,
} from "../../../tooling/local/private-evidence";
import { cleanupSmoke } from "../../../tooling/local/smoke-cleanup";
import { startMcpSmokeGuard } from "../../../tooling/local/mcp-smoke-guard";
const cli = smokeOperatorArguments(process.argv.slice(2));
const paths = localPaths(),
  config = readRuntimeConfiguration(paths.runtime),
  directory = join(paths.state, "mcp10-authorized-20261024");
const out =
  process.env.REINLAB_EVIDENCE_OUT ?? join(paths.state, "mcp10-evidence");
const report: Record<string, any> = {
  authorization: cli.authorization,
  executor: cli.executor,
  expectedApprovals: ["papers.fetch", "files.write", "cards.card.finding"],
  realModel: true,
  attempts: 1,
  budgetCny: 1,
  providerInvoiceReconciled: false,
  completed: false,
  startedAt: new Date().toISOString(),
};
let lock: Awaited<ReturnType<typeof acquireStartupLock>> | undefined,
  initialRole: any;
let stage = "authorization",
  pool: pg.Pool | undefined,
  db: Database | undefined,
  pipeline: RuntimePipeline | undefined,
  server: ReturnType<typeof serve> | undefined,
  guard: Awaited<ReturnType<typeof startMcpSmokeGuard>> | undefined,
  configured: any,
  runtime: any,
  controlStopped = false;
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOCKER_HOST: config.DOCKER_HOST,
  DOCKER_CONFIG: join(paths.state, "docker-client"),
};
const normalized = (s: string) => s.replace(/\s+/gu, " ").trim();
try {
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  assert.notEqual(process.env.NODE_ENV, "test");
  lock = await acquireStartupLock();
  await privateEvidenceDirectory(out);
  process.env.REINLAB_RUNTIME_CONFIG_FILE = paths.runtime;
  // Official CNY table and Safari's key-filtered account verified before invocation.
  const now = Date.now(),
    end = Date.parse("2026-10-25T16:00:00.000Z");
  assert.ok(
    now >= Date.parse("2026-10-23T16:00:00.000Z") && now + 600_000 < end
  );
  const pricingContext = {
    currency: "CNY" as const,
    window: "offpeak" as const,
    usdCnyRate: "7.2" as const,
    pricingVersion: DEEPSEEK_PRICING_VERSION,
    validFrom: now - 60_000,
    validUntil: Math.min(end, now + 3_600_000),
  };
  report.pricingContext = pricingContext;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  assert.equal(stat.uid, getuid?.());
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(stat.isSymbolicLink(), false);
  const admissionFile = join(directory, "admission.env");
  let admission: Record<string, string> = {};
  try {
    admission = await readPrivateEnv(admissionFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  assert.equal(admission.RUN_KEY, undefined, "MCP10_ALREADY_CONSUMED");
  pool = new pg.Pool({ connectionString: config.DATABASE_URL_APP, max: 6 });
  db = new Database(pool);
  await db.assertSafeRole();
  stage = "dedicated_auth";
  const identityFile = join(directory, "identity.env");
  let identity: Record<string, string> = {};
  try {
    identity = await readPrivateEnv(identityFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  identity.EMAIL ??= "local-" + randomUUID() + "@reinlab.invalid";
  identity.PASSWORD ??= randomBytes(32).toString("base64url");
  await writePrivateEnv(identityFile, identity);
  const session = await authenticateVerificationUser(
    { url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY },
    {
      email: identity.EMAIL,
      password: identity.PASSWORD,
      registered: identity.REGISTERED === "true",
    }
  );
  identity.REGISTERED = "true";
  identity.ACCOUNT_ID = session.id;
  await writePrivateEnv(identityFile, identity);
  report.accountId = session.id;
  stage = "provision";
  let ready = false;
  for (const end = Date.now() + 240_000; Date.now() < end; ) {
    ready = await db.withAccount(session.id, async (c) =>
      Boolean(
        (
          await c.query(
            "select 1 from account_machine where account_id=$1 and state='ready' and image=$2 and os_version='2.0.150'",
            [session.id, config.ACCOUNT_IMAGE]
          )
        ).rowCount
      )
    );
    if (ready) break;
    await delay(1000);
  }
  assert.ok(ready);
  const registry = await loadToolRegistry(),
    bundle = await loadBenchBundle({ benchId: "research", registry }),
    harness = new HarnessStore(db, bundle, registry),
    port = accountPort(db);
  const authority = new CapabilityAuthority(
    db,
    await ensureSigningKey(
      config.REINLAB_MCP_SIGNING_KEY_FILE ??
        join(homedir(), ".config/reinlab/mcp/signing.pem")
    )
  );
  const mcp = new CapabilityEngine(authority, {
    ...port.handlers,
    ...dataHandlers(db, port.cardDeposit),
    ...paperHandlers(
      db,
      join(homedir(), ".local/state/reinlab/papers"),
      port.deposit
    ),
  });
  pipeline = new RuntimePipeline(db, {
    pricingContext,
    prepareCapabilities: async (a, r) => {
      assert.equal(a, session.id);
      const token = await authority.issue(a, r);
      await writePrivateEnv(join(directory, "capability-" + r + ".env"), {
        CAPABILITY_TOKEN: token,
      });
      await port.bootstrap(a, r, token, config.REINLAB_CONTROL_URL);
    },
    cleanupCapabilities: async (a, r) => {
      await port.cleanup(a, r);
    },
  });
  stage = "trusted_control";
  await stopOwnedControl(paths.process, resolve("tooling/local/control.ts"));
  controlStopped = true;
  const app = await createSmokeApp(
    {
      pool,
      harness,
      pipeline,
      mcp,
      auth: { issuer: config.SUPABASE_URL + "/auth/v1" },
    },
    config
  );
  server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 3001 });
  await new Promise<void>((done) =>
    server!.listening ? done() : server!.once("listening", done)
  );
  const api = async (
    path: string,
    body?: unknown,
    key: string = randomUUID()
  ) => {
    const r = await fetch("http://127.0.0.1:3001" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + session.token,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "idempotency-key": key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw Error("MCP10_HTTP_" + r.status);
    }
    return (await r.json()) as any;
  };
  stage = "fresh_1_1_dossier";
  const dossier = await api("/v1/dossiers", {
    bench: "research",
    title: "T-MCP-10 单次真实研究链路（显式新授权）",
  });
  report.dossierId = dossier.id;
  const effective = await harness.effective(session.id, dossier.id);
  assert.equal(effective.manifest.version, "1.1.0");
  report.benchVersion = "1.1.0";
  const role = materializeHarnessRole(effective, registry, {
    dossierId: dossier.id,
    roleId: "research-read",
    modelRoutes: {
      cheap: "deepseek/deepseek-v4-flash",
      mid: "deepseek/deepseek-v4-flash",
      strong: "deepseek/deepseek-v4-flash",
    },
    memory: "",
    maxSteps: 6,
  });
  initialRole = role;
  runtime = await createProductionRuntimeFactory(db)(session.id, role);
  const quote = await api("/v1/runs/estimate", {
    dossierId: dossier.id,
    mode: "read",
  });
  assert.equal(quote.model, "deepseek/deepseek-v4-flash");
  report.estimateId = quote.id;
  stage = "protected_key";
  const secrets = await readPrivateEnv(
    join(homedir(), ".config/reinlab/local.env")
  );
  assert.ok(secrets.DEEPSEEK_API_KEY);
  const usageScope = await readPrivateEnv(
    join(paths.state, "mcp10-usage-scope.env")
  );
  assert.equal(usageScope.ALIAS, "ReinLab");
  const mask = /^(sk-[A-Za-z0-9]+)\*+([A-Za-z0-9]+)$/.exec(usageScope.MASK);
  assert.ok(mask);
  assert.ok(
    secrets.DEEPSEEK_API_KEY.startsWith(mask[1]) &&
      secrets.DEEPSEEK_API_KEY.endsWith(mask[2])
  );
  report.keyMatchesBillingAlias = true;
  const temporaryToken = randomBytes(32).toString("base64url");
  guard = await startMcpSmokeGuard({
    incomingToken: temporaryToken,
    upstreamKey: secrets.DEEPSEEK_API_KEY,
    markerPath: join(directory, "model-forwarded.marker"),
  });
  delete secrets.DEEPSEEK_API_KEY;
  configured = await runtime.configureSmokeGateway({
    origin: "http://host.docker.internal:" + guard.port,
    token: temporaryToken,
  });
  const marker = "mcp10-" + randomUUID(),
    fileArgs = {
      path: "findings/" + marker + ".md",
      content:
        "T-MCP-10：单次真实研究能力链路验证。只写入本档案新文件；引用核对由发现卡完成。",
    };
  const ids = {
    search: marker + "-search",
    fetch: marker + "-fetch",
    pages: marker + "-pages",
    write: marker + "-write",
    card: marker + "-card",
  };
  report.marker = marker;
  report.approvedFile = fileArgs.path;
  const question = `本次仅执行一次验证，任何工具失败立即停止，不重试、不绕过。顺序调用：1. literature/papers.search，args={"query":"QA-LoRA: Quantization-Aware Low-Rank Adaptation of Large Language Models","limit":1}，requestId=${
    ids.search
  }。2. 从结果paperId调用literature/papers.fetch，requestId=${
    ids.fetch
  }。3. 必须full_text，再literature/papers.pages读取assetId第1页（pages:[1]），requestId=${
    ids.pages
  }；无全文立即停止。4. finding_record/files.write，args=${JSON.stringify(
    fileArgs
  )}，requestId=${
    ids.write
  }，等待仅一次批准。5. 成功后finding_record/cards.card.finding，requestId=${
    ids.card
  }，args.card={text:简短的论文方法发现,evidence:[{paperId:真实assetId,page:1,quote:刚读取的逐字原文短句（不超过25个英文词）}],confidence:"low",status:"hypothesis"}。严禁编造引用或添加字段。6. 卡片成功后只回复一句完成，不再调用工具。只用上述别名，所有调用显式传capability及args。`;
  admission.RUN_KEY = randomUUID();
  admission.ESTIMATE_ID = quote.id;
  await writePrivateEnv(admissionFile, admission);
  report.submittedAt = new Date().toISOString();
  stage = "one_confirmation";
  const run = await api(
    "/v1/runs",
    {
      dossierId: dossier.id,
      mode: "read",
      roleId: "research-read",
      budget: { cny: 1 },
      estimateId: quote.id,
      confirmed: true,
      input: { question, limits: { maxSteps: 6 }, memoryRefs: [] },
    },
    admission.RUN_KEY
  );
  admission.RUN_ID = run.id;
  await writePrivateEnv(admissionFile, admission);
  report.runId = run.id;
  stage = "observe_and_exact_approvals";
  const decided = new Set<string>();
  let reader: any,
    sessionId = "";
  for (const end = Date.now() + 360_000; Date.now() < end; ) {
    const binding = await new BindingStore(db).get(session.id, run.id);
    if (binding.receipt && !reader) {
      reader = await createProductionRuntimeFactory(db, { readOnly: true })(
        session.id,
        binding.role
      );
      await reader.restoreSession(binding.sessionId);
      sessionId = binding.sessionId;
      report.requestId = binding.requestId;
    }
    const rows: { run: any; pending: any[]; failed: number | null } =
      await db.withAccount(session.id, async (c) => ({
        run: (
          await c.query(
            "select state,ended_at,spent_cny::text from run where id=$1",
            [run.id]
          )
        ).rows[0],
        pending: (
          await c.query(
            "select id,effects,kind,decision_sent from approval where run_id=$1 and state='pending' and os_request_id is not null",
            [run.id]
          )
        ).rows,
        failed: (
          await c.query(
            "select 1 from event where run_id=$1 and action='capability.denied' and payload->>'reason'<>'APPROVAL_REQUIRED' limit 1",
            [run.id]
          )
        ).rowCount,
      }));
    if (guard.status().unknown) throw Error("MCP10_MODEL_RESULT_UNKNOWN");
    if (rows.failed) throw Error("MCP10_CAPABILITY_FAILED");
    for (const pending of rows.pending) {
      if (decided.has(pending.id) || !reader) continue;
      assert.equal(pending.kind, "permission");
      assert.equal(pending.decision_sent, false);
      const effects: any[] = Array.isArray(pending.effects)
        ? pending.effects
        : [];
      const metadata: any = effects
        .map((e: any) => (e.properties ?? e).metadata?.reinlabMcp)
        .find(Boolean);
      assert.ok(metadata);
      const messages = await reader.messages(sessionId),
        tools = messages
          .flatMap((m: any) => m.parts ?? [])
          .filter((p: any) => p.type === "tool"),
        input = tools
          .map((p: any) => p.state?.input)
          .find((v: any) => v?.requestId === metadata.requestId);
      assert.ok(input);
      assert.equal(
        hash({ capability: input.capability, args: input.args }),
        metadata.argsHash
      );
      assert.equal(metadata.capability, input.capability);
      if (metadata.requestId === ids.fetch) {
        assert.equal(input.capability, "papers.fetch");
        assert.deepEqual(
          input.args,
          smokeFetchArguments(tools, ids.search, "W4387156572")
        );
        report.fetchApproval = {
          scope: "once",
          capability: "papers.fetch",
          requestId: ids.fetch,
          argsHash: metadata.argsHash,
          args: input.args,
        };
      } else if (metadata.requestId === ids.write) {
        assert.equal(input.capability, "files.write");
        assert.deepEqual(input.args, fileArgs);
        report.fileApproval = {
          scope: "once",
          requestId: ids.write,
          argsHash: metadata.argsHash,
        };
      } else {
        assert.equal(metadata.requestId, ids.card);
        assert.equal(input.capability, "cards.card.finding");
        const card = input.args.card;
        assert.deepEqual(Object.keys(card).sort(), [
          "confidence",
          "evidence",
          "status",
          "text",
        ]);
        assert.ok(
          typeof card.text === "string" &&
            card.text.trim().length > 0 &&
            card.text.length <= 20000
        );
        assert.ok(["low", "mid", "high"].includes(card.confidence));
        assert.ok(["hypothesis", "supported", "refuted"].includes(card.status));
        assert.ok(
          Array.isArray(card.evidence) &&
            card.evidence.length >= 1 &&
            card.evidence.length <= 64
        );
        for (const anchor of card.evidence) {
          assert.deepEqual(Object.keys(anchor).sort(), [
            "page",
            "paperId",
            "quote",
          ]);
          assert.equal(anchor.page, 1);
          assert.ok(
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              anchor.paperId
            )
          );
          assert.ok(
            typeof anchor.quote === "string" &&
              normalized(anchor.quote).length > 0 &&
              anchor.quote.length <= 300 &&
              normalized(anchor.quote).split(" ").length <= 25
          );
          const page = await db.withAccount(
            session.id,
            async (c) =>
              (
                await c.query(
                  "select page_text from paper_page_read where account_id=$1 and dossier_id=$2 and run_id=$3 and asset_id=$4 and page=$5",
                  [session.id, dossier.id, run.id, anchor.paperId, anchor.page]
                )
              ).rows[0]
          );
          assert.ok(
            page &&
              normalized(page.page_text).includes(normalized(anchor.quote))
          );
        }
        report.cardApproval = {
          scope: "once",
          requestId: ids.card,
          argsHash: metadata.argsHash,
        };
      }
      await api("/v1/approvals/" + pending.id + "/decide", {
        decision: "approve",
        scope: "once",
      });
      decided.add(pending.id);
    }
    report.run = rows.run;
    if (rows.run.ended_at) break;
    await delay(250);
  }
  assert.ok(report.run?.ended_at);
  assert.equal(report.run.state, "completed");
  assert.ok(report.fileApproval && report.cardApproval);
  assert.ok(
    guard.status().forwardCount >= 1 && guard.status().forwardCount <= 6
  );
  const calls = await db.withAccount(
    session.id,
    async (c) =>
      (
        await c.query(
          "select payload->>'capability' capability,payload->>'success' success from event where run_id=$1 and action='capability.call'",
          [run.id]
        )
      ).rows
  );
  report.calls = calls;
  for (const capability of [
    "papers.search",
    "papers.fetch",
    "papers.pages",
    "files.write",
    "cards.card.finding",
  ])
    assert.equal(
      calls.filter((c) => c.capability === capability && c.success === "true")
        .length,
      1
    );
  stage = "browser_card_event";
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:5181");
    // A real browser receives the existing live ledger SSE through the same-origin backend proxy.
    const received = (await page.evaluate(
      `async ({token,dossier})=>{const response=await fetch('/backend/v1/dossiers/'+dossier+'/events?after=0',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});if(!response.ok||!response.body)throw Error('BROWSER_SSE_FAILED');const reader=response.body.getReader(),decoder=new TextDecoder();let text='';const end=Date.now()+20000;try{while(Date.now()<end){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});const lines=text.split('\\n');text=lines.pop()??'';for(const line of lines)if(line.startsWith('data:')){const event=JSON.parse(line.slice(5));if(event.kind==='card'&&event.payload?.cardType==='finding')return{received:true,kind:event.kind,cardType:event.payload.cardType,seq:event.seq};}}return{received:false};}finally{await reader.cancel();}}`,
      { token: session.token, dossier: dossier.id }
    )) as { received: boolean };
    report.browserCard = received;
    assert.equal(received.received, true);
  } finally {
    await browser.close();
  }
  const ledger = await fetch(
    "http://127.0.0.1:3001/v1/dossiers/" + dossier.id + "/audit",
    { headers: { authorization: "Bearer " + session.token } }
  );
  assert.equal(ledger.status, 200);
  await writePrivateEvidence(join(out, "ledger.jsonl"), await ledger.text());
  report.completed = true;
} catch (error) {
  report.failure = {
    stage,
    code: /^[A-Z][A-Z0-9_]+$/.test((error as Error).message)
      ? (error as Error).message
      : "MCP10_ASSERTION_FAILED",
  };
  process.exitCode = 1;
} finally {
  report.guard = guard?.status();
  report.cleanupFailures = await cleanupSmoke([
    {
      name: "guard",
      close: async () => {
        await guard?.close();
      },
    },
    {
      name: "run_resolution",
      close: async () => {
        if (
          db &&
          report.accountId &&
          report.dossierId &&
          report.estimateId &&
          !report.runId
        ) {
          for (const end = Date.now() + 5000; Date.now() < end; ) {
            const rows = await db.withAccount(
              report.accountId,
              async (c) =>
                (
                  await c.query(
                    "select id from run where account_id=$1 and dossier_id=$2 and estimate_id=$3",
                    [report.accountId, report.dossierId, report.estimateId]
                  )
                ).rows
            );
            assert.ok(rows.length <= 1);
            if (rows.length === 1) {
              report.runId = rows[0].id;
              report.resolvedUnknownPostReadOnly = true;
              break;
            }
            await delay(250);
          }
          if (!report.runId) {
            report.submissionIndeterminate = true;
            throw Error("MCP10_SUBMISSION_INDETERMINATE");
          }
        }
      },
    },
    {
      name: "run_cancel",
      close: async () => {
        if (db && !report.completed && report.accountId && report.runId) {
          const terminal = () =>
            db!.withAccount(report.accountId, async (c) =>
              Boolean(
                (
                  await c.query("select ended_at from run where id=$1", [
                    report.runId,
                  ])
                ).rows[0]?.ended_at
              )
            );
          if (await terminal()) return;
          const b = await new BindingStore(db).get(
            report.accountId,
            report.runId
          );
          if (!b.receipt) throw Error("CANCELLATION_INDETERMINATE");
          const r = await createProductionRuntimeFactory(db)(
            report.accountId,
            b.role
          );
          await r.restoreSession(b.sessionId);
          await r.cancel(b.sessionId, b.receipt.runID);
          await pipeline?.reconcileRun(report.accountId, report.runId);
          if (!(await terminal())) throw Error("CANCELLATION_INDETERMINATE");
        }
      },
    },
    {
      name: "temporary_config",
      close: async () => {
        if (configured && db) {
          const current = await createProductionRuntimeFactory(db, {
            readOnly: true,
          })(report.accountId, initialRole);
          await configured.cleanup(current);
          report.gatewayCleaned = true;
        }
      },
    },
    {
      name: "observer",
      close: async () => {
        await pipeline?.shutdown();
      },
    },
    {
      name: "http",
      close: async () => {
        if (server)
          await new Promise<void>((done, fail) =>
            server!.close((error) =>
              error ? fail(Error("MCP10_HTTP_CLOSE_FAILED")) : done()
            )
          );
      },
    },
    {
      name: "control_restore",
      close: async () => {
        if (controlStopped) {
          await startControlProcess({
            script: resolve("tooling/local/control.ts"),
            cwd: paths.root,
            env: environment,
            recordFile: paths.process,
          });
          report.controlRestored = true;
        }
      },
    },
    {
      name: "evidence",
      close: async () => {
        if (db && report.accountId && report.runId)
          report.evidence = await db.withAccount(
            report.accountId,
            async (c) => ({
              run: (
                await c.query(
                  "select state,ended_at,spent_cny::text from run where id=$1",
                  [report.runId]
                )
              ).rows[0],
              usage: (
                await c.query(
                  "select part_id,cost_cny::text,metadata from os_usage where run_id=$1",
                  [report.runId]
                )
              ).rows,
              holds: (
                await c.query(
                  "select state,maximum_cny::text,actual_cny::text from budget_hold where run_id=$1",
                  [report.runId]
                )
              ).rows,
              events: (
                await c.query(
                  "select seq,at,kind,action,payload,cost_cny::text from event where run_id=$1 order by seq",
                  [report.runId]
                )
              ).rows,
            })
          );
      },
    },
    {
      name: "database",
      close: async () => {
        await pool?.end();
      },
    },
  ]);
  if (report.cleanupFailures.length) process.exitCode = 1;
  report.passed = report.completed && !report.cleanupFailures.length;
  report.finishedAt = new Date().toISOString();
  if (lock)
    try {
      await writePrivateEvidence(
        join(out, "report.json"),
        JSON.stringify(report, null, 2) + "\n"
      );
    } finally {
      await lock.release();
    }
  console.log(
    JSON.stringify({
      completed: report.completed,
      passed: report.passed,
      stage: report.failure?.stage,
      forwardCount: report.guard?.forwardCount,
      realModel: true,
    })
  );
}
