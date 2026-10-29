# P1-08 本地化：完整Supabase CLI + Docker账户

ToSpec（2026-10-20）：按DEFERRED与第三批说明，CLI启动真实Auth、Storage、Vault及其数据库/API；不以裸Postgres冒充。Auth注册触发账户和持久provision job，专用非特权worker身份领取；应用连接仍严格RLS。凭据只进本地mode600文件/真实Vault与账户私有运行时，不进入仓库/日志/证据。快照继续使用专用Storage身份，不以service_role代替。一个账户一个Docker容器和具名卷，Fly保留独立驱动，云端统一「云端补验」。

ToTDD：配置/凭据文件安全负例先红灯；驱动协议与边界先红灯（另见P1-08-local-driver.md）；在真实CLI栈注册两个账户，验证Auth触发器→持久队列→实际容器健康、Vault信封及专用快照桶写入/未授权读取拒绝。完整命令pnpm local:up，验收pnpm local:verify，所有输出仅安全摘要。外部环境失败不得改为fixture通过。

环境选择：共享DockerDesktop的容器列表（含受控label过滤）15秒超时，既有PG保持运行。使用独立Colima profile reinlab、明确DOCKER_HOST，不改默认context，不重启/清理共享Docker；宿主16GiB RAM/15GiB空闲，先限定VM 4CPU/4GiB RAM/12GiB稀疏数据盘，禁自动删除非本项目资源。资源不足按事实记录，不放宽验证。
