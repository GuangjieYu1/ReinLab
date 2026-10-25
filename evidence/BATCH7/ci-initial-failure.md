# CI首次红灯与修复

代码0f123c8的push check22在扫描器合成测试处失败，未进入原生测试；矩阵check24随fail-fast取消。红灯：[原始job](https://github.com/GuangjieYu1/ReinLab/actions/runs/40223348745/job/121259470199)。新增model audience实际值合成命中测试要求扫描失败不能返回成功；旧CLI写了status=legacy_hits但退出0，导致断言失败。

修复：保留所有匹配/RLS/权限边界，仅在扫描结果不为passed时返回2（非法配置仍1）。没有删除命中、放宽规则或跳过测试；合成测试失败时只打印布尔检查名。独立安全复核见SECURITY_REVIEW.md追加。真实当前39值扫描passed，0命中；完整扫描报告保留。
