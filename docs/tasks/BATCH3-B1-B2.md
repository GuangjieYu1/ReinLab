# 第三批中期审查收口

按主仓库 BATCH3_INTERIM_REVIEW.md：先修 B-1 并提交，再修 B-2；真实模型必须等待用户确认新的冒烟计划。已有前置失败 provider forwards=0、bytes=0、usage为空，保留失败运行与账本，不重提原 requestID。

## B-1 ToSpec / ToTDD

真实 npm 2.0.150 空账户测试已红：添加临时 auth 后 provider connected 含 deepseek，但可用 models 不含用户固定的 deepseek-v4-flash。源码 provider.ts 的配置模型继承 catalog status，随后过滤 deprecated；官方价格页明确旧路由仍受理、按 Flash 计费。使用上游正式支持的模型 id 映射：逻辑路由仍 deepseek/deepseek-v4-flash，API id 显式 deepseek-flash，继承同一实际模型的可用目录记录（不修改上游、不换产品路由、不虚改模型状态）。在创建任何会话/prompt 前读取真实 provider 列表，确认别名/API id、1024输出限制实际生效；provider.list 会主动隐去 endpoint，所以另以受信新账户 raw config 核对临时端点；失败恢复原配置并删除临时 auth，不消耗一次转发标记。

先运行已有 runtime-smoke-native 红灯，再跑 SDK 配置与原生最小回合绿灯；测试只用本机 fixture，不读取真实 key。本轮不执行 smoke-local.ts。

## B-2 ToSpec / ToTDD

resolver 对用户 patch 的每个实际叶字段先核对清单 tunable，未列入（含空数组、相同值、混合请求）一律400，不静默剔除。通配符只匹配一个路径段；预算 budget.* 明确覆盖已知预算子树。`:tighten_only` 保留直接收紧、放宽需要控制面审批的既有合同，不授权清单未列字段。白名单通过后仍跑原权限/预算/底线校验，审批不能绕过白名单。

研究台不新增 tunable 来规避缺陷；write_targets、memory、dossier_note 当前均拒绝。原用于通用能力测试的这些字段改用明确声明了对应 tunable 的测试清单，同时新增研究台负例与真实HTTP400、事务零副作用验证。涉及安全边界，完成后只对此范围安排独立评审。B-3 以文档说明写目标子目录按首次受权写入创建，不更改已发布清单内容/版本摘要。
