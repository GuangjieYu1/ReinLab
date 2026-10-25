# BATCH7 送审交接

本批功能与本地验证完成，CI终态尚在收尾，最终状态写CI.md。真实模型0调用；不进入P1-14/P1-15。

- 同步前端8文件SHA256：source-hashes.json；只注入live adapter/available=[read]，原样三入口/收件箱/精读。
- research@1.2.0：澄清search-only、cheap、6实际HTTP、每档案0.05硬上限；人工question选择、按公开页数预估/缺失32页明确假设、换篇拒旧报价；正式run先fetch批准，不再search。
- 1.0/1.1冻结；1.1归档与上一个HEAD逐字节一致。六份迁移全部追加、RLS不关闭。
- tests/：Node22/24全量1567/1567，0跳过；独立安全16/16；先构建再测的必需原生33/33，0跳过。浏览器8/8包含真实Supabase/Auth/API/RLS/SSE/原生fixture澄清，正式研究卡片为显式合成。T-REG20/20原报告。
- 凭据39个实际选定值、16账户配置，工作树/证据/Git历史/Codex sessions/logs/shell snapshots/任务日志0命中，见credential-scan.json。含DeepSeek key、实际签名私钥、MCP和新model audience令牌、Hatchet与账户凭据。只覆盖选定当前值；未声称扫描所有历史已轮换凭据或对截图OCR。
- T-MCP-10：原链路fetch待批准中止的事实不改；Claude实际2请求导出核账¥0.00488924，详见T-MCP-10/。本批不执行真实复验；下一次必须新授权、新目录/窗口提交、CI通过后单次执行。
- Q-098用户待决定事项优先：目前无阻断开发的新决定；真实模型体验/第三次T-MCP-10需另行授权。云端统一“云端补验”。追问/评分仍待P2-05/P2-06。

## 复跑

用Node22（另以Node24复跑全量）、pnpm11.5.2、Bun1.3.14；先unset DEEPSEEK_API_KEY，不source任何key。测试DB为55432的pgvector PostgreSQL16；完整本地Supabase为54321/54322。

```sh
node services/account-runtime/build.mjs
pnpm test:native-after-build
pnpm test --reporter=json --outputFile=/tmp/batch7-test-report.json
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json
pnpm exec tsc -p packages/contracts/tsconfig.json
pnpm exec tsc -p services/worker/tsconfig.json
VITE_BACKEND=mock pnpm dev --port 5190
REINLAB_URL=http://127.0.0.1:5190 E2E_OUT=/tmp/reinlab-batch7-treg pnpm e2e:legacy
pnpm local:up
NODE_ENV=test pnpm exec tsx services/control/scripts/verify-read-live.ts
python3 tooling/security/test-scan.py
python3 tooling/security/test-scan-p113.py
```

浏览器脚本只启动loopback fixture模型，实HTTP出站由本批网关拦截。它的正式研究数据合成标记不得删去，不能当真实DeepSeek阅读验收。

实际值扫描：先运行pnpm exec tsx services/control/scripts/prepare-credential-audit.ts（只输出仓库外路径，验证并吊销MCP/model两audience）；将输出file同时传给scanner的--capability-fixture-file与--model-capability-fixture-file，signing/credentialDirectory传对应参数，再传受保护DeepSeek文件、Hatchet setup、root、task-prefix和output。不要打印/上传这些原件，按本机路径调用，报告只含计数。

本机旧fixture试跑留下的失效native会话在复用验证账户时产生OBSERVATION_SCHEDULER_FAILED日志；失败收据未伪装成功，浏览器本轮8项均通过。脚本现会显式取消并保守标记本轮自建澄清fixture，再清理临时内核，避免新增孤儿记录。生产恢复与审批边界未放宽。
