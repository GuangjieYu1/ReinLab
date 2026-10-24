# P1-13 question接线独立安全复核（通过，测试已冻结）

## 范围与结论

本轮仅检查src/data/inbox-live.ts的question DTO映射和answers转发，以及现有decisions.ts的服务端答案验证、sent/indeterminate围栏与research-live会话缓存边界。未修改任何实现、Claude UI四文件或场景三文件。未读取真实凭据/浏览器、未执行模型。

结论：本轮必要安全边界通过，未发现需修复的安全问题。新增独立测试严格限2项，完成后冻结。

## 代码复核

- nativeQuestions仅接受单一question.asked event及questions数组，检查question/header、options label/description和multiple/custom类型；映射只复制公开问题字段，不生成答案。multiple/custom包括false均按原值保留，label/顺序/空格不归一化。
- decideApproval要求已load的本代pending、非sent条目；question approve缺answers直接拒绝。提供answers时原样带scope=once送现有decide，包含非法/空答案也不擅自改成有效选择，交后端拒绝；失败向UI传播。
- 后端normalize严格限制问题approve必须answers，问题只能once；reject不能携answers。数组层数/数量/每项非空文本及4000长度由严格schema校验；questionsValid对当前runtime snapshot逐题核数量、去重、单选不能多选、custom=false只能精确选原label。它不依赖前端传回的question/options声明。
- API preflight验证答案后才保存不可变意图；dispatch再取fresh snapshot核同session/run和当前请求，校验后事务CAS提交decision_sent=true/indeterminate，SDK只在该CAS赢得后执行。已sent/unknown不重新发送；原receipt/idempotency逻辑保持，问题不被伪造成permission。
- adapter每次load/决定前后检查session generation；过期在途load不能覆盖新账户缓存。research-live在login开始立即清session/refresh/intents并增加代次，取得token及响应返回均再核代次；换账户期间不携旧token继续请求。

## 亲跑证据

指定Node22 PATH，login:false，先unset DEEPSEEK_API_KEY，运行node_modules/.bin/vitest run：
- p113-question-security-review.test.ts（本轮新增2项）
- inbox-adapter.test.ts（含主agent新增question映射/原样answers两个红绿回归）
- p113-adapter-security-review.test.ts
- decisions.test.ts
- browser-session-security-review.test.ts

结果5文件49/49通过，用时约2.2秒。后端用55432合成账户与mock runtime决定端口，不调用真实模型。

两项独立新增断言：
1. 即使提供answers，sent question、indeterminate question、未load问题与无answers的approve均拒绝且不触决定端口；sent投影仍为indeterminate。
2. A在途question load在B已load后返回会拒绝且不能覆盖B缓存；A问题不得批准；B的multiple=false/custom=false及有空格label保真，answers数组同一引用原样交付；再次换代后B缓存决定也拒绝。

已重跑现有后端无答案、非法选项、单选多选越界、重复答案、题目数量错误与unknown决定不重发等测试；会话refresh/login竞态及pending B登录禁止A token请求也在所列测试内通过。

## 限制

未运行真实浏览器/E2E、模型或本轮全量CI；Claude组件与场景原样同步由主agent核验。本结论仅覆盖所述适配器/后端安全边界，不把UI布局测试或真实模型行为算作已验证。
