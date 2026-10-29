# P1-12 账户凭据集成独立安全复核

日期：2026-10-23；工作树`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`。本轮仅安全评审，未修改实现，未执行旧账户迁移。

## 结论

**本轮安全边界通过。** 发现并即时反馈的同镜像迁移未知结果误判问题已修复，独立回归通过。正式native产物的首次网络鉴权、原Host/Origin/cross-site边界及真实插件SDK内部transport路径已实际验证。该结论不替代Docker完整镜像构建与真实旧账户迁移、Fly交付、模型功能或全部业务验收。

## 已关闭发现：同镜像迁移不能仅靠镜像相等判定成功

初审发现：旧ENV机器迁移如果保持镜像tag不变，第一次update在变更前失败，operation变为indeterminate；同op重试原逻辑只比较镜像相等，可能把仍为旧ENV的机器标记applied。

修复：operation对账分支额外拒绝`migrateCredentials && legacyMachine`；只有文件凭据和目标ENV已被观察到且身份/部署形态匹配时才applied。

独立测试`services/control/test/lifecycle-credential-security-review.test.ts`真实测试PG验证：首次合成pre-mutation update失败→同op保持indeterminate、update仍仅一次→合成机器切换为匹配文件凭据/无旧ENV后才完成对账。1/1通过。初次执行的fixture清理误删父account触发FK错误，已修正为先清operation/secret/machine再account；最终执行通过。没有删除或迁移真实账户。

## 亲自实际执行

所有shell均login:false，先unset DEEPSEEK_API_KEY，Node使用任务指定22.23.3 PATH。未读取真实.env/key/容器Env，未用浏览器，未执行模型或真实账户迁移。

1. 定向命令：`vitest run services/control/test/account-credential-writer-security-review.test.ts services/control/test/lifecycle-credential-security-review.test.ts services/control/test/docker-driver.test.ts -t 'runtime credential writer|credential migration same-image|旧ENV机器只准显式迁移'`：3文件、3/3通过，8项按筛选跳过。
2. 新writer独立测试：leaf symlink和hardlink均固定错误拒绝，目标sentinel未被truncate；正常重复写可读且0600，ENV无合成凭据。
3. Docker协议合成fixture：旧ENV机器普通list拒绝，仅显式迁移可观察；其他凭据替换在任何mutation前拒绝；迁移后只读文件配置且保留账户卷。
4. 正式native：运行`dist/account-runtime/reinlab-openscience`原serve CLI、随机临时端口（非4096/4097），独立0700 HOME/XDG/config/data/state目录，0600合成凭据文件，ENV只含路径/ID/禁用自动更新与外部获取标志。脚本`/tmp/reinlab-p112-formal-native-security.mjs`，最终exit=0，13项断言全部true：首次无认证401；错token401；伪internal无token401；正确token原health200/version2.0.150；恶意Host403；恶意Origin403；cross-site403；伪internal+恶意Host403；加载真实全局插件的请求200；该插件通过真实SDK内部transport无Bearer调用原health200；插件无secret命名ENV；父进程传递ENV无两项合成凭据；运行日志无两项合成凭据。
5. SDK fixture最初误用v2的`client.global.health()`，而真实插件收到v1 SDK，不存在此方法，导致合成plugin请求500。改为该SDK已配置的`client._client.get({url:'/global/health'})`后通过；使用的仍为上游Plugin提供的原Server.internalFetch transport，未伪造nonce或替换核心。前几次fixture失败未算通过。
6. 正式binary SHA256与manifest匹配=true，manifest版本2.0.150/Bun1.3.14/source commit固定均true。

## 代码复核

- `credential-file.ts`与`runtime.ts`：令牌string严格43位base64url，固定schema/account绑定、严格单文件guest_path、base64规范化检查。新plan仅在files.raw_value中内存封装，env只放非秘密账户ID、路径、driver及配置，不放auth/container值。
- `docker.ts`：publish使用wx创建；目录realpath/0700/uid检查；已存在file只读复核，拒绝symlink/hardlink/不匹配内容；Docker仅账户卷/data加单个精确`account.json:/run/reinlab-source/account.json:ro`绑定，normalized核对源路径、目标、RW=false、Binds全集及隔离配置。没有shell或secret argv。provider错误统一封装，不打印原body。
- Docker旧ENV仅显式listLegacyMachines/migrateCredentials路径；新普通list无法接受旧形态。迁移要求原auth/container与期望文件相同，完整部署形态canonical比较，stop/delete使用已核对的immutable Docker ID；未知结果由生命周期持久operation围栏处理，不自动再次POST。
- `index.ts`确保新机器文件凭据与vault期望相同，并拒绝旧secret ENV；`lifecycle.ts`区分普通升级和显式迁移，request_hash包含迁移标志；租约、操作幂等、pending/indeterminate新op围栏保持。
- `account-entrypoint.mjs`：读取root私有source，按Docker源uid检查、复制到/data以外的/run私有文件，privilege drop后native只接收文件路径；spawn argv只有serve/port/format。proxy和health使用进程内Bearer，未传ENV或argv；上游stderr被丢弃、stdout只认受限ready结构。
- `credentials.mjs`writer在O_NOFOLLOW/O_NONBLOCK打开后校验inode常规文件、nlink=1、0600，校验之后才truncate；不通过路径重开写入。writer本身依赖entry提前保护固定私有目录；本轮未把可任意控制部署privateDirectory参数的同uid宿主攻击纳入对抗模型。
- `deployment-entry.ts`在动态导入原bootstrap之前安装guard，只有--version路径免加载凭据；原CLI启动流程保留。guard白名单及原fetch包装已在前轮独立实际Bun验证，无routes旁路。
- build/compile：固定source archive和snapshot摘要、Bun版本、frozen lockfile安装；上游plugins/defines编译，禁dotenv自动加载。Docker使用新build stage，不把用户真实.env或key作为输入。

## 未亲自执行的范围

未自行重建正式binary或Docker镜像，未读取Docker真实inspect/Env，未执行Fly机器交付或验证其files落盘权限。未跑全部测试或任何模型。正式native测试保留原插件SDK transport；没有宣称对所有App.fetch/internalFetch函数identity做运行时证明。打包source完整性与编译流程本轮主要代码复核，实际binary-manifest一致性已检查。
