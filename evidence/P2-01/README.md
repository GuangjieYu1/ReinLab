# 提前P2-01 / SPIKE-3

真实单场景生成已成功，结论采用现有scene-content直连；没有实现生产动画provider或前端接入。

证据：request.json、validation.json（三个400）、live-generation.json（一次真实生成HTTP200，费用未知）、interactive.html原始样本、source/build-manifest.json、browser-test.json与interactive-step.png。原始HTML SHA256=9e0055ea44a640c0eec6bb16cab58e16e9725c66fac8707a55692d609303cc43。独立测试及评审另列。截图来自严格sandbox allow-scripts的独立验证页，非现有前端改版。

Node22复现：
```sh
pnpm exec vitest run tooling/spikes/openmaic.test.ts tooling/spikes/openmaic-independent.test.ts tooling/spikes/probe-evidence.test.ts tooling/spikes/probe-independent.test.ts
node tooling/spikes/openmaic-probe.mjs http://127.0.0.1:3000 # 仅三次缺字段校验，无模型调用
node tooling/spikes/openmaic-viewer.mjs # 本地回环隔离测试页
```

真实重新生成会计费且不是幂等端点，必须显式--generate；已有live-generation.json时脚本拒绝重交。本报告不要求复验方再次付费生成，先核对请求/HTML摘要/浏览器交互；需要新样本时显式使用 `--generate --output evidence/new-sample` 指定另一个干净证据目录并记录实际成本，不能覆盖既有证据或自动重试未知调用。

用户提供的配置仅由临时standalone进程读取，不复制凭据；本机服务已停止。费用和提供方内部调用次数未返回，保持null。没有完整ReinLab运行账本可导出，本SPIKE不是live端到端任务，不伪造账本。三期最终对账仍需实际提供方账单。

可靠性修复：wx原子占位、提交前意图/未知结果、HTML独占保存及failed-to-save。claim-red.json/save-red.json保留修复前红灯；离线CLI故障测试使用模拟fetch且输出仅临时目录，不替代真实API/模型验证。完整原始HTTP JSON未保存，响应形状依据处理观察与源码契约，独立测试对此保留界限。

最终本地复核：本任务21/21、全仓657/657，失败0；独立评审通过。类型、边界、mock构建均通过。250份前端与原目录318份已保存文件清单全部未变（baseline-check.json）。lint-first-failed.json记录独立数值测试最初使用node:vm遭边界拒绝，已改标准输入Node子进程测试，不放宽规则。

独立Linux CI：run39228020915（代码提交9bcded2da7660d0e7fdc1bab3deea3ed0f0bffa3），check/account-image均success。下载artifact并校验ZIP SHA256后保存ci-test-report.json（657通过/0失败）、ci-container-test-report.json（7通过/0失败）；ID/摘要见ci.json。后续收口提交仅增加本批送审文档与CI证据，不改变实现。
