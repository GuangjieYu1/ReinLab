# 精读live适配增补 · 送审证据

依据主仓库design/RESEARCH_LIVE_FRONTEND.md和用户2026-10-25指令。此项与第六批PR #19一起送审；不开始P2-05/P2-06，也不重新执行T-MCP-10。

## 实现与来源

source-hashes.json记录六文件逐文件原始/同步SHA256，原样同步Claude read五文件和20-read-run场景，未修改其样式/交互/断言。仅ResearchStudio接入liveReadAdapter与原收件箱，mock保留三模式；删除LiveResearch临时界面。主仓库未写入，OpenScience checkout未修改。

后端新增read-state / read-events：账户RLS、read-run归属、REPEATABLE READ READ ONLY快照、固定through历史水位；只读加载不触运行恢复或MCP凭据重授。paper_asset追加有界公共元数据，papers.fetch将真实标题/作者/来源/字节数同时存资产和沉积元数据；旧资产缺字段如实显示未记录。成功paper页回执同事务记paper_page_read事件，同页同hash不重复，不同hash冲突拒展示。

投影只选择一个论文资产的真实pN页回执，layer/answer/finding按asset/page引用转换，finding编号沿服务器值；quiz只返回公开字段。历史和read-SSE以同一服务端白名单过滤，移除native tool/reasoning原始输入/输出，包含JSON字符串中的答案路径。模型中间文字不呈现，只恢复终态助手总结。未知/未观测费用保留unknown/null；anims=[]、hasRepro=false。

预估不会提交运行；确认POST保留真实query与confirmed:true，丢响应只读核对原estimate/run，不再次POST。SSE支持分帧、Last-Event-ID、断线续读、重放去重、账户generation与快照身份/水位围栏。旧响应不能将cancel改指旧run。原生question只引导完整收件箱；sent/unknown/expired/终态不展示可批准动作。newReading未知结果保留幂等键并阻在旧档案估价；再次明确新建仍核同一收据。追问和评分诚实未接入。

## 红绿与验证范围

- read-state-red.json：缺接口404红；read-state-green.json：同API断言转绿。
- read-adapter-red.json：模块尚不存在的收集红，不能当成行为红；其后真实数据/费用/确认幂等断言通过。
- read-create-red.json：新建丢响应后错误回落旧档案红；保留key并阻旧档案预估后转绿。
- 独立read-security-final.md记录5绿1红→6绿的取消目标并发复现，连同2个既有文件亲跑9/9；review只覆盖安全与迁移，不冒称全量。
- read-page-events.test.ts实测成功回执事件一次、重放不重复、事件插入故障回滚页回执。read-lifecycle包含SSE分帧/重连/去重、换账户、迟到响应、未知提交不重发、审批状态、双论文p1、到期预估等；browser-session补SSE header/401/旧账户响应取消。
- read-full-node22.json为较早1530/0/0全量预检，后补3个用例后，最终HEAD结果以最新CI和最终报告为准；不得用预检数冒充最新HEAD。

browser/使用真实本地Supabase Auth、RLS、生产API/事件投影/SSE和Claude组件；研究内容与价格明确为合成fixture，测试API无RuntimePipeline，modelRequests=0，nativeRuntime=false。验证7/7：预估不派发、确认一次/审批、结果卡/原文、未接入、刷新恢复与真实账本导出；截图和ledger均在目录。**此验证不证明原生模型/papers/files/cards真实链路通过**。inbox-regression/为原有真实Auth/API浏览器9/9回归。

T-REG原样20场景完整报告与最终CI在本目录及PR #19归档。T-MCP-10历史失败与零调用核账保留，后续只改NEXT_SMOKE_PLAN，仍待新授权。云端统一“云端补验”。

## 复跑

```sh
unset DEEPSEEK_API_KEY
node services/account-runtime/build.mjs
REINLAB_REQUIRE_NATIVE=1 pnpm test:native-after-build
REINLAB_REQUIRE_NATIVE=1 pnpm test --reporter=json --outputFile=test-report.json
pnpm build
pnpm lint
pnpm exec tsc -p services/control/tsconfig.json
pnpm local:up
pnpm local:verify
REINLAB_EVIDENCE_OUT=/tmp/reinlab-read-live pnpm exec tsx services/control/scripts/verify-read-live.ts
# mock Vite已另行启动后
REINLAB_URL=http://127.0.0.1:5180 E2E_OUT=/tmp/reinlab-treg20 pnpm e2e:legacy
```

不source模型key。开发数据库55432供Vitest；完整本地Supabase54321/54322；verify-read-live自行启用独立API与live前端5182，不停止既有控制面，不读取模型key。Q-097是需Claude后续处理的hook订阅生命周期问题，原样前端未擅改。
