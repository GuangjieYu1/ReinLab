# CI首次红灯与修复

代码0f123c8的push check22在扫描器合成测试处失败，未进入原生测试；矩阵check24随fail-fast取消。红灯：[原始job](https://github.com/GuangjieYu1/ReinLab/actions/runs/40223348745/job/121259470199)。新增model audience实际值合成命中测试要求扫描失败不能返回成功；旧CLI写了status=legacy_hits但退出0，导致断言失败。

修复：保留所有匹配/RLS/权限边界，仅在扫描结果不为passed时返回2（非法配置仍1）。没有删除命中、放宽规则或跳过测试；合成测试失败时只打印布尔检查名。独立安全复核见SECURITY_REVIEW.md追加。真实当前39值扫描passed，0命中；完整扫描报告保留。

7f4f201 的下一轮CI继续发现两个集成问题：Worker allowJs下临时@ts-expect-error变成多余指令；容器漏COPY新增clarify-model.js，MCP容器验证及Hatchet provision因此失败。修复为显式.d.mts类型声明、镜像COPY新插件模块；没有忽略类型错误或跳过真实容器测试。原始链接：check24 https://github.com/GuangjieYu1/ReinLab/actions/runs/40223565759/job/121260116181 ，账户镜像 https://github.com/GuangjieYu1/ReinLab/actions/runs/40223565759/job/121260116101 ，local-stack https://github.com/GuangjieYu1/ReinLab/actions/runs/40223565759/job/121260116031 。
