# 已知凭据迁移预检拒绝专用恢复：独立安全复核

日期：2026-10-23。仅安全边界与合成测试，未读取真实容器Env/key、未执行真实恢复或模型。实现由root修改，本评审未改实现。

## 当前结论

**修复后安全评审通过，可以进入由root控制的显式真实恢复步骤。** 可变tag问题已关闭，数据库终态/审计/unknown围栏及不可变Image ID实际create均通过本次独立复核。真实恢复必须继续使用明确proof与原操作围栏；本评审未亲自执行真实恢复，也不代表真实账户已迁移完成。

## 已关闭必要问题：目标digest复验后曾仍以tag创建

`DockerMachines.replace`在首次mutation前GET目标image核对proof.targetImageDigest，但后续`createMachine(plan)`的Docker Image仍为plan.config.image中的可变tag。若tag在检查→stop/delete→create期间变化，实际运行的其他镜像可先读取绑定凭据，事后runtimeImageDigest不符只能报告unknown，无法撤销该执行。

首轮建议：proof路径的实际create必须使用已证明的不可变Docker image ID，并在逻辑部署tag的独立metadata中保留原目标身份；或采用其他能保证原子digest引用的方案。仅加事后检查不足以兑现“固定targetImageDigest”边界。当时已即时反馈root并建议暂不执行；该问题现已按下文关闭。

已新增独立`credential-recovery-image-security-review.test.ts`，直接使用真实DockerMachines配合合成Engine transport，严格legacy normalization后执行proof迁移并捕获真实create请求体；要求Image等于proof digest，首轮实际红。测试在捕获create后主动抛合成断线，不接触真实Docker，不输出凭据。

修复复核：replace在首个mutation前解析并复验target Image ID，再将该ID直接传createPinnedMachine；body.Image使用该不可变ID，不再次以tag解析。逻辑tag移到io.reinlab.image，Config.Image在新容器为digest；normalized要求有逻辑label时Config.Image严格等于raw.Image。独立协议红测试现已转绿，并模拟DELETE之后tag变更：实际create仍为原proof digest，mutation后tag查询次数0。

## 修复后最终执行与逻辑label结论

- 实际命令：`vitest run services/control/test/credential-recovery-image-security-review.test.ts services/control/test/credential-recovery-security-review.test.ts services/control/test/credential-preflight-recovery.test.ts services/control/test/docker-driver.test.ts`：4文件、19/19通过。
- 独立协议测试检查create Image===proof digest、io.reinlab.image===目标逻辑tag、DELETE之后不再解析tag；合成篡改为有label但Config.Image不等raw.Image时拒绝，非法label格式拒绝。
- 逻辑label在本威胁模型下足够严格：它仅保存经validateImage校验的部署引用身份，不能替代不可变镜像ID证明；实际执行内容由body.Image和Config.Image===raw.Image约束，恢复完成另检查runtimeImageDigest===proof digest。已有无label旧容器仍只能通过原tag路径及严格legacy配置核验，不会把无label的digest容器静默解释为有效新部署。
- Docker daemon及能修改容器labels/镜像内容的宿主权限保持可信；不将可由该权限自行重建伪造的label视为密码学证明。无需为了“证明label”重新解析已可变的tag，否则会重新引入漂移依赖。
- tooling/local/image.ts模板仅取逻辑引用和不可变Image字段，类型/数量/digest检查保持，未增加Env或全inspect输出。

## 亲自执行

所有命令login:false、先unset DEEPSEEK_API_KEY，指定Node22 PATH，仅测试PG与合成数据。

`vitest run services/control/test/credential-recovery-security-review.test.ts services/control/test/credential-preflight-recovery.test.ts`：2文件、2/2通过。

新增独立`credential-recovery-security-review.test.ts`：模拟审计事务提交后mutation响应丢失。第一次恢复拒绝；原样重试仍拒绝；mutation次数仅1；旧op保持not_applied、新op保持indeterminate；machine持续starting且phase绑定新op，lease最终释放；审计只有一条、无两项合成token值；其他账户看不到审计、app UPDATE被42501拒绝。该用例针对coordinator持久状态，使用合成driver，不冒充真实Docker normalization或真实容器测试。

## 代码复核通过的边界

- proof严格字段/UUID/digest格式、旧新op不能相同，仅Docker维护函数入口，不是web/MCP能力。
- 只接受旧op indeterminate+wait、原迁移请求hash匹配、机器starting与原phase绑定；Vault令牌逐值匹配；旧容器createdAt早于旧op，旧tag不同目标。
- 由实际Docker normalized严格验证legacy部署与镜像baseline ENV，必须有非秘密image defaults，重演旧bare-ENV canonical不等，以限定已知preflight拒绝；不泛化为任意unknown清除。
- 两次观测要求immutable ID、createdAt、target digest、完整normalized配置一致；正式mutation前再次校验immutable ID和target digest，stop/delete使用immutable ID。
- 同租约预算锁内再次查phase/state、旧op状态及排除queued/running/waiting/paused_budget；原子写审计、旧op not_applied、新op pending、phase切新op，保持starting，避免恢复ready的新run窗口。
- 审计字段仅ID/时间/target digest/proof digest/固定reason，无旧ENV或token；RLS+FORCE、select/insert权限与append-only触发器。
- 数据库terminal trigger禁止applied/not_applied变回其他状态，not_applied须先有对应审计；普通lifecycle显式拒绝旧not_applied重放。
- 只有已applied新op的同一完整proof才能回放成功收据；pending/indeterminate新op不再次执行，未知结果继续围栏。
- 正常迁移保留经过image核验的baseline ENV，删除两旧token再覆盖公开新字段；未放松Docker canonical整体比较。

## 限制

未运行真实Docker、真实旧账户迁移或模型；root的18项测试结果不算本评审亲自执行。lease过期/发布进程并发须继续以现有持久围栏fail closed；本轮没有以等待一段时间替代取消旧请求的证明。

## 最终补充复核：挂载顺序与CLI只读对账

**最终仍通过，无未关闭安全问题。** normalized仅对Mounts副本按Destination排序，长度、volume名称/type/RW、credential bind精确Source/Destination/RW=false及完整h.Binds校验均保留。新增`docker-mount-set-security-review.test.ts`实际证明bind在前/volume在后可接受且原数组未被改动；正序亦可接受；额外挂载、credential RW=true、外国Source、重复Destination均拒绝且mutation次数0。

可信CLI对旧not_applied+saved recovery的路径核对account/oldop/newop审计关联、newop现存且indeterminate或applied、原image/mode/migrate请求hash、持久image pin。严格file形态与target/runtime digest预检查后调用准确newop的既有lifecycle只读分支；再次检查同新immutable ID及digest后才保存primary operation，并进入ensure。缺失条件失败关闭，不生成第三op。

lifecycle已在持有租约时为关联审计的newop重新inspect target/runtime digest；最终applied UPDATE仅允许pending/indeterminate，要求同lease且clock_timestamp未过期，存在审计时phase必须仍绑定该newop，rowCount必须1。先前发现的“过期租约后仍可提交只读对账”缺口已关闭。独立coordinator测试额外模拟inspect期间租约过期，最终返回PROVISIONING_INDETERMINATE，DB新op仍indeterminate。

最终亲自运行5文件20/20通过：docker-mount-set-security-review、credential-recovery-image-security-review、credential-recovery-security-review、credential-preflight-recovery、docker-driver。上述均合成Engine/测试PG；真实4账户迁移/health4/4及local verify9/9属于root执行的结果，本评审仅记录其来源，未自行接触真实容器Env或凭据。模型调用0。
