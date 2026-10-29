# CI首次红灯与修复

代码0f123c8的push check22在扫描器合成测试处失败，未进入原生测试；矩阵check24随fail-fast取消。红灯：[原始job](https://github.com/GuangjieYu1/ReinLab/actions/runs/40223348745/job/121259470199)。新增model audience实际值合成命中测试要求扫描失败不能返回成功；旧CLI写了status=legacy_hits但退出0，导致断言失败。

修复：保留所有匹配/RLS/权限边界，仅在扫描结果不为passed时返回2（非法配置仍1）。没有删除命中、放宽规则或跳过测试；合成测试失败时只打印布尔检查名。独立安全复核见SECURITY_REVIEW.md追加。真实当前39值扫描passed，0命中；完整扫描报告保留。

7f4f201 的下一轮CI继续发现两个集成问题：Worker allowJs下临时@ts-expect-error变成多余指令；容器漏COPY新增clarify-model.js，MCP容器验证失败；Hatchet恢复报告也失败，当时尚未取得详细报告，不能归因于同一个问题。修复为显式.d.mts类型声明、镜像COPY新插件模块；没有忽略类型错误或跳过真实容器测试。原始链接：check24 https://github.com/GuangjieYu1/ReinLab/actions/runs/40223565759/job/121260116181 ，账户镜像 https://github.com/GuangjieYu1/ReinLab/actions/runs/40223565759/job/121260116101 ，local-stack https://github.com/GuangjieYu1/ReinLab/actions/runs/40223565759/job/121260116031 。

本机收尾一次全量同时遇到账户镜像Bun构建与类型检查，2例在默认5秒测试限时结束（各约5010ms，无断言差异）；未调整超时/worker数/断言，构建完成后将最终Node22/24全量串行执行。旧JSON留在本机/tmp/reinlab-b7-final-node22.json，新正式报告以delivery命名。

取得bb98347的CI报告后确认恢复测试失败是AssertionError：测试经真实API创建了默认1.2档案，却继续断言1.1。修复仅为旧恢复fixture显式加载冻结1.1并在自身账户插入1.1测试档案，同时新增真实API默认1.2断言；不改生产默认版本、人工选择守卫或旧恢复断言。原报告stage过粗，现补legacy_fixture_setup阶段。

同一修复在本机完整Supabase/Auth/Docker/Hatchet验证通过9/9，fixture模型，真实模型0调用；新档案默认1.2.0、旧恢复fixture钉1.1.0均实查。报告见recovery/report.json。Node22和24无重叠构建的最终全量各1567/1567，0失败/跳过。
