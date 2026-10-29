# 新版前端基线同步与 T-REG

结论：**18/18 通过**，原 17 场景全部保持通过，新增 live 也通过；没有修改场景找绿。逐场景调用原 run.mjs，每个进程失败即停止后续场景。完整聚合结果 report.json。

范围：只同步主仓库 src/ 与 e2e/legacy/。ROOT-only 文件为零；新增 automation/live 下 5 文件，已有源码仅 AutomationStudio.tsx 不同。源 scripts 的 5 key 与 ROOT 完全相同，因此 package.json 无需写入；ROOT 后端 test/lint/db/local 命令和全部依赖保留。未触碰主仓库、design、ios、promo。

仓库外旧基线备份：`/Users/guangjieyu/.codex/reinlab-baseline-refresh-s_ml731h`，含 src、e2e/legacy、scripts.json。before.json 记录同步前 ROOT/源每文件 SHA 和差异；after.json 记录同步后源/目标 SHA。final-verification.json 再核对测试结束时源 tree 与初始逐文件完全一致、目标逐字节一致，scripts 同样未变。

测试环境：Node22.23.3，ROOT 自有 Vite http://127.0.0.1:5198，Playwright 无头 Chromium；无真实模型调用或真实账户资源操作。执行 `node e2e/legacy/run.mjs <id>`，REINLAB_URL 指向该私有端口，E2E_OUT 指向仓库外每场景目录。自有 Vite 完成后停止。

全部截图及每场景原始 report：`/Users/guangjieyu/.codex/reinlab-treg18-dbo6wbzh`，仓库内只收聚合报告、完整截图哈希和 df/au/rs/live 代表截图。此前缺看板的有效失败记录 evidence/T-REG/live 保留，本次通过不覆盖它。
