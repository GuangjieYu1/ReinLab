# 交付 · 广度复测返工（D1–D6）

分支 `codex/swarm-4`，一个提交 `d1d0b3c`。契约没动。前端 `src/data/swarm-live.ts`、`SwarmMode.tsx`、`swarm.css` 我没碰。
`services/control + packages + tooling` **887 条全绿**，栈已重起。

## D1（阻塞）搜索全部 401 —— 已修

- 根因：`registerWebToolsProxy` 用的是 `providerKey`，而 `providerKey` 在换网关后指向 opencodego 的 key；
  DeepSeek 的 search/fetch 只认官方 key。
- 现在搜索/抓取固定用宿主官方 `DEEPSEEK_API_KEY`，与模型网关的 `REINLAB_MODEL_*` 分开配置。
  实测：官方 key 打 `POST /v1/tools/search` 返回 200（World Anvil 的条目）。
- 报错不再回显 key：上游任何 `sk-…` / `oc_sk_…` / `****xxxx` 片段一律替换成 `<key>`；
  事件表里 6 处残留也已清理（按 payload 全文正则替换，共更新 242 行）。

## D3 到限之后还在开新活 —— 已修

`registerMeta`（`research_task` 落库那一步）现在是：运行状态属于
`near_limit / awaiting_review / done / partial / unresolved / cancelled / failed`，
**或** 轮数 `round >= limit_rounds` 时，新增任务直接 409 `LIMIT_REACHED`：
「到限了…不再新增任务。要接着做，先让用户批准追加额度，或直接收尾出报告。」
成员登记（`kind=member`）不受影响。

## D4 选「按有争议写入」后不收尾 —— 已修

`swarm_divergence` 卡驳回（= 按「有争议」写入）现在会：
把运行置为 `partial`、`end_reason=user_wrote_disputes`、写 `ended_at`，
补一条收尾说明、重发报告与运行快照，然后 `settleDeliveries`。不再挂在 `awaiting_review` 等用户点结束。
（批准仍=再查一轮，逻辑没变。）

## D5 反驳满 2 轮后死锁 —— 已修

两处放宽：
1. **未解决反驳只看这一版最新的一条**：反驳者后来更正（`rejected`）或撤回，那条旧 `upheld` 就不再挡核实。
2. **两轮上限只算成立的反驳**：`rejected/withdrawn` 这类更正不计轮次、也不受上限阻挡（`refute_rounds` 同步不增）。
新增测试：两轮反驳成立 → 核实被拦 → 反驳者更正撤回 → 核实通过。

## D6 内核事件接口太重 —— 已加限制

`GET /v1/kernel/runs/:id/events` 新增：
- `limit`（默认 **200**，最多 1000）；
- `actions=a,b,...`（最多 20 个）按 action 过滤；
- 返回 `hasMore` 表示后面还有。

实测（fe243151）：`limit=5` → 5 条、**10.6KB**；`actions=turn/start,assistant/message&limit=50` → 50 条且全部命中这两个 action。
前端只要设 `actions=turn/start,turn/end,assistant/message&limit=200`，单次体积会降到原来的百分之一量级。

## D2 覆盖视图 → 已改成「不看工具也看得到」（用户 2026-11-06 定：做）

- **契约新增两个字段**：`SwarmSnapshot.coverage?`、`SwarmReport.coverage?`，类型都是
  `SwarmCoverage = { checkedTotal, mentionedTotal, note, axes: [{ routeId, title, checked[], mentioned[] }] }`。
- **快照里现算**：`GET /v1/swarm/runs/:id` 直接带 `coverage`（与 `report` 同级），页面不用等负责人调工具。
  每轴最多列 30 个名字，`note` 是一句可以直接显示的话。
- **报告里也带**：`report.coverage`，正式报告本身能看出广度；`report.gaps` 里仍会写「提到但没查证的名字」。
- **涨了才提醒**：`submitResearch` 里比较「提到但没查」总数，累计涨 ≥5 才给负责人发一条 `bus`
  （水位存 `swarm_run.coverage_mentioned`，同一批名字不会重复提醒）。
- 抽名与归轴的两个实测修正：`swarm_approach` 的列名是 `route_id`（之前按 `id` 取，名字全落进「未归到路线」）；
  证据现在按「哪些结论引用它」归轴；引号里的整句界面文案（>12 字或带句读）不再当名字。
- 实测 f7bd65fe 之外的最新一条复测 `fe243151`：`checkedTotal 556 / mentionedTotal 43`，
  三条路线各 30 个已查名字、13/12/18 个提到没查。

## D2 原方案（已被上面的实现取代）

我的判断：`research_coverage` 是**又一个要主动调的工具**，负责人正在赶进度时不会想到它。所以我建议**不靠调用，直接把它算进快照和报告**：

1. **快照里常驻**：`GET /v1/swarm/runs/:id` 增加 `coverage`（与 `report` 同级），
   内容是 `{ checkedTotal, mentionedTotal, axes: [{ routeId, title, checked, mentioned }] }`，
   每次快照现算（数据量很小，实测几百条证据也只是一次查询）。页面在侧栏或汇总面加一块「覆盖」。
2. **报告里带一行**：`report.gaps` 已经把「提到但没查的名字」算进去了（广度批已做）；
   再加 `report.coverage`（计数 + 每轴前 8 个名字），这样正式报告本身能看出广度。
3. **只在必要时提醒**：当 `mentionedTotal` 比上次快照**增加 ≥5**，发一条 `bus` 系统消息给负责人
   （「覆盖：在 X、Y 上被提到但还没有证据指向」）。同一条不重复提醒。

要动契约的地方只有两处（`SwarmRunSnapshot.coverage?`、`SwarmReport.coverage?`），你说可以我就按这个做。

## 观察：页面底部费用比账本低

快照里的费用是**每次现算**（`sum(usage_record.cost_cny)`，未知就标未知），不存在缓存或延迟。
运行中那次「¥4.91 vs ¥8.15」更可能是页面没收到最新的用量事件——它和 D6 是同一个病根（事件接口被拖垮、轮询丢事件）。
D6 修好后建议再看一次；如果还偏低，我再顺着前端的取值路径查（需要 Claude 说明页面底部读的是哪个字段）。
