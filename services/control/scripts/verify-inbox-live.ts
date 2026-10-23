import { appendEvent } from "../src/ledger";
/** Real local Supabase/Auth/API/browser; synthetic user-entered review data, zero models.
 * No HAR/trace/video/login screenshots, no credential values in reports or thrown messages.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { chromium } from "playwright";
import { readRuntimeConfiguration } from "../src/configuration";
import { Database } from "../src/db/database";
import { localPaths } from "../../../tooling/local/paths";
import { readPrivateEnv } from "../../../tooling/local/config";
const paths = localPaths(),
  config = readRuntimeConfiguration(paths.runtime),
  users = await readPrivateEnv(join(paths.state, "verification-users.env"));
const out = process.env.REINLAB_EVIDENCE_OUT ?? "/tmp/reinlab-p112-live-e2e",
  base = "http://127.0.0.1:5181";
await mkdir(out, { recursive: true });
const pool = new pg.Pool({ connectionString: config.DATABASE_URL_APP, max: 2 }),
  db = new Database(pool),
  browser = await chromium.launch({ headless: true });
const results: { name: string; passed: boolean }[] = [];
let token = "",
  account = "",
  dossier = "",
  run = "",
  eventRef = "";
try {
  const login = await fetch(base + "/backend/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify({ email: users.A_EMAIL, password: users.A_PASSWORD }),
    redirect: "error",
  });
  assert.equal(login.status, 200);
  const value = (await login.json()) as {
    accountId: string;
    accessToken: string;
  };
  account = value.accountId;
  token = value.accessToken;
  results.push({ name: "real_supabase_login_proxy", passed: true });
  const ids = Array.from({ length: 4 }, () => randomUUID()),
    approval = randomUUID();
  dossier = randomUUID();
  run = randomUUID();
  await db.withAccount(account, async (c) => {
    await c.query(
      "insert into dossier(id,account_id,bench,title,workspace_path)values($1,$2,'research','P1-12 人工审阅验证',$3)",
      [dossier, account, "/data/dossiers/" + dossier],
    );
    await c.query(
      "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny)values($1,$2,$3,'research-read','read',$4,'running',1)",
      [run, account, dossier, randomUUID()],
    );
    const source = await appendEvent(c, account, {
      dossierId: dossier,
      runId: run,
      roleId: "research-read",
      kind: "message",
      action: "user_verified",
      payload: { text: "已人工核对的来源对话" },
      dedupeKey: randomUUID(),
    });
    eventRef = "event:" + source.seq;
    for (const [i, id] of ids.entries())
      await c.query(
        "insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at)values($1,$2,$3,'L4.knowledge',$4,$5,now()+interval '1 day')",
        [
          id,
          account,
          run,
          JSON.stringify([
            {
              key: "manual-review-" + i,
              value: "人工录入审阅条目",
              evidence: [eventRef],
            },
          ]),
          "人工审阅验证 " + i,
        ],
      );
    await c.query(
      "insert into approval(id,account_id,run_id,kind,title,effects,risk)values($1,$2,$3,'permission','人工审批验证',$4,'write')",
      [
        approval,
        account,
        run,
        JSON.stringify({
          operation: "approval.request",
          subject: "仅记录本次人工决定",
          effects: ["写入批准收据"],
        }),
      ],
    );
  });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  await page.clock.install();
  await page.goto(base + "/?preview=workbench&studio=research");
  await page.getByLabel("邮箱", { exact: true }).fill(users.A_EMAIL);
  await page.getByLabel("密码", { exact: true }).fill(users.A_PASSWORD);
  await page.getByRole("button", { name: /LOG IN/ }).click();
  const dialog = page.getByRole("dialog", { name: "上线时待批准" });
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.locator('[name="demonstration-key"]').count(), 0);
  await page.screenshot({
    path: join(out, "inbox-pending.png"),
    fullPage: true,
  });
  results.push({ name: "real_login_pending_grouped_inbox", passed: true });
  const card = (n: number) =>
    dialog.locator(".rh-approval").filter({ hasText: "人工审阅验证 " + n });
  await card(0).getByRole("button", { name: eventRef, exact: true }).click();
  await card(0)
    .getByRole("region", { name: "来源对话依据" })
    .getByText("已人工核对的来源对话", { exact: false })
    .waitFor();
  results.push({ name: "source_event_evidence_opened", passed: true });
  await card(0).getByRole("button", { name: "批准上线", exact: true }).click();
  await card(0).waitFor({ state: "detached" });
  await card(1)
    .getByRole("button", { name: "修改后批准", exact: true })
    .click();
  await card(1)
    .getByLabel("上线内容 1", { exact: true })
    .fill("用户修改后的内容");
  await card(1).getByRole("button", { name: "提交修改并批准" }).click();
  await card(1).waitFor({ state: "detached" });
  await card(2).getByRole("button", { name: "驳回", exact: true }).click();
  await card(2).waitFor({ state: "detached" });
  await card(3)
    .getByRole("button", { name: "仅存本档案", exact: true })
    .click();
  await card(3).waitFor({ state: "detached" });
  const a = dialog.locator(".rh-approval").filter({ hasText: "人工审批验证" });
  await a.getByRole("button", { name: "批准", exact: true }).click();
  await a.waitFor({ state: "detached" });
  results.push({
    name: "four_promotion_actions_and_once_approval",
    passed: true,
  });
  await db.withAccount(account, async (c) => {
    const p = await c.query(
      "select status from promotion where id=any($1::uuid[]) order by array_position($1::uuid[],id)",
      [ids],
    );
    assert.deepEqual(
      p.rows.map((v) => v.status),
      ["approved", "edited", "rejected", "kept_local"],
    );
    const m = await c.query(
      "select layer,dossier_id,value from memory_item where account_id=$1 and key like 'manual-review-%' and evidence @> $2::jsonb",
      [account, JSON.stringify([eventRef])],
    );
    assert.equal(m.rowCount, 3);
    assert.equal(
      m.rows.filter((v) => v.layer === "L4" && v.dossier_id === null).length,
      2,
    );
    assert.equal(
      m.rows.filter((v) => v.layer === "L2" && v.dossier_id === dossier).length,
      1,
    );
    assert(m.rows.some((v) => v.value === "用户修改后的内容"));
  });
  const audit = await fetch(
    base + "/backend/v1/dossiers/" + dossier + "/audit",
    { headers: { authorization: "Bearer " + token } },
  );
  assert.equal(audit.status, 200);
  const ledger = await audit.text();
  assert(!ledger.includes(token));
  await writeFile(join(out, "ledger.jsonl"), ledger);
  await page.screenshot({
    path: join(out, "inbox-decided.png"),
    fullPage: true,
  });
  results.push({ name: "real_rls_memory_and_ledger", passed: true });
  // Foreground refresh: add one explicit rejection-only review, then exercise visibility event.
  const extra = randomUUID();
  await db.withAccount(account, (c) =>
    c.query(
      "insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at)values($1,$2,$3,'L4.knowledge','[]','回前台待处理',now()+interval '1 day')",
      [extra, account, run],
    ),
  );
  await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await dialog.getByText("回前台待处理", { exact: true }).waitFor();
  results.push({ name: "foreground_refresh", passed: true });
  await dialog
    .locator(".rh-approval")
    .filter({ hasText: "回前台待处理" })
    .getByRole("button", { name: "驳回", exact: true })
    .click();
  const idle = randomUUID();
  await db.withAccount(account, (c) =>
    c.query(
      "insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at)values($1,$2,$3,'L4.knowledge','[]','久置待处理',now()+interval '1 day')",
      [idle, account, run],
    ),
  );
  await dialog.getByRole("button", { name: "稍后处理" }).click();
  await page.clock.fastForward(330000);
  await dialog.getByText("久置待处理", { exact: true }).waitFor();
  results.push({ name: "visible_idle_interval_refresh", passed: true });
  await dialog
    .locator(".rh-approval")
    .filter({ hasText: "久置待处理" })
    .getByRole("button", { name: "驳回", exact: true })
    .click();
  await dialog.getByRole("button", { name: "退出账户" }).click();
  await page.getByRole("region", { name: "账户登录" }).waitFor();
  await db.withAccount(account, (c) =>
    c.query(
      "update run set state='completed',ended_at=now() where id=$1 and account_id=$2 and not exists(select 1 from os_binding where run_id=$1)",
      [run, account],
    ),
  );
  await context.close();
} catch {
  results.push({ name: "live_browser_or_infrastructure", passed: false });
  process.exitCode = 1;
} finally {
  await browser.close();
  await pool.end();
  const report = {
    realInfrastructure: true,
    syntheticReviewData: true,
    modelRequests: 0,
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
