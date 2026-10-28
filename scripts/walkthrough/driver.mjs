// 人工验收驱动：起一个录屏的浏览器，开本地 HTTP 口让 Claude 一步步操作（像真人一样用），关闭时出录像。
// 用法：PLAYWRIGHT_MODULE=… node scripts/walkthrough/driver.mjs --out <目录> [--port 7788]
// 接口（POST JSON）：/goto {url} /click {text|sel, nth?} /fill {sel, value} /press {key} /type {text}
//   /wait {ms|sel} /shot {name} /text {sel} /eval {js} /caption {html} /close
import http from 'node:http';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/walk'), PORT = Number(arg('port', '7788'));
mkdirSync(join(OUT, 'shots'), { recursive: true }); mkdirSync(join(OUT, 'raw'), { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: join(OUT, 'raw'), size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
const loc = b => b.sel ? page.locator(b.sel).nth(b.nth ?? 0) : page.getByText(b.text, { exact: !!b.exact }).nth(b.nth ?? 0);
const caption = h => page.evaluate(h => { let el = document.getElementById('wt-cap'); if (!el) { el = document.createElement('div'); el.id = 'wt-cap'; el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;max-width:1100px;padding:10px 16px;background:#141213ee;color:#f0eeea;font:500 15px/1.5 system-ui,sans-serif;border-left:4px solid #ff7a1a'; document.body.appendChild(el); } el.innerHTML = h; el.style.display = h ? 'block' : 'none'; }, h).catch(() => {});
const ops = {
  goto: b => page.goto(b.url, { waitUntil: 'domcontentloaded' }),
  click: b => loc(b).click({ timeout: b.timeout ?? 15000 }),
  fill: b => page.locator(b.sel).nth(b.nth ?? 0).fill(b.value),
  press: b => page.keyboard.press(b.key),
  type: b => page.keyboard.type(b.text),
  wait: b => b.sel ? page.locator(b.sel).first().waitFor({ timeout: b.ms ?? 30000 }) : page.waitForTimeout(b.ms ?? 1000),
  shot: b => page.screenshot({ path: join(OUT, 'shots', (b.name ?? Date.now()) + '.png') }).then(() => 'saved'),
  text: b => page.locator(b.sel ?? 'body').first().innerText({ timeout: 5000 }).then(t => t.slice(-(b.tail ?? 3000))),
  count: b => page.locator(b.sel).count(),
  eval: b => page.evaluate(b.js),
  caption: b => caption(b.html ?? ''),
  close: async () => { await ctx.close(); await browser.close(); const v = readdirSync(join(OUT, 'raw')).find(f => f.endsWith('.webm')); if (v) renameSync(join(OUT, 'raw', v), join(OUT, 'video.webm')); setTimeout(() => process.exit(0), 200); return 'closed'; },
};
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', async () => {
    const op = req.url.slice(1); let r;
    try { r = { ok: true, result: await ops[op](body ? JSON.parse(body) : {}) }; } catch (e) { r = { ok: false, error: String(e.message || e).split('\n')[0] }; }
    res.end(JSON.stringify(r) + '\n');
  });
}).listen(PORT, '127.0.0.1', () => console.log('driver ready', PORT));
