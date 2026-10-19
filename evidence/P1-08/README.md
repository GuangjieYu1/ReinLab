# P1-08 账户运行时与Fly provisioner

状态：本地实现经独立测试及第三轮评审通过；整体DoD尚未满足，云三分钟可用、真实Vault/Storage/注册hook/cron待配置验证。没有云项目，不创建付费账户，不用假云结果填补证据。

实现：三包精确锁2.0.150，镜像基底按公开OCI摘要固定。PDF/OCR中英/Python科学包、插件加载入口（工具权限仍为P1-11）、持久/data、结构化就绪、账户Bearer认证IPv6私网代理。上游保持127.0.0.1及Host防护不变。新卷root初始化管理目录后降为UID/GID1000；关闭公网services，常驻东京单机单卷。

控制面以AES-256-GCM加密账户令牌，AAD绑定账户，DEK由Supabase Vault管理，缺Vault即失败关闭。真实PG租约短事务避免池饥饿；持久创建意图及提供方对账避免丢响应后重复建资源，结果未知且无法找到资源时拒绝继续创建。机器对账校验身份/卷/区域/image/services/重启策略/env。升级用持久operation哈希，同操作异内容409；未知结果先GET核对，不重POST。升级和重启中断running与账本同事务。快照私网Bearer读取tar，流式上传专用角色/私有桶，拒运行中/未ready和通用管理员key。

验证：全仓630/630、独立四文件67/67、评审33/33，均退出0。最终行覆盖120/123（97.56%）。原生真实npm运行时6/6：2.0.150、认证/Origin、真实API、真实tar、12MiB慢速备份完整性、重启持久化，零模型调用。类型、依赖边界、mock构建及250项前端哈希另经父任务核对。红灯、独立发现的池饥饿/配置漂移/升级幂等/tar截断及修复历史均保留。

本机Docker内部backend.sock超时，见container-environment.json；不重启共享服务。GitHub CI新增独立Linux镜像job及verify-container.mjs：真实root-owned新卷、降权、OCR/PDF/Python、认证、12MiB慢读和重启持久化。其实际结果另列ci证据，未完成前不宣称容器通过。普通PG不会模拟Vault/Storage扩展；0015只在真实storage表存在时配置桶/RLS，云端仍须复验。

复现（Node22）：
```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm exec vitest run services/control/test/provisioner.test.ts services/control/test/independent-provisioner.test.ts services/control/test/lifecycle.test.ts services/control/test/independent-lifecycle.test.ts
node services/account-runtime/verify-native.mjs
pnpm exec tsc -p services/control/tsconfig.json
pnpm lint
VITE_BACKEND=mock pnpm build
docker build -f infra/fly/account.Dockerfile -t reinlab-account:p1-08 .
node services/account-runtime/verify-container.mjs
```

运维入口及可信身份前提见docs/tasks/P1-08-lifecycle.md。派发层P1-10必须拒绝机器非ready/有效租约；本批不提交模型。注册函数并非公开Webhook认证，夜间CLI并非已经部署的调度器。真正部署后须配置已验证Auth事件和每日任务、提供Storage专用JWT及Vault，测试云端越权与故障后再验收P1-08。

参考：Fly官方Machines/Volumes API https://fly.io/docs/machines/api/machines-resource/ 、https://fly.io/docs/machines/api/volumes-resource/ ；Supabase官方Vault https://supabase.com/docs/guides/database/vault 。上游2.0.150 serve/network/host-guard/global/identity源码只读核对。

CI首轮：Linux镜像构建成功（image sha256:18809d98ecd8478cfb73799d7c1017271371792cd1e48a240fb403cfbbbf7f2d），真实健康通过，但验证脚本的/proc UID正则在模板字符串中丢失反斜线，后续断言失败；container-first-failed.json保留。改用String.raw保留正则后重新实跑，不跳过降权断言。
