# T-REG 独立测试

结论：**17/17 全部通过，退出码 0**。页面异常及 console.error **0**，warning **0**；原 runner 报告截图 **134 张**，核对磁盘上原始 PNG **134 张**（350,943,303 bytes）。场景耗时合计 440,861ms。未修改 runner、场景或前端，未运行全仓测试。

环境：分支 `codex/t-reg-legacy`，mock dev 服务由主任务预先启动于 `http://127.0.0.1:5181`。Node **v22.23.3**，Playwright **1.64.1**，浏览器 **Google Chrome 155.0.8059.82**（headless）。

精确命令（工作目录 `/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`）：

```sh
PATH=/Users/guangjieyu/.npm/_npx/52027bd8fc0022aa/node_modules/.bin:$PATH REINLAB_URL=http://127.0.0.1:5181 CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' E2E_OUT=/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab/evidence/T-REG pnpm e2e:legacy
```

通过场景：`df`、`au`、`gx`、`ex`、`cu`、`rq`、`dev`、`tst`、`onto`、`rd`、`sw`、`rs`、`cr`、`nv`、`vf`、`trip`、`trip-en`。没有失败复跑或放宽断言。

完整性核对：运行前后，`e2e/legacy` 的 **19 个文件**逐个 SHA256 均与主仓库 `/Users/guangjieyu/Documents/DeepSeekPlugin/ReinLab/e2e/legacy` 一致。前端 **252 个 tracked 文件**（`src`、`public`、`index.html`、`vite.config.ts`）运行前后逐个 SHA256 不变，且相对 HEAD 无 diff。该文件集的排序 JSON 哈希摘要为 `38813a4da880a5c0cf5285a2dbcfc1601703721bbe0f75738f353ff9f75bc81f`。逐文件核对记录见 `independent-integrity.json`。

原始运行报告：`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab/evidence/T-REG/report.json`。

初始完整截图位置：`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab/evidence/T-REG/<场景 id>/*.png`。以上数量与完整性核对均在本次运行结束、主任务整理归档之前采集。主任务后续会记录完整原图归档位置及仓库内保留的代表截图；本说明不声称全部 134 张原始图都提交入库。未执行 git add、提交或截图清理。

范围：验证现有 mock 前端的 17 条流程及原 runner 的错误/断言规则；不包含截图像素比较、live 后端或本地化验收。
