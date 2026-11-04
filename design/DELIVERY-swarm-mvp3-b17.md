# 交付 · 群研 B17（结果卡）+ 四处小问题

分支 `codex/swarm-3`，一个提交。契约 13 没改；前端 `64fbe63` 没动。**用现有的运行 `c47beab1` 与委托 `efe3f613` 复现就行，没有另花钱**（这批复用数据、零模型调用）。

## B17 四条

1. **查看不再升版本**：`refreshResultCard` 先算「内容指纹」（去掉 version 后的整份结果），和库里上次存的比；
   一样就原样返回、不动版本。`GET /v1/delegations/:id` 连看三次，`resultVersion` 一直是 4。
2. **同一张卡更新、版本递增**：卡片的 `effect_key` 改成 `delegation_result:<delegationId>`（不带版本），
   重复回调走 `on conflict … do update set title/effects`，所以永远只有一张卡躺在收件箱里。
   （历史上按版本插出来的第 1/2/3 版已作废，现在只有「第 4 版」这一张。）
3. **决定之后把卡关掉**：`decideDelegation` 现在会 `update approval … set state=approved|rejected, decided_scope='once'`
   —— 采用 = approved，不采用 = rejected。实测卡状态从 `pending` 变 `approved/once`。
4. **同一版本重复决定幂等**：已经用同一决定处理过就直接返回（**卡照样关掉**），不再往源档案记第二条。
   实测：决定一次 → 账本 +1；再点一次 → 账本不变。

## 四处小问题

- **分歧卡的 `sides` 带上双方内容**：现在是 `["主张：<结论正文前 160 字>", "反驳：<那条成立的反驳理由>"]`。
  现有那张分歧卡 `9555456f` 已按这个格式重算好（直接刷新可见）。
- **`fromBench` 不再是 "undefined"**：`delegation` 表加了 `from_bench` 列并在发起时写入；`GET /v1/delegations/:id`
  现在返回 `exploration`。
- **结果卡 `effects[0]` 去掉 `account`**：卡面只剩契约 §6 的字段（`delegationId/version/outcome/claims/evidence/
  limits/openQuestions/href/runId/researchDossierId/artifacts`）。
- **精读运行带上选中的论文**：`run.input` 现在写 `query`（论文标题）与 `chosenPaperId`；
  `GET /v1/kernel/runs/:id` 也**新增返回 `chosenPaperId`**（之前接口不返回它，前端拿不到）。
  现有精读运行 `8b3fbb98` 已补齐：`query = "Can LLM Agents Really Debate? A Controlled Study"`、
  `chosenPaperId = arXiv:2511.07784`。

## 怎么验（都用现成数据）

1. 打开委托 `efe3f613`（源档案 `35f6dadc`，探索台）：连续刷新几次，`version` 不变；
   `fromBench` 显示 `exploration`；结果卡只有一张「群研结果：第 4 版」，`effects[0]` 里没有 `account`。
2. 点「采用」：卡从收件箱消失（状态 `approved`），源档案只多一条「采用了群研…」；
   再点一次「采用」：不再新增记录。
3. 打开首例运行 `c47beab1` 的分歧卡 `9555456f`：每条的 `sides` 是「主张：…」「反驳：…」两段真内容。
4. 精读运行 `8b3fbb98`：`GET /v1/kernel/runs/:id` 有 `query` 与 `chosenPaperId`，页面应显示「已选好这篇」。

## 验证

`services/control` + `packages`：**608 条全绿**。新增一条覆盖：查看不升版本、同一委托只有一张结果卡、
决定后关卡、同版本重复决定不重复记账。
