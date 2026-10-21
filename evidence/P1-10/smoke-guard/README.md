# 单次冒烟guard 作者验收

仅本地loopback HTTP fixture与NODE_ENV=test transport；**真实key读取0、真实DeepSeek请求0**。此目录不声称真实冒烟已完成。当前真实来源仍direct_provider_usage，不冒充gateway_callback。

```sh
export PATH=/Users/guangjieyu/.local/share/reinlab/toolchains/node-v22.23.3-darwin-arm64/bin:/Users/guangjieyu/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
pnpm exec vitest run tooling/one-shot-smoke-guard.test.ts --reporter=json --outputFile=evidence/P1-10/smoke-guard/red.json
pnpm exec vitest run services/control/test/runtime-smoke-gateway.test.ts --reporter=json --outputFile=evidence/P1-10/smoke-guard/runtime-red.json
pnpm exec vitest run tooling/one-shot-smoke-guard.test.ts services/control/test/runtime-smoke-gateway.test.ts services/control/test/runtime-observation.test.ts --reporter=json --outputFile=evidence/P1-10/smoke-guard/final-green.json
pnpm exec tsc --noEmit -p services/control/tsconfig.json
pnpm exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --skipLibCheck --types node tooling/local/one-shot-smoke-guard.ts
pnpm lint
git diff --check
```

red16失败/1负例通过；runtime-red9失败。guard-check17/17；stub-still-red是一次本地编辑未成功应用时guard17绿/runtime9仍stub红的中间报告；implementation-check首轮26/26。green/final-green为 **35/35**（guard19+runtime12+既有runtime observation4）。control/tooling strict tsc通过；lint首次process.getuid静态规则红，改用node:process命名导入后复验，不修改边界规则。

覆盖一次固定HTTPS调用、marker O_EXCL0600及file/dir fsync、并发/重启永久拒第二次、非法auth/path/model/cap/n/多模态/servertools拒零forward、有界chunked适配、真实形状SSE/JSON透明传递、client/guard取消、超时未知不重发；真实SDK路径临时auth/config、真实context1048576/output1024/reasoningfalse、无key进入config/返回DTO、已有连接拒绝、raw恢复及auth删除幂等/部分失败只重试清理、reader无管理能力。

priceBound=0.500000只是本批保守预留估算，**不是官方bytes→tokens硬证明或provider硬扣费上限**。bindHost只允许显式loopback/私网IPv4；root负责新专用smoke账号、容器可达私网路由及唯一真实执行。guard本身不读取env/真实credential文件，真实key须仅由guard进程调用者加载，runtime只收到43字符临时token。
