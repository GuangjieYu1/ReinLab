# 交付 · 群研广度（B4）①②③ + 两处顺手修

分支 `codex/swarm-4`，一个提交。契约只加了下面两个字段。前端由 Claude 接。

## ① 证据记来路

**契约新字段**
- `Evidence.discovery?: "search" | "known-url" | "citation"`
- `SwarmReport.discoveryCounts?: { search, knownUrl, citation, unknown }`（就是「各类数量」，页面显示「发现类 search / 共 M」）

**怎么判（不问模型，不靠提示词）**
控制面在转发模型请求时已经能看到搜索与抓取：
- `search` → 搜索结果里出现过的 URL（写进 `swarm_source_hit`，kind=search）
- `citation` → 已抓页面正文里的外链（kind=citation）
- `known-url` → 都没命中（早就知道、直接抓的）
证据交上来时按 `source.ref` 归一化（去协议/尾斜杠/查询串、小写）去比这张表；表为空就是 `known-url`。
老数据没有这个字段，报告里计进 `unknown`（f7bd65fe 的 151 条证据就是这个情况）。

## ② 负责人的覆盖视图 `research_coverage`

- 新工具（只给负责人）：返回按**计划里的几条路线**（问题被拆成的几个轴）分组的
  - `checked`：已经有证据指向的名字；
  - `mentioned`：在结论里被提到、但没有任何证据指向的名字。
- 这些「提到但没查」的名字会自动进 `report.gaps`（每轴一行，最多 6 行、每行 8 个名字，避免把缺口冲爆）。
- **名字怎么抽**（不调模型，三组保守规则）：
  1. 拉丁专名：2–4 个首字母大写的词（World Anvil / Aeon Timeline）；单个驼峰、全大写缩写或长首字母大写词（OpenStreetMap / OSRM / Wikidata）；
  2. 中文名：`《…》「…」“…”` 里的，以及「数字+中文」的产品名（51码字）；
  3. 词表过滤：The/This/Figure/Table/Section/AI/LLM 等常见词不当名字。
- **怎么归轴**：证据挂在哪条路线的结论上，名字就归那条路线；没证据的名字按它出现在哪条路线的结论里归轴；归不上的单列「未归到路线」。

样例输出（形状）：

```json
{
  "axes": [
    { "routeId": "r1", "title": "产品盘点",
      "checked": ["World Anvil"],
      "mentioned": ["Aeon Timeline", "OnlyWorlds", "51码字"] },
    { "routeId": "r2", "title": "对照与反证", "checked": [], "mentioned": [] }
  ],
  "checkedTotal": 1,
  "mentionedTotal": 3,
  "note": "有 3 个名字在结论里被提到、但没有任何证据指向它们。"
}
```

## ③ 让搜索比 curl 划算

- **一次多个 query**：`web_search` 的请求体可以带 `queries: ["…","…"]`（最多 5 条），控制面并行发、合并去重，**结果上限 20 条**（原来是单次几条）。
- **同域名反复抓取给提示**：同一个运行里第 3 次及以后抓同一个域名，`web_fetch` 的返回里多一个 `hint` 字段：
  「这个域名（xxx）在本次运行里已经抓了第 N 次；如果是在找『还有谁在做这件事』，换用 web_search 或换一个来源更省时间。」
  ——只提示，不拦；bash / curl 不受任何限制。

## 顺手修

**a) 审查记录的判定和结论状态对不上**
- `swarm_review` 加两列：`corrected_from`（原判定）、`correction_reason`（为什么改）。
- af7b43dc 那条核实记录：`verdict` 由 `verified` 改成 `not_verifiable`，`corrected_from='verified'`，
  `correction_reason` 写明「核实者自己写了『核不了/打不开』、read_completeness=partial」。
  结论状态本来就是 `insufficient`，现在两边一致了。

**b) 缓存读要算钱**
- 计价公式加上缓存读：`(输入×输入单价 + 输出×输出单价 + 缓存读×缓存单价) / 1M`。
- 缓存单价默认 **¥0.02/百万 token**，可用 `REINLAB_MODEL_CACHE_READ_CNY_PER_MILLION`（或 `MODEL_CACHE_READ_CNY_PER_MILLION`）覆盖；
  输入/输出单价仍用 `REINLAB_MODEL_INPUT_CNY_PER_MILLION` / `REINLAB_MODEL_OUTPUT_CNY_PER_MILLION`。
- **f7bd65fe 的账已重算**：621 次调用、输入 1,028,954、输出 426,156、缓存读 63,628,928 →
  **¥6.7397**（含缓存读）。下一轮新跑的账会自动带上缓存读。

## 验证

`services/control + packages + tooling`：**885 条全绿**（新增：来路三分类、覆盖视图抽取与缺口、报告里的 discoveryCounts）。
栈已重起，两个迁移已应用。
