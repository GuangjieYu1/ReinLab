#!/usr/bin/env node
// 前端无头回归（T-REG 基线）。前端阶段的 Playwright 脚本整理而来，见 README.md。
//
//   node e2e/legacy/run.mjs              跑全部场景
//   node e2e/legacy/run.mjs au cu        只跑指定场景
//   node e2e/legacy/run.mjs --list       列出场景
//
// 环境变量：
//   REINLAB_URL        被测前端地址，默认 http://127.0.0.1:5173（先 `npm run dev`）
//   E2E_OUT            截图与报告目录，默认系统临时目录下新建
//   PLAYWRIGHT_MODULE  playwright 入口文件路径（项目里没装 playwright 时用）
//   CHROME_PATH        浏览器可执行文件（不设则用 playwright 自带的 chromium）
//   E2E_STRICT_WARN=1  控制台 warning 也算失败（默认只记录）
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = (process.env.REINLAB_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const strictWarn = process.env.E2E_STRICT_WARN === '1';

async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  for (const name of ['playwright', '@playwright/test']) {
    try { return await import(name); } catch {}
  }
  console.error('找不到 playwright。任选其一：\n  1) 项目里装 playwright（pnpm add -D playwright && pnpm exec playwright install chromium）\n  2) 设 PLAYWRIGHT_MODULE=<…/node_modules/playwright/index.mjs>');
  process.exit(2);
}

async function loadScenarios() {
  const dir = path.join(here, 'scenarios');
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs')).sort();
  const list = [];
  for (const f of files) list.push((await import(pathToFileURL(path.join(dir, f)).href)).default);
  return list;
}

const args = process.argv.slice(2);
const scenarios = await loadScenarios();
if (args.includes('--list')) {
  for (const s of scenarios) console.log(`${s.id.padEnd(8)} ${s.title}`);
  process.exit(0);
}
const unknown = args.filter(a => !scenarios.some(s => s.id === a));
if (unknown.length) { console.error('未知场景：' + unknown.join(', ') + '（--list 查看）'); process.exit(2); }
const selected = args.length ? scenarios.filter(s => args.includes(s.id)) : scenarios;

try {
  const r = await fetch(base + '/');
  if (!r.ok) throw new Error('HTTP ' + r.status);
} catch (e) {
  console.error(`前端没有在 ${base} 上运行（${e.message}）。先启动：npm run dev`);
  process.exit(2);
}

const out = process.env.E2E_OUT ?? path.join(tmpdir(), 'reinlab-legacy-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });

const results = [];
for (const s of selected) {
  const dir = path.join(out, s.id);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: s.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: s.deviceScaleFactor ?? 2 });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], warnings = [], notes = [], shots = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  const ctx = {
    page, dir,
    url: p => base + p,
    shot: async name => { const file = String(name).replace(/[^\w.-]/g, '_'); await page.screenshot({ path: path.join(dir, file) }); shots.push(file); },
    note: (...v) => notes.push(v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
  };
  const t0 = Date.now();
  let failure = null;
  try { await s.run(ctx); } catch (e) { failure = String(e?.stack ?? e).split('\n').slice(0, 6).join('\n'); }
  await context.close();
  const ok = !failure && errors.length === 0 && (!strictWarn || warnings.length === 0);
  results.push({ id: s.id, title: s.title, status: ok ? 'passed' : 'failed', durationMs: Date.now() - t0, failure, errors, warnings, notes, shots });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.id.padEnd(8)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${s.title}`);
  if (failure) console.log('      ' + failure.split('\n')[0]);
  for (const e of errors.slice(0, 3)) console.log('      console/page error: ' + e.slice(0, 200));
}
await browser.close();

const report = {
  schemaVersion: 1, base, startedAt: new Date().toISOString(), strictWarn,
  total: results.length, passed: results.filter(r => r.status === 'passed').length,
  failed: results.filter(r => r.status === 'failed').length, results,
};
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${report.passed}/${report.total} 通过。报告：${path.join(out, 'report.json')}`);
process.exit(report.failed ? 1 : 0);
