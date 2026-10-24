# P1-13 后台恢复独立安全评审（最终定向通过）

范围：工作树 codex/p1-13-reconcile-inbox；discovery角色、000/001/002迁移、worker持久调度、有限回放与本地Hatchet启动。未修改普通实现、Claude组件或主仓库；未读取真实key/容器Env，未调用真实模型。

## 当前结论

本次代码安全边界定向通过：数据库最小发现权限、有限回放与生产只读角色验证/会话恢复、容器能力约束和私有配置完整性pin均已关闭发现。15文件37/37通过。真实机器重启混沌另行执行，本报告不代替其结果。

## 已复核并通过

- 001仅SELECT account.id、专属RLS、FORCE；app/discovery双向不能SET ROLE；角色不得额外继承、拥有对象或带管理权限。
- 原001仅拒public CREATE有缺口：独立任意schema CREATE测试红。追加002替换assert函数检查全部非系统schema CREATE后转绿；001字节不改。
- 000精确撤两诊断view PUBLIC SELECT，授pg_read_all_stats。实际隔离PG测试先登记后继001再晚加000，000被执行、001 hash不变、重跑幂等；owner/stats权限保留、无关view ACL原样。
- run.observe并发键为account，幂等键为account:run；发现每轮固定ceiling、keyset分页，每次从头扫描避免漏随机UUID。
- reconcileObservation仅snapshot/replay、固定首个highWater、最多1000事件，无SSE/prompt/decide/cancel。独立测试证明历史增长不追尾、sink失败未提交游标不会跳事件；既有ledger sink仍负责事务及去重。

## 已关闭问题

1. 隐藏角色prepare写入已关闭：worker显式readOnlyRecovery=true，pipeline→production factory→RemoteRoleStore传递readOnly；首次与反复assert均访问/roles/verify。账户entrypoint在先行auth之后，仅POST有界JSON路由verify到prepareAccountRole第三参true，最终verifyRoleProject只读校验受管文件，不mkdir/managed。缺失或修改均拒绝，无prepare回退。协议与实际临时目录测试通过。
2. 旧container额外能力缺口已关闭：DeviceRequests、非private IpcMode、UTSMode、UsernsMode、VolumesFrom全部拒绝；原5项独立红灯现转绿。启动按inspect返回immutable container ID；配置与挂载漂移不删除重建。
3. 配置完整性限制已关闭：主agent只读枚举确认实际配置卷仅三项常规文件。本agent不读取其内容，仅审源码与临时合成文件测试。hatchet-integrity.mjs精确清单、目录owner/700、O_NOFOLLOW|O_NONBLOCK、fstat常规/owner/600/nlink1/≤2MiB、读取后inode/size/mtime/长度稳定检查；digest顺序与旧pin一致。hatchet.ts使用已保存账户镜像immutable ID，network none、只读卷/只读rootfs、capDrop ALL/no-new-privileges的Node helper，只接收固定三摘要格式。私有state旧pin不匹配拒绝、ready无pin拒绝；不输出内容或原异常。
4. restoreSession隐式grant写入已关闭：RoleRuntime新增readOnlyRecovery，factory由readOnly直接传入；校验原session身份后跳过grantSession。本agent新增随机本机端口真实HTTP协议测试，readOnly恢复两次再snapshot/replay全为GET；普通恢复对照产生POST。此前仅核verify和有限函数未覆盖这个隐式grant边界，此次补证据后关闭。

## 亲跑记录

全部命令login:false，先unset DEEPSEEK_API_KEY，使用指定Node22 PATH。通过node_modules/.bin/vitest运行：

- p113-discovery-security-review、p113-reconcile-security-review、recovery-discovery、reconcile-observation、migrate：5文件9/9绿。discovery独立红灯在002后转绿，真实PG55432；migrate含原子回滚/幂等/并发/hash漂移拒绝。
- p113-diagnostics-migration-security-review：1文件1/1绿，随机隔离数据库，结束删除；未读取业务数据。
- p113-readonly-role-security-review：1文件1/1绿；合成transport证明readOnly首次与反复能力校验仅调用/roles/verify，404拒绝且无prepare回退。尚不替代服务端无写盘与factory接线检查。
- p113-hatchet-security-review：1文件5/5红，纯合成inspect对象，不访问Docker；作为待修复证据。

未亲跑真实Hatchet、Supabase生产迁移、模型或worker混沌；不据此宣称这些项目完成。

## 最终定向复跑（本agent亲跑）

指定Node22、login:false、先unset DEEPSEEK_API_KEY：node_modules/.bin/vitest run 以下12文件，共34/34通过：p113-discovery-security-review、p113-diagnostics-migration-security-review、p113-reconcile-security-review、p113-hatchet-security-review、p113-readonly-role-security-review、recovery-discovery、reconcile-observation、migrate、hatchet-container、account-role-store、remote-role、production-factory。

主agent报告真实Hatchet server启动、worker ready及3项workflow注册成功；本agent没有亲自执行或读取真实私有配置，机器混沌尚未进行，因此不将这些计入亲跑结果。后台恢复允许现有ledger sink事务写入与终态capability cleanup；只读限定运行内核观察/角色校验，不承诺数据库零写入。

## 最终关闭附录

亲跑指定Node22：15文件37/37通过（前述12文件，加p113-hatchet-integrity-security-review、p113-restore-no-grant-security-review、hatchet-integrity）。独立新增配置测试拒公开目录、缺文件、目录/FIFO特殊文件、超限文件，保持旧摘要排序；现有测试拒额外文件、symlink/hardlink、owner/mode漂移。独立无grant协议测试补充snapshot/replay后单独复跑1/1通过；没有新实现改动。

本次未发现尚未关闭的必要代码安全问题。该结论限定已审源码与所列定向测试；主agent报告实际配置卷三文件及local:hatchet复跑成功，本agent没有读取实际文件/真实容器Env/真实key。真实Hatchet/worker启动、workflow登记与机器chaos的现场证据由主agent另报；本agent未调用模型。

## Q089 部署MCP脚本路径附录

通过。原import.meta.url令控制面host与账户容器的MCP脚本绝对路径不同，造成严格文件hash拒绝；修复不弱化校验。只有canonical root严格等于/data，且pluginUrl严格等于file:///opt/reinlab/plugin/index.js时，command脚本固定/services/account-runtime/mcp/client.mjs。账户Dockerfile确实COPY该路径，远端store已强制相同root/plugin。其他本地fixture仍使用import.meta路径。

固定分支无用户选择的可执行路径；command为独立argv数组，配置文件仅/data/mcp-clients/<已验证UUID>.json，server另参且client自身校验枚举。凭据仍从私有文件进入内存；未放宽受管文件hash/receipt校验。旧内容不符仍拒绝。

亲跑6文件23/23：新增p113-deployment-path-security-review，及remote-role、role-plan、account-role-store、p113-readonly-role-security-review、production-factory。独立测试覆盖精确部署argv、邻近root或plugin不触发分支、非canonical/data/、/data/.、/data/../data拒绝。未执行真实容器/模型，镜像重构与真实MCP后续由主agent验证。

## MCP smoke及终态清理补充

后续新增guard/终态审查最终通过，详见/tmp/reinlab-p113-mcp-smoke-security.md：独立marker六类漂移及200内JSON/SSE error红灯修后转绿；最终4文件26/26。终态清理无自动批准，精确本账户本run pending permission/question，审计失败同事务回滚，其他账户/run及已批准/未知/budget保持。未执行真实模型。

## cleanup端口重连最终附录

新可选reconnected Runtime初版返回包装丢参已由独立红灯发现并修复；最终返回API→cleanupSmokeGateway→closure参数全通，互斥/同token与角色身份/先bound后写均保留。独立外账户、不同role、伪造capability、文件漂移负面+fresh端点只清理一次通过。相关6文件39/39；详细证据见/tmp/reinlab-p113-mcp-smoke-security.md。只读chaos报告摘要为8项通过、gateway清理true、真实key读取/模型调用均0，不冒称本agent执行chaos。

## Q091 Hatchet内部Setenv绕开分支只读复核

方案定向通过。亲读本机供审固定Hatchet源码/private/tmp/reinlab-p113-hatchet-read/pkg/config/loader/loader.go 175–188：仅DATABASE_URL为空时从PostgresPassword拼DSN并os.Setenv；非空时直接复用该URL。当前tooling/local/hatchet.ts的admin/seed/token/quickstart/migrate共用run包装均设置完全公开无密码DSN，服务create也设置同一DSN；URL password显式拒非空。database.yaml新生成内容已无真实password字段，实际认证密码只进入stdin写出的0600 pgpass；DSN固定passfile路径让pgx在进程内读取，无PGPASSWORD或秘密DSN ENV。配置默认PostgresPassword即使由上游填充，也因非空公开DATABASE_URL跳过Setenv分支，不包含真实数据库密码。

服务inspect仍精确比较pinned image公开defaults（只移除原DATABASE_URL键）+唯一固定公开DATABASE_URL完整Env数组，任何其他env/重复或秘密URL差异均不匹配；immutable image、mount/network/端口/能力约束未放宽。所有admin临时容器--log-driver none，令牌stdout仅IPC内存捕获。

本轮仅源码审查，无真实私有文件/进程ENV/DockerEnv读取，无真实脚本/模型执行；未独立执行配置迁移或再次chaos。主agent提供的Node22/24 1498项及9项checkpoint结果不记为本agent亲跑。结论限定显式公开DSN绕开已审Setenv路径及既有严格inspect约束。
