# SPIKE-1：单个会话指定agent（2.0.150）

## 结论

公开`runtime.prompt`固定使用`research`。它的严格输入不接受`agent`，开发header也被显式拒绝。`session.create`没有agent绑定字段，多传该字段会被忽略；不能据HTTP200声称绑定成功。`parts`里的agent mention只保存提及并生成“调用task子agent”的提示，主agent仍是research。

旧`session.prompt`（POST /session/:id/message）支持agent；本次用noReply=true真实保存消息验证选择成功，未运行模型。它没有规格要求的runtime请求收据协议，不能直接替换执行入口。

## 依据

源码checkout `539bff49900b302e3e96df8c50e1668fbd02228e`，相关文件无未提交修改；源码版本及实际npm二进制均2.0.150。摘要见evidence/P1-09/source-manifest.json。

- backend/cli/src/server/routes/runtime.ts：公开路由`const agent = "research"`，拒x-openscience-dev-agent。
- backend/cli/src/runtime/runs.ts：Input从PromptInput选取字段但不含agent，strict；内部admit接受的agent参数不代表公网可传。
- backend/cli/src/session/index.ts：create无agent字段。
- backend/cli/src/session/prompt-input.ts、prompt.ts：旧消息输入支持agent/noReply；mention生成task提示，未重设info.agent。
- backend/cli/src/agent/agent.ts：配置可覆写现有agent属性，defaultAgent只在调用方未指定agent时参与选择。
- 已安装@synsci/sdk/dist/src/v2/gen/types.gen.d.ts：SessionCreateData和RuntimePromptData均无agent；旧SessionPrompt支持agent。

## 验证

`node tooling/spikes/openscience-probe.mjs --require-runtime-agent`先检验“runtime支持agent”假设，实际400，退出1并保留hypothesis-red.json。没有修改上游让该假设通过。

不带该flag重新运行，断言真实合同：创建无绑定、runtime agent拒绝、dev header拒绝、旧消息显式选角色、mention不改主agent、default_agent仅旧路径生效、消息均为user、两独立project的research prompt分别加载。结果见runtime-probe.json。进程只继承PATH和本次随机账户测试令牌；HOME/配置/工作区全部临时，结束清理，不读取用户凭据。noReply跳过生成，未提交任何有效runtime请求，零模型调用。

## 采用方案（进入P1-10前需确认）

保留runtime.prompt与requestID收据，不用旧session.prompt替代。推荐每个角色使用档案内独立`.roles/<roleId>/` project，在该project配置中**覆写research定义**，将角色提示词、模型、steps与工具许可投影到这个别名。真实二进制已证明两个project能分别加载不同research定义；公开runtime选中research的逻辑由锁定路由源码确认。

规格原fallback“把default_agent设为rl-role”对该runtime路由不生效，因为路由已显式传research；不能原样采用。新推荐与原fallback有差异，记录Q-032，交用户/Claude确认后才实现。自定义rl-role定义可保留作角色来源，但不能宣称runtime已按该名字选择。若不接受别名方案，则需要另行讨论受支持执行入口/上游接口，不能擅改内核。

## 边界

本批未实现P1-10，也未证明别名方案下的实际模型生成、角色权限、工具文件隔离或同账户档案隔离；这些必须在翻译层/插件契约与安全测试实跑。目录是配置选择器，不是安全沙盒。Claude尚未对替代方案签核，P1-09整体DoD的验收方确认仍待完成。
