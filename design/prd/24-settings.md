# 24 · 设置页 · 体验结论与契约（Claude，2026-11-07）

为什么现在做：
- 模型写死在后端：默认 `deepseek-v4-flash`，创作台画路线用的是 `deepseek-chat`。用户 DSH 那边用的是 `deepseek-v4.1-flash`，而群研的对比说明，模型低一代会直接拉低质量。
- 创作台 MVP-2 要接火山方舟出图，平台得能在页面上切换。
- 花费只在账本和状态栏里零散地记着，没有一个地方能统一看。

## 1. 用户能做什么

| 区块 | 看到 / 能做 |
|---|---|
| 平台 | 每个平台（DeepSeek 官方、opencodego、火山方舟……）一行：key 已配置 / 未配置、能用的模型、最近一次调用成功了没有。**页面不收 key**：key 只能由用户写进 `~/.config/reinlab/local.env`，页面上只写清楚要加哪一行（变量名），不显示 key 的值 |
| 模型分配 | 按「工作台 → 角色」列出来，比如：研究台的群研负责人、研究员、反驳、核实，精读；探索台的计划助手；创作台的设定顾问、写作助手、画路线；课程台……每一项一个下拉框，选「平台 · 模型」。有一个「默认模型」，没单独设的就用它。改完马上生效，**正在跑的任务不换**，下一次新开的才用新模型 |
| 出图 / 视频 | 出图平台、视频平台各选一个（MVP-2 以后才用得上，先能选、能保存） |
| 花费 | 本月 / 上月 / 自定义时间段：总额，按工作台、按用途（群研、精读、画路线……）、按模型分开；能点到具体某一份档案。用量未知的单独计数，不算成 0。数据来自 `usage_record` |

不做：预算拦截（只记不拦，用户定的）、多用户和团队权限、在页面上填 key。

## 2. 接口（DSH）

| 方法 | 路由 | 说明 |
|---|---|---|
| 读设置 | `GET /v1/settings` → `Settings` | |
| 改分配 | `PUT /v1/settings/models { assignments, default }` | 校验模型属于一个已配置的平台；否则 422 `MODEL_UNAVAILABLE` |
| 改出图 / 视频 | `PUT /v1/settings/media { image, video }` | |
| 试一下 | `POST /v1/settings/providers/:id/ping` → `{ ok, latencyMs, error? }` | 发一次最小请求，不花或只花极少的钱 |
| 花费汇总 | `GET /v1/usage/summary?from=&to=&groupBy=bench\|purpose\|model\|dossier` → `{ rows: { key, label, cost: Cny, calls, unknown }[], total: Cny }` | |

```ts
type Provider = { id: string; name: string; envVar: string; configured: boolean; models: { id: string; label: string; kind: 'chat' | 'image' | 'video' }[]; lastOk?: Iso | null; lastError?: string | null };
type Assignment = { bench: Bench; role: string; label: string; model: { provider: string; id: string } | null };   // null = 用默认
type Settings = { providers: Provider[]; default: { provider: string; id: string }; assignments: Assignment[]; media: { image: string | null; video: string | null } };
```

后端要把现在写死的模型（`REINLAB_KERNEL_MODEL`、群研各角色、创作台画路线）都改成从设置里读，环境变量只当兜底。设置按账户存。

## 3. 前端

- 入口：全站左上角菜单加一项「设置」；工作台状态栏的「花费」点过去，直接打开花费区块。
- 样式沿用莱茵视觉：表格、细线、墨黑字。key 状态只写「已配置 / 未配置」，加上要写进 `local.env` 的那一行（只有变量名和 `=`，不带值）。
- 改分配后显示「下一次新任务生效」。

## 4. 验收

- 把群研的研究员换成 `deepseek-v4.1-flash`，新开一次群研，`usage_record` 里记的就是新模型；正在跑的那一次不受影响。
- 在 `local.env` 里删掉一个平台的 key 并重启，页面显示「未配置」，选它的模型时会被拒绝。
- 花费汇总和 COST_LEDGER 里的数对得上。
