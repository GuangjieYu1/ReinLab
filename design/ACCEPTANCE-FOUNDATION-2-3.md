# 验收交接：第 2、3 项（2026-10-30）

两项各自独立分支，请**分别验收**，不要混在一起。依据：[PRD 02](prd/02-foundation.md)、
[WORKFLOW](WORKFLOW.md)。spec：[第 2 项](SPEC-lifecycle-2.md)、[第 3 项](SPEC-tools-3.md)。

## 共通环境要求

- **先关掉 TUN 代理**，用真实 DNS（`dig +short arxiv.org @1.1.1.1` 应返回真实公网地址，
  不是 `198.18.x.x`）。否则任何论文下载都会被正确的 SSRF 防护拒绝——这不是缺陷。
- 起栈命令都在统一 checkout 根目录：`/Users/guangjieyu/Documents/DeepSeekPlugin/ReinLab`。
- 页面：<http://127.0.0.1:5183>，原账号登录。

---

## 第 2 项 · 运行生命周期

**分支**：`codex/lifecycle-2`（从 `main` 起）

```
git switch codex/lifecycle-2
pnpm local:up --real-models
```

### 已改的三条（PRD 2.8 点名要去掉的）

1. 插件不再轮询等人：需要用户决定时把请求交给控制面就返回，这一轮结束。
2. 等待时执行段真的让出：任务记 `waiting`，租约释放、进程退出。
3. 回答/批准/驳回按同一会话续接，Agent 继续执行。
4. 业务时限 **24 小时**（用户定）：超时关闭请求并把任务按中断收尾，留原因。
5. 起栈时自动核对残留（`LOCAL_RECONCILED`），把上一轮已无执行体的任务补成中断。
6. 新增 `GET /v1/reports`：任务终态、原因、已有成果数量，供收件箱展示报告。

### DSH 已在真实栈验证的

| 项 | 证据 |
|---|---|
| 等待释放执行段 | `state=waiting`、`lease=released`、1 张待批卡 |
| 等待中重启栈 | run 仍 `waiting`、卡仍 `pending`；启动核对没误杀 |
| 回答后续接 | 同一 run `waiting`→`running`，事件 47→94，最终 `completed` |
| 完成报告可读 | `/v1/reports` 返回状态、原因（含「服务重启后这一段执行已不在，可以重试」）与成果数量 |
| 页面与收件箱同源 | 两者都读 `/v1/approvals`，不存在两份批准记录 |

### 请 Claude 按 L1–L6 验收（PRD 2.7）

重点：**L2**（离开页面后请求仍在、不因等待十分钟变拒绝）、**L3**（在收件箱回答后原任务续上）。

一句话说明：等待不再是「拖满十分钟就失败」；人不在时任务让出执行资源，回来还能接上。

---

## 第 3 项 · 工具与插件规范

**分支**：`codex/tools-3`（从 `main` 起）

```
git switch codex/tools-3
REINLAB_KERNEL_TRANSPORT=container pnpm local:up --real-models
```

第一次起容器模式会自动检查账户镜像（`reinlab-account:local`），缺失则构建（约 1 分钟）。

### 已改

1. **取消论文来源域名白名单**：公网来源与正常跳转不再因域名被拒；边界保留——必须
   https、不带凭据、解析地址必须是公网（私网/回环/保留段拒绝）、跳转后重新校验、跳数上限 4。
2. **每账户独立容器**：dsh 跑在容器里，只挂当前账户的工作区与会话目录（可写）与运行令牌
   （只读）；容器以只读根 + `cap-drop ALL` + `no-new-privileges` 运行，并以宿主 uid 跑。
3. **基础工具全开**：容器模式只禁 `subagent*`/`workflow` 这类自派生 agent 的工具，
   `bash/grep/glob/read/write/edit/web_search/web_fetch` 全部可用。
4. **两条写入底线**（用户选 A）：工作区下载、解析、草稿、讲解卡与发现卡自主写；
   **一篇论文正式入档批一次**，卡片文案是「把这篇论文正式入档」。
5. **课程台最小能力**：`courses.plan` + `course_plan` 工具 + `GET /v1/courses/plans`；
   用户同意的那一次批准**同时**完成计划确认与入档，不重复索要。

### DSH 已实测

- 镜像可构建，内含 `@deepseek-ai/dsh@0.2.1-rc.4`
- 加固容器内 dsh 可运行；`bash/grep/python3/pdftotext/node` 可用
- **隔离**：`/Users`（宿主源码树）、`/root/.ssh`、`/root/.config/reinlab`（Provider 配置）、
  `/var/run/docker.sock`、其他账户目录 —— 全部不可达
- 容器模式跑完一轮：`run=completed`，模型工具集含 bash 等，且**实际调用了 bash**
- 模型调用走控制面代理，Provider key 不在容器里

### 请 Claude 按 T1–T5 验收（PRD 3.7）

### 两个需要你先判断的事

1. **行为变化**：开放基础工具后，实测模型会用 `bash` 而不是 `papers_fetch`，于是那一轮
   可能**没有讲解卡产出**。这符合「方法由 Agent 自己决定」，但会让精读质量取决于模型选择。
   请按 T1/T2 判断是否可接受——**不作规定**是纲领要求，我不会在提示词里限定路线。
2. **课程台页面入口**：PRD 3.6 明确由 Claude 提供真实页面入口，DSH 没有代造。
   `/v1/courses/plans` 已就绪，接口给你接页面。

在以上两条有结论前，**默认 transport 保持 host**，容器模式按需用环境变量打开。

---

## 本轮不做

第 4 项（档案模型）、第 5 项（登录会话）待 grill；产物存储、模型分档、共享记忆、
QQ/微信/Muse 均不在范围内。
