# B-8：fixture协议与原生出站证明

ToSpec：追加审查B-8。DeepSeek非思考冒烟fixture对两个Flash API别名要求显式thinking.type=disabled；缺失或非disabled以HTTP400和线上相同reasoning_content错误返回。其他role-fixture模型保留其测试协议。此fixture只模拟本次非思考合同，并非完整DeepSeek服务。

ToTDD：先加两个别名各5种非法输入和1种合法输入，旧fixture得到2通过/10失败（red.json）；加强fixture后12/12，连同真实npm OpenScience2.0.150原生SDK→严格守卫→协议fixture共13/13、0失败（green.json）。

native-green/native-catalog.json的outboundRequests截获实际出站JSON（不含headers），明确model=deepseek-flash、thinking={type:disabled}、max_tokens=1024，guard转发1、原生run completed、清理后provider断开。它经过真实SDK配置合并/序列化，不只是看加载配置。全部loopback fixture，无真实key、无真实模型调用。不能将fixture回复当成第二次真实冒烟成功。
