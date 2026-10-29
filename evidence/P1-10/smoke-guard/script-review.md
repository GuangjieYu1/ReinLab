# 单次冒烟脚本静态复核

2026-10-21，独立测试角色。未执行smoke-local.ts、未读取私有env/真实key、未调用真实模型。Node v22.23.3，smoke-plan12+guard19+真实SDK本地配置12=43/43，见script-review-green.json。

只读核对services/control/scripts/smoke-local.ts：生成持久专用Auth身份，经真实production factory、HTTP确认run、RuntimePipeline及RLS SQL观察；模型调用前保存RUN_KEY；固定marker跨重启拒第二实际POST。真实key只传guard，runtime仅43字符随机token；临时auth/config有finally cleanup，不输出key/headers。401可达性预检不消耗marker；账号/目录/Docker路由前置条件不成立时应失败关闭。priceBound0.5为保守预留，不作为官方bytes硬token/账单保证。

发现并已通知root：脚本原先只确认ended、已知usage和settled hold，未断言run.state=completed，可能把带已知费用的failed/cancelled终态写成completed=true。最终真实执行前须补成功状态断言。本文件记录初次静态发现，不声称该脚本已完成真实冒烟；后续作者修订由root保留验证记录。

复验（仅安全纯测试）：`pnpm exec vitest run tooling/smoke-plan.test.ts tooling/one-shot-smoke-guard.test.ts services/control/test/runtime-smoke-gateway.test.ts`。本次JSON筛自156/156定向组合运行。生产脚本需由root在用户授权的唯一真实请求窗口运行；测试不加载该脚本。

作者随后已加run.state=completed断言，并将getuid改命名导入；我只读确认改动，control tsc和全仓边界lint复验通过。原发现已关闭，不影响一次forward围栏。
