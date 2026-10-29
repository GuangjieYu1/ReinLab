# 中期修复后回归

Node22.23.3、Node24.14.1各1284/1284，0失败/跳过，报告与摘要同目录。文件worker最多4；原5秒默认timeout及全部断言保持，不设重试/跳过。

保留两次红：first-full-b2-fixture-red.json为两处旧definition fixture仍修改未开放字段，改用明确声明tunable且单独发布版本的测试bench，未扩研究台白名单；definition-fixture-green.json12/12。default-worker-timeout-red.json为9worker全量中三项既有预算用例触及5秒，单文件budget-isolated-green.json28/28；控制资源后完整1284全绿，未把单文件绿冒充全量。

全量之后只加强已有native smoke测试：真实SDK请求先穿过真实单次守卫、再由testOnlyTransport到本机fixture，两个Node版本均1/1。该后续仅测试变更无生产变更，CI将完整复跑新测试。真实DeepSeek调用仍0，需用户确认SMOKE_PLAN。
