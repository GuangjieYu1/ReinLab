# 交付 · 返工第一批复验：B1 / B2 / B3 与一个观察项

分支 `codex/swarm-4`，一个提交 `ac4e775`。契约没动。前端没动。`services/control + packages + tooling` **883 条全绿**，栈已重起。

## B1（阻塞）成稿工具没注册 —— 已修

- 原因：17 返工那次 `research_narrative` 的注册没落进插件（替换锚点没命中，文件里一个 `narrative` 都没有）。
  负责人只能在推理里说「research_narrative isn't in my function list」，把成稿写进 `team/lead/narrative.md`。
- 现在真正注册进 `installLead`（成员名传 `lead`）。
- **f7bd65fe 的成稿已补交**：把 `team/lead/narrative.md` 写进 `swarm_run.narrative`（11,111 字，21KB 的 UTF-8），
  并把最新一条 `report` 事件里的 `report.narrative` 一起补上；页面刷新就能看到。
  自检：`GET /v1/swarm/runs/f7bd65fe…` 的 `report.narrative` 长度 11111，开头「# 地图能不能当小说/电影/漫剧的共同底座？」。

## B2 核实门禁只拦 negative —— 已扩大

- 现在**任何结论**：核实自己标 `read_completeness=partial`，或理由里出现「截断 / 读不全 / 核不了 / 打不开 / 无法穷举」，
  都不能判 `verified`，一律 409 `VERIFY_NEEDS_FULL_TEXT`，要求改判 `not_verifiable`。
- 否定式结论额外仍要求 `read_completeness=full`。
- **af7b43dc 的 v2 已按新门禁修正**：`verified → insufficient`，`verified_version` 清空，并写了修正理由。
  报告据此变化：`report.verified` 从 17 变 16（快照是实时重算的，刷新即可看到）。
- 测试：新增「非否定式结论 + 读不全」被拒的那条；B1 另有一条「负责人能注册到 research_narrative、队员拿不到」。

## B3 账本要能算钱 —— 已恢复

- 默认用 DeepSeek 峰值费率**估算**（输入 ¥2 / 输出 ¥8 每百万 token），账本重新有金额；
  拿到 opencodego 真实费率后用 `REINLAB_MODEL_INPUT_CNY_PER_MILLION` / `REINLAB_MODEL_OUTPUT_CNY_PER_MILLION` 覆盖，
  这两个是纯粹记账参数，不影响调用。
- 探针运行：13,574 token，`cost = {value: 0.032716, known: true}`。
- 需要你给一个数：opencodego 的实际单价（输入/输出，每百万 token）。给了我就把这轮 103 万输入 / 43 万输出重算一遍。

## 观察项：人设第一句 —— 已改

`SWARM_PERSONA` 第一句原来是「你是 ReinLab 群研的负责人（Team Lead）」，会灌进每个成员的系统提示。
现在是「你是 ReinLab 群研团队的一员」；负责人/队员的身份由团队上下文与任务消息交代。
（这确实不是故意的，是那段文字只写了一份、所有成员共用。）
