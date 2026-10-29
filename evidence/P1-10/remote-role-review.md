# 远端角色准备：交叉独立只读安全评审

结论：**当前模块级审查通过，未发现P1/P2安全缺陷。** 这不是生产远端角色链路或真实Docker RPC验收完成声明。本人未实现本次remote-role/角色规划功能；本审查只新增本报告，不修改生产或测试，不提交。

## 范围

- services/control/src/bridge/openscience/role-project.ts
- services/control/src/bridge/openscience/remote-role.ts
- services/control/src/bridge/openscience/project-authority.ts及role-runtime的调用边界（交叉核对）
- infra/fly/account-entrypoint.mjs、account.Dockerfile
- services/account-runtime/package.json、tooling/local/image.ts中构建依赖与hash输入（只读）

依据为docs/tasks/P1-10-complete.md的窄角色准备接口、精确受管字节和不可变角色版本要求，结合现有角色权限/文件边界约束。

## 审查要点

1. **请求授权边界。** 新prepare路由位于原ready、Bearer timing-safe比较和Origin/cross-site拒绝之后。只接收精确路由POST与JSON，累计body上限1MiB；失败仅返回SCOPE_DENIED，不输出角色内容、token或底层错误。没有新增shell、任意命令或通用文件路径API。
2. **固定账户store。** RoleProjectRequest从strict Options省略root/pluginUrl，账户端只用入口固定root、pluginUrl、accountId；额外root/plugin字段被拒绝。receipt不含prompt/memory正文，只含固定身份、路径和三项digest。控制面也要求/data和唯一固定plugin URL。
3. **控制面与账户内容一致。** planRoleProject共享生成三受管文件的精确内容、路径、hash和grants；路径限制、默认deny、danger/task拒绝、指定dossier读范围与writeTargets约束保留。roleDefinitionHash使用规范输入，版本化角色目录避免旧会话AGENTS被覆盖。
4. **原子发布和复用。** 内容先验证且限制每文件字节；新目录先在受控parent的临时目录完整写好、文件fsync后rename发布；已存在目标不会按新内容重写，只能通过assertRoleProject核验。原有普通文件/单link/不跟随symlink、受管文件白名单、摘要、canonical路径和Git边界检查仍在最终授权前执行。
5. **远端能力不可伪造。** receipt必须匹配预期accountId、directory、dossierDirectory、roleId、固定plugin与全部三项hash才写入WeakMap；复制项目对象不能成为授权能力。复用时重新向固定账户store核验，再返回受控grants/plugin。
6. **传输约束。** 远端请求禁止redirect，有10秒signal，JSON响应按实际流字节限制8192；provider/parse错误对外为稳定OS_UNAVAILABLE，身份不符为SCOPE_DENIED。constructor的baseUrl属于可信控制面配置，不能作为公网请求体中可由用户自由指定的URL。
7. **镜像与入口。** Dockerfile只新增共享角色源文件及固定依赖解析symlink，未新增特权、socket挂载或host网络；运行时仍先初始化卷再降到uid/gid1000。Node基础镜像和OpenScience2.0.150精确锁定保留，新增zod精确3.25.76。入口autoupdate:false、子进程强制DISABLE_AUTOUPDATE=1保留。全局provider/model/small_model限定和title禁用没有放开角色工具或文件权限。
8. **构建身份。** account image hash输入包含新COPY的role-project.ts及account-runtime manifest，避免源/依赖变化复用旧内容tag。原Docker immutable image baseline未在本功能中放宽。

## 独立普通正确性复验

Node22.23.3执行既有测试，不新增场景或风险复现：

```sh
pnpm exec vitest run services/control/test/remote-role.test.ts services/control/test/account-role-store.test.ts services/control/test/role-plan.test.ts services/control/test/role-project.test.ts services/control/test/role-special-file.test.ts services/control/test/account-entrypoint-lock.test.ts tooling/local/image.test.ts
node --check infra/fly/account-entrypoint.mjs
```

7文件**37/37通过**，entrypoint语法通过。覆盖remote receipt身份/摘要与复验、strict账户store、纯plan/不可变版本、并发同内容目录完整发布、既有角色文件边界、入口锁版本和COPY输入hash完整性。全部是已有测试；没有读取真实账户Env、凭据或模型key，也没有Docker构建/exec/升级/删除。

## 验收边界与后续注意

- 当前grep所见new RemoteRoleStore实例化仅在测试中；不得把本模块通过当成已接通最终生产调用。生产接线必须由可信driver提供账户endpoint/token，不能接受用户任意baseUrl或把DB JSON直接当WeakMap授权能力。
- remote-role测试使用fake transport，account-role-store测试直接调用store函数，锁版本测试在proxy启动前退出。因此本轮对实际HTTP代理的Bearer/Origin/Content-Type/size guard主要是源码确认，未声明已做真实路由端到端复验。最终收口仍需获授权的普通RPC契约或真实账户验证。
- plan中toolGrants输出排序使用localeCompare，而roleDefinitionHash使用显式字节序比较；目前支持环境与测试下字节一致，建议长期统一成显式稳定比较，避免未来不同locale产生可用性上的digest不一致。该项当前会失败关闭，不构成权限扩大。
- 原有L1/L2、Docker资源隔离、Storage、模型实际账单和事件持久化不在这份模块审查结论内，继续以各自证据验收。
