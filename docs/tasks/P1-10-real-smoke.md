# P1-10 本地真实冒烟 ToSpec / ToTDD

仅显式执行 `services/control/scripts/smoke-local.ts` 才可能请求真实模型，普通 test/CI 不执行。配置来自已有受保护 runtime.env 与用户指定的 ~/.config/reinlab/local.env；只将 DEEPSEEK_API_KEY 放入临时单次透明转发守卫，账户 OpenScience 只持随机临时 token。marker 位于私有状态目录，转发前 fsync，一旦存在不再执行冒烟。

使用全新真实 Supabase Auth 账户及 provisioner Docker 容器，默认生产 RuntimePipeline、生产角色工厂、真实 JWKS、真实 models.dev 估算，HTTP 在 loopback 临时端口提供相同 Hono 路由。创建研究档案、核对清单有效配置、准备最紧1步角色并配置临时凭据；确认运行预算1元。API Idempotency-Key 及账户意图在请求前持久保存。无 fixture provider / 注入模型 / 假用量。完成后导出该运行账本、os_usage 和预算收据；守卫与 SDK 配置清理，无条件保留单次 marker。

价格窗口必须由操作者在执行前依据账户 CNY 与官方 peak/offpeak 规则明确传入；脚本只校验有效区间，不推断节假日。默认拒绝过期、超长、跨执行窗口的计划。原生用量不可核对则如实保留 unknown，不重试模型。守卫的0.5元是保守预留估算，不宣称 byte/token 的官方数学界限；最终费用以原生用量、官方价目与后台账单核对。

ToTDD：无真实网络的纯计划校验先红后绿，覆盖固定模型/汇率/币种、有效短窗口、拒绝过期/未知字段/扩步或扩预算。guard 和 Runtime 配置独立 SDK HTTP fixture 已有测试，另交子 agent 复核。真实冒烟须等待原生 pipeline 稳定阻断关闭、guard 独立审查通过后才执行，且只一次。
