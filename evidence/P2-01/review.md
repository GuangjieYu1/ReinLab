# P2-01 独立评审

评审范围：`docs/tasks/P2-01.md`、`docs/spikes/SPIKE-3.md`、`tooling/spikes/openmaic-{probe,viewer}.mjs`、`openmaic.test.ts`及保存证据，对照`design/CODEX_SPEC_RESEARCH.md`§10.4。未执行上游服务、未重发模型生成、未读任何`.env`或凭据、未操作浏览器、未修改实现/结论正文。浏览器实际交互由独立测试人员另行验收。

## 结论

**PASS（SPIKE评审范围）。** 现有证据足以支持本次SPIKE的能力结论和后续直连方案：一个interactive outline、同一元素组成的allOutlines、临时stageId可直接走scene-content，不要求创建课程。无需CourseAdapter或新增单场景接口。三项发现均已修复并复核实际集成；没有剩余阻塞问题。无需再次付费生成。

## 发现

1. **[P2，已修复] 防重复生成检查不是原子操作**。主探针现已真正调用`claimGeneration`；helper用`writeFile(...,{flag:'wx'})`独占报告，取得资格后才独占写request并进入生成提交。40并发测试只一名获胜；已有报告不覆盖、request写失败保留failed-before-submit占位并阻止下一次提交。原先access→普通write的竞争窗口已消除。

2. **[P3，已修复] 脚本不能复现报告的调用次数语义字段**。helper在初始报告强制写入`providerCallCount:null`与明确的`callCountScope`，并测试其存在。claimed/failed-before-submit计数0；持久化submission-intent时计数null，进入fetch时内存计数1。该意图状态下进程中断无法证明是否提交，所以null合理。`callCount:1`仍仅表示生成HTTP请求，内部用量和账单未知。

3. **[P2，已修复] HTML写盘失败后仍记录generated**。主探针确实调用`saveGeneratedEvidence`：独占写HTML成功后才标generated并落报告；失败标failed-to-save，保留callCount=1、费用未知和防重占位，已有HTML不覆盖。新故障测试覆盖此路径。主探针在提交前持久化submission-intent/callCount:null，失败直接退出、不执行fetch；网络异常标indeterminate、已收响应但解析失败标response-processing-failed、明确失败响应标failed。所有这些路径均不自动重试生成。若文件系统连失败报告也无法保存，进程会失败退出，已有独占报告继续阻止再次提交，不能把未成功落盘的内存状态当成持久证据。

最终复核执行`pnpm exec vitest run tooling/spikes`：5文件/27测试通过；`pnpm lint`依赖边界检查通过。检查了helper并发/占位/HTML写入失败测试，以及离线fetch替换的CLI成功、网络未知结果和重复运行集成测试。合成响应只在临时目录使用，没有再次调用真实模型。原始interactive.html SHA256仍为下述值，未改写。

最终增量复核：数值测试已改为`execFileSync(process.execPath,['--input-type=commonjs'],{input,...})`，通过标准输入组合静态最小DOM、从保存HTML提取的原样主脚本、固定动作与JSON快照，设置3秒超时。没有使用eval/Function/node:vm，没有修改原边界规则；按钮监听器、四种学习率递推、停止条件测试通过。该子进程是当前已审阅固定样本的数值测试工具，拥有普通Node进程能力，不能用于证明浏览器隔离或当作任意不可信HTML的安全执行器；现测试注释没有作此宣称。

结论正文新增的证据界限准确：完整原始HTTP JSON未保存，所以保存的派生报告不能独立重证`content.type`字段不存在。该响应形状由当次处理观察和两目录一致源码契约支持，构建来源仍有限；此限制不影响保存原始HTML、生成状态/摘要、交互行为与单场景直连的SPIKE结论。未补造原始JSON、未新增模型样本。

## 独立核实

- 重新读取source-manifest列出的两目录六个指定源码文件并计算SHA256：十二个实际摘要均与清单相符、两目录各对应文件一致。结果存`independent-static-review.json`。不同Git提交不妨碍这六文件一致，但不足以证明其他源码或已构建产物整体一致；现文档对此界限诚实。
- route在模型解析之前拒绝缺outline/allOutlines/stageId。实际保存的三个400与源码路径相符。该交互生成路径直接调用generateSceneContent并返回`apiSuccess({content,effectiveOutline})`；stageId只是必填校验，在该路径没有课程创建调用。GeneratedInteractiveContent为html及可选widgetType/widgetConfig/scientificModel，不能套用课程持久化scene的`content.type`。
- interactive分支走generateWidgetContent→aiCall→extractHtml→内联脚本语法检查→postProcessInteractiveHtml。这里只解释源码调用路径，不从源码的一处aiCall或一次HTTP200推断部署内部调用总数或计费次数。
- 原始HTML为32426字节，SHA256=`9e0055ea44a640c0eec6bb16cab58e16e9725c66fac8707a55692d609303cc43`，与报告一致。扫描出的外部脚本仅两个固定KaTeX0.16.9 jsDelivr URL；另有同版本KaTeX CSS。该样本已超出请求“无外部资源”的偏好，但正文披露了脚本，且§10.4允许白名单CDN；SPIKE没有实现生产白名单策略。
- viewer使用转义后的srcdoc、严格`sandbox="allow-scripts"`和`referrerpolicy="no-referrer"`，未授予allow-same-origin、顶层导航或弹窗权限。它没有CSP，不能据此宣称禁网；正则扫描及该样本不代表生产HTMLValidator/T-SEC通过。文档没有作此宣称。
- Node22执行`pnpm exec vitest run tooling/spikes/openmaic.test.ts`，1文件/2测试通过。该测试验证保存证据和基本文档结构，不执行真实服务、不证明UI行为，也不替代后续AnimProvider契约与安全测试。

## 保留边界

只验一个simulation数学样本；未验证论文引用、其他widget类型、正式认证/超时/故障策略、生产HTML安全门禁、ReinLab完整链路。109252ms、HTTP200与费用null的表述符合保存记录。P1-10及生产AnimProvider/前端不在本次实现范围。Claude最终签核仍待完成。
