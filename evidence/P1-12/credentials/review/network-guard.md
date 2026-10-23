# P1-12 账户凭据文件与网络guard独立复核

日期：2026-10-23。只读复核实现：`services/account-runtime/credentials.mjs`、`network-guard.mjs`及对应d.mts；未修改实现。新增独立测试：`services/control/test/account-security-review.test.ts`。

## 结论

**修复后通过：此前真实Bun1.3.14确认的routes旁路已关闭，当前未发现待解决安全问题。** 凭据文件类型与权限检查、fetch认证及reload检查通过。本报告针对模块安全边界，不代表正式内核/账户包装已交付或已验收。

## 已修复P1：Bun routes曾绕过只包裹fetch的认证

`network-guard.mjs`将`{...options,fetch:wrap(options.fetch)}`传入原Bun.serve，并将`{...next,...}`传入原reload，未拒绝或认证Bun的routes分发。真实Bun1.3.14会在fetch前处理routes，导致路由请求完全不经过Bearer检查；首次bind和reload新增route均受影响。

实际验证：在/tmp使用空白ENV、合成私有凭据文件、自造HTTP handler。无Authorization的普通fetch路径401，首次serve的routes路径200，reload新增routes路径200。输出仅状态与版本，无凭据值。未运行OpenScience内核或模型。

建议：限制serve/reload接受的选项，拒绝routes/static等未被guard覆盖的分发通道；或保证所有分发均处于同一认证边界之内。原上游当前是否传routes不改变该模块对后续reload/意外配置的fail-closed承诺。

修复复核：serve现仅接受plain/null-prototype对象的自身可枚举data字段，白名单hostname/port/fetch/idleTimeout/websocket；hostname/port/fetch必需。reload仅fetch/websocket。routes/static/未知字段/访问器/继承原型/非函数fetch拒绝。实际Bun重验首次routes配置在bind前拒绝、reload routes/static拒绝，普通fetch reload后仍401/正确token200。此项关闭。

复跑脚本：`/tmp/reinlab-p112-guard-routes-review.mjs`。执行命令为`env -i PATH=/usr/bin:/bin /Users/guangjieyu/.bun/bin/bun /tmp/reinlab-p112-guard-routes-review.mjs`，先unset DEEPSEEK_API_KEY、login:false、cwd=/tmp。Bun版本1.3.14。

## 已采纳凭据ENV检测覆盖建议

安装guard时ENV检测仅匹配末尾`_KEY|_TOKEN|_SECRET|_PASSWORD`，未覆盖项目已知`DATABASE_URL`/`DATABASE_URL_APP`/`DATABASE_URL_PROVISIONER`字段。建议补此模式；若正式entry用显式ENV白名单隔离，则应由外层测试证明。此项为代码复核，不声称已经观察到实际账户ENV泄露。

修复复核：已补`^DATABASE_URL(?:_|$)`；独立测试三个已知字段均在安装时拒绝。此项关闭。

## 修复后最终执行

- Node22定向3文件4/4通过；独立测试新增serve routes/static拒绝、继承原型及访问器拒绝（getter未执行）、拒绝时bind次数仍为0、reload旁路/非函数fetch拒绝、三个DATABASE_URL字段ENV拒绝。
- 真实Bun1.3.14，自造HTTP handler、空白ENV：routesRejected=true、reloadRoutesRejected=true、reloadStaticRejected=true、secondListenerRejected=true；首次无认证401/正确token200；普通reload后无认证401/正确token200。
- 真实Bun对`server.reload({})`本身抛ERR_INVALID_ARG_TYPE（需要fetch或routes），该失败未改变已安装handler，后续无认证仍401。这是运行时行为说明，不是guard移除auth或本轮缺陷。合成验证脚本已捕获该预期原生失败，最终exit=0。
- `/tmp/reinlab-p112-guard-routes-review.mjs`现已更新为修复后的拒绝断言脚本，原红结果见root保存的`/tmp/reinlab-p112-route-bypass-red.json`（本评审未把root保存结果计作额外亲自执行）。

## 实际执行

- 指定Node22 PATH、所有shell login:false、先unset DEEPSEEK_API_KEY。
- `vitest run services/control/test/account-credentials-file.test.ts services/control/test/account-network-guard.test.ts services/control/test/account-security-review.test.ts`：3文件、4/4通过。
- 新独立测试覆盖JSON数组/null、auth/container/accountId/schema数组伪装、父目录755、错误owner、错误固定码；reload更换fetch仍要求认证、空reload保持认证、同一Request对象及Host/Origin完整交给原fetch。
- 真实Bun1.3.14仅运行合成HTTP handler，确认上述routes旁路。没有读取真实凭据、用户浏览器、没有模型或外部网络访问。

## 代码复核与限制

- 凭据严格要求schema/accountId匹配、恰好4字段，auth/container均为string且43位base64url；JSON数组不能通过字段集合与严格相等检查，未发现数组coercion。
- 路径绝对且规范、symlink拒绝、直接父目录0700及uid、文件0600/uid/nlink=1/常规文件/4096字节限制；错误码固定，Buffer finally清零，返回对象冻结。实际跨uid归属变更未做，仅通过传入错误期望owner验证比较分支。
- guard先提供包装fetch给原serve，无先裸监听再reload窗口；同一Bun对象只能安装一次、只能进行一次预期127.0.0.1/4096 bind；额外listener拒绝。guard安装前已有listener不在模块可观察范围，正式入口必须保证先安装再加载可能监听的核心模块。
- Host/Origin不由guard自行解释，带正确Bearer后保持原Request交给上游；这是保留检查的必要条件，不能替代真正上游Host/Origin测试。
- fetch reload有认证包装；routes旁路是独立缺陷。d.mts未暴露秘密默认ENV回退，声明本身不改变运行时安全边界。
- 已读`/tmp/reinlab-p112-packaging-spike.md`作上下文；未复跑其产物，也不将其12项断言算入本次亲自执行结果。账户entry/driver/正式镜像交付尚未在本次评审范围。
