# P1-12 最终边界独立安全复核：eventRef 与文件锁

日期：2026-10-24。工作树`/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab`。仅安全边界/测试，无真实模型或key操作，未修改普通实现。

## 结论

**通过，无未关闭必要安全问题。** eventRef从“非空文本”提升为真实来源事件的服务器端验证；文件锁修复只改变首次创建方式，没有绕过锁、弱化路径检查或泛化重试。之前收件箱报告中“依据为非空字符串”的结论已被本次更严格实现取代。

## 亲自执行

所有shell login:false、先unset DEEPSEEK_API_KEY、使用指定Node22 PATH；只使用测试PG和合成临时文件。

最终命令：`vitest run services/control/test/final-boundaries-security-review.test.ts services/control/test/inbox-security-review.test.ts services/control/test/inbox-api.test.ts services/control/test/files-lock-race.test.ts services/control/test/independent-mcp-files.test.ts services/control/test/mcp-files.test.ts`：6文件、16/16通过。

新增独立`final-boundaries-security-review.test.ts`含两项：

- approve/edit/keep_local三种写memory决定逐一拒绝run:旧字符串、event:0、前导零、正号、指数表示、超过安全整数；每个提议第一条有合法eventRef、第二条非法，实际验证全部memory写入回滚且promotion仍pending，非法单项证据读取404。
- 两轮各16个真实Python helper并发写全部完成，32文件内容完整；两轮之间lock的dev/ino不变、nlink=1；将lock替换为symlink或hardlink均FILE_SCOPE_DENIED，外部sentinel不变。

本人重新核对root对旧`inbox-security-review.test.ts`的更新：仅新增appendEvent生成真实eventRef并替换原synthetic字符串；真实跨租户promotion/approval 404、foreign supersedes、多条目回滚、合法successor、决定收据RLS/权限等原断言未放宽，重跑通过。

## eventRef API代码复核

- canonical格式为`event:<正十进制seq>`，不接受0/前导零/正号/指数/旧run字符串，并限制Number安全整数；原始提议及edit条目走同一服务器校验。
- approve/edit/keep_local对每个evidence ref实际查询immutable event，要求同来源promotion的dossier和from_run；账户通过Database.withAccount的RLS固定，客户端不能覆盖来源账户/run/dossier。
- evidence列表及单项GET先RLS读取对应promotion来源，再以相同dossier/run约束事件；单项不存在或其他run的seq返回404。分页固定100、parseCursor验证after，nextAfter只推进最后返回seq。
- 校验、memory写入、promotion状态、决定收据与ledger event同一事务；即使较早条目已写入，后续非法ref也整体rollback。reject不要求修补旧ref且不写memory。
- event来源是可回看的原始ledger payload，响应经scrub；不把ref的存在解读为内容事实正确或用户已经读过，只证明它属于该来源运行的不可变记录。
- 前端从固定同源API读取source，按session generation防旧请求跨账户写视图，React文本显示原payload；用户选择的ref仍由后端重验。可见页每30秒检查距上次成功刷新是否达到5分钟，focus/visibility也刷新；后台页不定时拉取。该UI部分本轮为代码复核，未亲自跑浏览器。

## 文件锁根因与修复代码复核

本人读取`/tmp/reinlab-p112-node22-submit.json`的失败项：独立并发helper测试10项中有一项rejected，其余suite通过。该汇总本身不包含errno，不能独立凭此断言APFS具体根因。root受控复现报告的根因为并发首次`O_CREAT`打开时ENOENT、实际目录与lock存在；root另报告1000并发修后0失败，此统计不算本人亲自执行。

修复`lock_at`：先以O_RDWR|O_NOFOLLOW|O_NONBLOCK打开既有lock；仅FileNotFoundError才O_CREAT|O_EXCL一次创建；仅FileExistsError才重新既有打开。权限、symlink、其他errno均直接失败，不重试、不重建或删除既有lock；进入业务前继续fstat验证regular/单link/无group-other权限，再flock LOCK_EX。永久lock不会被历史版本清理删除。

本次未改变descriptor-relative路径校验、链接/特殊文件拒绝、copy/stage/fsync/原子exchange或版本rollback。原文件套件与独立负面用例实际通过，不以忽略失败或延长重试隐藏文件锁问题。

## 限制

未跑整仓全量或真实Linux容器，本机实际Python helper验证发生在当前Darwin/APFS环境；未执行模型、真实用户证据或key扫描。Node24及root全量结果由root另行记录，本报告只覆盖上述实际定向执行与明确标注的代码复核。

## Q083补充：Colima持久私有只读共享

**安全代码复核通过。** tooling/local/up.ts新增credentialRoot为固定homedir下`.local/state/reinlab/account-credentials`，先mkdir(0700)，随后lstat/realpath核对canonical真实目录、当前uid、精确0700；既有权限不符时失败关闭，没有chmod扩大既有权限或接受symlink路径。检查在colima start之前。

Colima第二个--mount只传该私有root路径，未加`:w`；本人仅执行本机`/opt/homebrew/bin/colima start --help`只读核验，返回“suffix ':w' for writable”。当前调用不授予VM对source根的写权限；原账户Docker仍仅精准绑定单个account.json:ro，source文件0600及runtime复制校验未改。该全局私有root会对专用reinlab VM可读，属于本次显式指定的共享范围，不扩展到homedir或整个`.local/state`。

runtime的REINLAB_DOCKER_CREDENTIAL_DIR复用同一root下现有项目状态标识子目录，没有出现另一个未校验source根。CLI环境不新增token值，argv仅路径与资源参数；4CPU/6GiB是专用VM资源调整，不改变权限边界。

未执行local:up、VM冷启动、镜像重建或真实账户升级；这些实际验证由root随后执行，本附录不提前宣称结果。
