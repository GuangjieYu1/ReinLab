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
const out = process.env.REINLAB_EVIDENCE_OUT ?? "/tmp/reinlab-p113-live-e2e",
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
    approval = randomUUID(),
    oldMemory = randomUUID();
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
    await c.query("insert into memory_item(id,account_id,layer,key,value)values($1,$2,'L4','manual-review-0','\"此前人工条目\"')", [oldMemory,account]);
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
              ...(i === 0 ? { supersedes: oldMemory } : {}),
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
  await page.getByPlaceholder("PASSWORD", { exact: true }).fill(users.A_PASSWORD);
  await page.getByRole("button", { name: /REQUEST/ }).click();
  await page.getByLabel("邮箱", { exact: true }).waitFor({ state: "detached" });
  await page.evaluate(async () => {
    const modulePath = "/src/nav.ts";
    const { navigate } = await import(modulePath);
    navigate('/?preview=workbench&studio=research');
  });
  const dialog = page.getByRole("dialog", { name: "上线时待批准" });
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.locator('[name="demonstration-key"]').count(), 0);
  await page.screenshot({
    path: join(out, "inbox-pending.png"),
    fullPage: true,
  });
  results.push({ name: "real_login_pending_grouped_inbox", passed: true });
  const row = (n: number) => dialog.locator('.ibx-row').filter({ hasText: 'manual-review-' + n });
  const select = async (n: number) => { await row(n).click(); };
  const decided = (n: number) => dialog.locator('.ibx-row[data-done]').filter({ hasText: 'manual-review-' + n }).waitFor();
  await select(0);
  await dialog.locator('.ibx-old s').filter({hasText:'此前人工条目'}).waitFor();
  results.push({name:'referenced_superseded_memory',passed:true});
  await dialog.locator('.ibx-ev button').first().click();
  await dialog.locator('.ibx-quote q').filter({ hasText: '已人工核对的来源对话' }).waitFor();
  results.push({ name: 'source_event_evidence_opened', passed: true });
  await dialog.locator('.ibx-actions .is-solid').click(); await decided(0);
  await select(1); await dialog.getByRole('button', { name: /^改一下再批准/ }).click();
  await dialog.getByLabel('修改：manual-review-1', { exact: true }).fill('用户修改后的内容');
  await dialog.getByRole('button', { name: '保存并批准', exact: true }).click(); await decided(1);
  await select(2); await dialog.getByRole('button', { name: /^驳回/ }).click(); await decided(2);
  await select(3); await dialog.getByRole('button', { name: /^只存本档案/ }).click(); await decided(3);
  const action = dialog.locator('.ibx-row').filter({ hasText: '人工审批验证' });
  await action.click(); await dialog.getByRole('button', { name: /^批准这一次/ }).click();
  await dialog.locator('.ibx-row[data-done]').filter({ hasText: '人工审批验证' }).waitFor();
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
  // Preserve Claude's interaction: refresh on reopen, and auto-open only after >30 min away.
  await dialog.getByRole('button', { name: /稍后处理/ }).click();
  const extra = randomUUID();
  await db.withAccount(account, c => c.query(
    "insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at)values($1,$2,$3,'L4.knowledge',$4,'重新打开待处理',now()+interval '1 day')",
    [extra,account,run,JSON.stringify([{key:'重新打开待处理',value:'人工验证条目',evidence:[eventRef]}])],
  ));
  await page.getByRole('button', { name: /^收件箱/ }).click();
  await dialog.locator('.ibx-row').filter({hasText:'重新打开待处理'}).click();
  await dialog.getByRole('button',{name:/^驳回/}).click();
  await dialog.locator('.ibx-row[data-done]').filter({hasText:'重新打开待处理'}).waitFor();
  results.push({name:'manual_reopen_refresh',passed:true});
  await dialog.getByRole('button',{name:/稍后处理/}).click();
  const away = randomUUID();
  await db.withAccount(account,c=>c.query(
    "insert into promotion(id,account_id,from_run,target_layer,items,reason,expires_at)values($1,$2,$3,'L4.knowledge',$4,'回前台待处理',now()+interval '1 day')",
    [away,account,run,JSON.stringify([{key:'回前台待处理',value:'人工验证条目',evidence:[eventRef]}])],
  ));
  await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'))");
  await page.clock.fastForward(31*60_000);
  await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'))");
  await dialog.waitFor({state:'visible'});
  await dialog.locator('.ibx-row').filter({hasText:'回前台待处理'}).click();
  await dialog.getByRole('button',{name:/^驳回/}).click();
  await dialog.locator('.ibx-row[data-done]').filter({hasText:'回前台待处理'}).waitFor();
  results.push({name:'foreground_refresh_after_thirty_minutes',passed:true});
  await page.reload();
  await page.getByRole('region',{name:'账户登录'}).waitFor();
  results.push({name:'reload_requires_memory_session_login',passed:true});
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
