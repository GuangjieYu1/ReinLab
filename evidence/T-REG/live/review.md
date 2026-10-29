# T-REG live 原样同步与实跑

结论：新增 live 场景真实运行 **0/1，失败**。ROOT 当前前端缺少自动化看板，第一步查找“看板”tab 10 秒超时；没有 console/page error，未进入 L1 及后续步骤。没有修改前端或场景来规避失败。

已从主仓库逐字节复制 e2e/legacy/README.md 和 scenarios/18-live.mjs；SHA 记录在 sha.json。原 17 场景和 run.mjs 共 18 文件前后 SHA 完全相同。

只读差异：主仓库 AutomationStudio.tsx 包含 board/看板 tab 并有 automation/live/LiveFace.tsx；ROOT 不存在这些 live 组件，src 内搜索 LivePanel/lv-card/看板无命中。浏览器实际 tab 只有编排、节点、运行、维护；boardTabs=0、liveCards=0。详见 page-state.json 和 missing-board.png。

实际运行 ROOT 自有 Vite 127.0.0.1:5198（Node22.23.3），使用原 harness：

```sh
pnpm exec vite --host 127.0.0.1 --port 5198 --strictPort
REINLAB_URL=http://127.0.0.1:5198 E2E_OUT="$PWD/evidence/T-REG/live" node e2e/legacy/run.mjs live
```

完整失败保存在 report.json（退出码1）。由于原场景在 L1 截图前即失败，另用普通 Playwright 同 URL/1440×900/dpr2 只读截图补充 missing-board.png，无改动原 harness。请求源仅本地 Vite 和 Google 字体，无真实模型/控制面请求。自有 Vite 已停止。等待父任务确认缺失前端基线的处理；未从主仓库覆盖前端。

新增规格已只读核对 CODEX_BRIEF_BATCH3_ADDENDUM.md 与 design/HARNESS.md：本批 T-HAR-1/2/5/10；本证据不声称实现 harness，不扩大到网关部署或课堂引擎。
