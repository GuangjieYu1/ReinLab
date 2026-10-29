# SPEC · 第 3 项 工具与插件规范（隔离环境内基础工具全开）

日期：2026-10-30。依据：[PRD 02 第 3 项](../prd/02-foundation.md)。
分支：`codex/tools-3`（从 `main` 起）。

## 1. 现状（已核对）

| 事实 | 位置 |
|---|---|
| 论文抓取按来源域名白名单拒绝，公网 OA 也会 `PAPERS_EGRESS_DENIED` | `services/control/src/mcp/paper-http.ts` |
| 已有公网地址校验（私网/回环/链路本地/保留段）与跳转后复查、跳数上限 | 同上 `publicIPv4` / `get` |
| 执行环境是 `image: "host"`，内核跑在宿主 | `tooling/local/up.ts` |
| DSH 基础工具（bash 等）由 profile 补丁关闭 | `plugins/reinlab-read-plugin/restrict.patch.yml` |

## 2. 切分（按 PRD 顺序，不一次混成交付）

### 片一（本轮已做）：取消来源域名白名单

- 去掉「主机名必须在名单里」的判定，公网论文来源与正常跳转不再因域名被拒。
- **保留**全部环境边界：必须 `https`、端口只允许 443、不得带用户名/密码、不得是字面 IP；
  解析出的每个地址必须通过公网校验；跳转后的目标重新校验；跳数上限 4。
- 不删环境隔离，也不因此打开 bash。

测试：`services/control/test/mcp-papers.test.ts` T-MCP-7 改为验证「不在名单的公网来源可取、
私网/明文/带凭据/字面 IP 仍拒、跳转有上限」。

### 片二：每账户独立容器（进行中）

- DSH 在每账户容器里跑，账户间不共享可写卷；正式执行不回退宿主模式。
- 当前档案工作区在容器内可读写；已批准材料快照只读；正式数据库与权威产物目录不挂载为可写。
- Provider key 继续只存在控制面宿主机进程，不进容器文件/环境/argv/日志；容器用限定身份凭据调模型代理。

**已做（本轮）**：
- `services/control/src/kernel/container.ts`：容器启动规格（纯函数，可测）——只挂当前账户根
  （可写）与运行令牌（只读）；`--read-only` 根、`--cap-drop ALL`、`no-new-privileges`；
  误传的 Provider/基础设施凭据按名单剔除；宿主专用路径（`.ssh`、`.config/reinlab`、
  `docker.sock`、`.codex`）由 `assertSpecSafe` 兜底拒绝。6 条测试覆盖这些边界。
- `infra/account/Dockerfile`：账户镜像定义（node22 + 解析工具 + 内核 shim/插件依赖）。
- `services/control/src/kernel/container-lifecycle.ts`：确保/复用/回收（docker 动作可注入，5 条测试）。
  已存在且在跑就复用（容器里的工作草稿要留住），没在跑先清掉再按同一规格重建。

**已实测（本机，2026-10-30）**：
- 镜像可以构建成功；镜像内 `@deepseek-ai/dsh@0.2.1-rc.4` 就位（`/opt/reinlab/node_modules/@deepseek-ai/dsh/lib/bin.js`）。
- 以 `--read-only --cap-drop ALL --security-option no-new-privileges` 起容器后，基础工具全部可用：
  `bash`、`grep`、`python3 3.11.2`、`pdftotext`、`node v22.23.4`。这是片三「基础工具全开」的前提。
- 容器内有公网访问（registry.npmjs.org 返回 200）。
- 现有 `shim.mjs`/`launch.ts` 的容器传输路径仍完整（`docker exec`），不需要重写。

**下一步**：把容器生命周期接到内核启动，并把 `REINLAB_KERNEL_TRANSPORT` 切到 `container`。
需要改的地方已定位：`launch.ts` 目前只设了 `SHIM_CONTAINER/SHIM_RUN_ID/SHIM_PID_FILE/SHIM_DSH_MODULE`，
容器模式还缺 `SHIM_HOST_ROOT`、`SHIM_CONTAINER_ROOT` 与容器内的 dsh 模块路径；
`dshHome`/`cwd` 等写进 plan 配置的路径也要换成容器内路径（`materializeLaunch` 要按模式生成）。

### 片三：基础工具开放与两条写入底线

- 容器内 DSH 基础工具全开（web_search/web_fetch/bash/grep/文件读写），不再用工具隐藏约束方法。
- 工作草稿与中间文件自主写；**正式入档或档案外动作**由受控工具提交并需一次批准。
- 正式存储不暴露为 bash 可直接改写的目录或数据库。
- 上线后不再保留旧的逐次下载审批，也不叠加同一成果的重复入档审批。

### 片四：课程台最小插件

- 学习目标 → 沟通与必要调查 → 提交简短学习计划 → 收件箱同意或改 → 正式写入课程计划 + 完成报告。
- 计划确认与入档可用同一次批准覆盖。不做完整备课链、课堂生成、考核。

## 2b. 已定：本机代理与论文来源（用户 2026-10-30 选 A）

本机开着 TUN 代理时，公网域名被解析成 fake-IP `198.18.0.0/15`，宿主侧 SSRF 防护会（正确地）拒绝，
所以真实论文下载与 T1 验收都要在**关掉代理由真实 DNS** 的情况下做。**不放宽 SSRF 边界**、不为代理段开例外。
这条只影响验收环境，不影响实现。

## 3. 不做

产物存储重建、模型分档、共享记忆、七台完整功能、持久登录、固定模型验收脚本。

## 4. 交付

每片：改动 + 针对性测试 + 真实模式验证。整项完成后交 Claude，按 T1–T5 验收。
