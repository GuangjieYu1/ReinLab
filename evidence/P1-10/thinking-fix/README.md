# B-6 / B-7 / B-8 修复与第二次冒烟准备

本轮ToSpec以主仓库BATCH3_INTERIM_REVIEW.md「追加（2026-10-22）」为准。仅修复显式关闭思考、严格守卫和fixture协议，新增独立的第二次入口；**未执行第二次真实冒烟，等待用户重新明确授权**。P1-10未关闭，未进入P1-11。

- B-6：118d1d0；11绿/2红→17/17绿。模型options明确thinking disabled并验证生效；原生wire字段证明见B-6/README.md。
- B-7：a3f4466；32绿/1红→33/33绿，独立35/35、0失败、P1/P2发现0，见B-7/independent/REVIEW.md。严格要求字段存在，拒绝不消费marker。
- B-8：a40f25f；2绿/10红→协议12+原生1=13/13绿。B-8/native-green/native-catalog.json保存fixture截获的真实SDK出站体，包含thinking disabled、model deepseek-flash、输出1024。不是只核配置加载。
- 固定第二次入口：19绿/1红→20/20绿（second-authorization-*.json），default保留旧目录，只有精确second-authorization选新固定目录；无任意路径/第三次选择。独立只读接线评审已通过。
- 最新Node22.23.3/Node24.14.1各1347/1347，0失败、0跳过，见regression/；依赖边界、契约/控制面/本地up与真实CLI类型检查、mock构建全部通过（static-checks.json），只有既有chunk体积警告。前端/legacy不改。
- 第二次计划见[SECOND_SMOKE_PLAN.md](SECOND_SMOKE_PLAN.md)。本轮readiness仅stat专用凭据文件（0600），旧marker存在、新目录及admission未创建，见authorization-readiness.json。真实模型请求0。

所有历史红报告和第一次失败/unknown费用原样保留。普通测试只使用loopback provider/临时fixture token，勿将它们当成live回复或后台费用证据。最新CI全终态在PR #16描述记录，避免为自引用CI再生提交。
