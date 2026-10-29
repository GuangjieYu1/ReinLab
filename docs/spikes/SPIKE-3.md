# SPIKE-3：OpenMAIC单个互动场景

## 结论

**能单独生成。** 已使用现成服务的`POST /api/generate/scene-content`，传一个interactive outline（allOutlines也只含同一个），返回完整HTML和widgetType=simulation。无需调用课程创建、outline规划或scene-actions接口。一次真实生成HTTP请求耗时109252ms，HTML32426字节；不是fixture模型或拼装样例。服务使用自身已配置模型路由，本探针没有覆盖模型或提供测试密钥。

该次处理观察到响应为`{success:true,content:{html,widgetType,...},effectiveOutline:{type:'interactive',...}}`；content本身没有type字段。完整原始HTTP JSON没有留存，不能只凭派生报告独立重证这一字段缺失；两个目录的源码契约支持该形状。不能把课程scene的`content.type`判别方式直接套到该接口。

## 依据

只读`/Users/guangjieyu/Documents/OpenMAIC`及用户提供部署目录的相关源码：

- app/api/generate/scene-content/route.ts：先验证outline/allOutlines/stageId；resolveModelFromRequest按scene-content:interactive路由，调用generateSceneContent；最后返回content/effectiveOutline，没有课程持久化调用。
- packages/@openmaic/generation/src/scene-generator.ts：interactive直接走generateWidgetContent→aiCall→extractHtml→脚本语法检查→postProcessInteractiveHtml。
- scene-types.ts：GeneratedInteractiveContent是html及可选widgetType/widgetConfig/scientificModel。
- outline-types.ts：SceneOutline必需字段及widgetOutline变量/交互参数。
- lib/server/resolve-model.ts、api-response.ts：模型配置优先级与返回包装。

两个目录元数据均OpenMAIC1.1.0、generation包0.3.13，六个相关源码文件摘要一致，见source-manifest.json。实际运行的是用户已有.next-rhine-v9/standalone构建；build-manifest.json只记录构建文件摘要，不凭当前源码提交推断构建提交。

## 验证

原本本机3000未监听，公网API无正确Origin的请求403。按用户给的命令临时启动现有standalone，仅绑定127.0.0.1；配置由服务进程读取，未查看/复制.env值。请求携带与服务相同的Origin，保留其校验。三个缺字段请求全部400，未触发生成。此前缺文档/真实报告的测试红灯保留。

真实请求见request.json，样本为一维梯度下降f(x)=(x−3)²，明确只生成一个场景。live-generation.json记录200、摘要、耗时；原始interactive.html未改写。HTTP请求一次，服务内部模型调用/重试次数及费用没有返回，providerCallCount和costCny为null，不能记作免费或一次确定模型计费。

在独立测试页中使用`iframe srcdoc sandbox="allow-scripts" referrerpolicy="no-referrer"`运行，未加allow-same-origin或其他权限。浏览器实测初始x=0/f=9，η=0.10单步后x=0.600/f=5.760/梯度−4.800/迭代1；快速收敛预设会调整参数并运行；重置恢复x=0/f=9/迭代0。截图interactive-step.png与browser-test.json留证。独立测试还验证了四个学习率预设的数值递推与停止条件。

样本为完整文档，无base/form/window.top；外部脚本仅KaTeX0.16.9的两个jsDelivr固定URL。当前只核对这个样本，不把正则扫描或截图当成生产安全验证。测试页始终保留严格沙盒，未修改ReinLab前端。临时OpenMAIC进程已关闭。

## 采用方案

后续采用`OpenMaicAnimProvider`直连该单场景接口，不需要`OpenMaicCourseAdapter`。由concept/contextText映射到一个outline，allOutlines=[outline]，生成调用自己的临时stageId；lang映射中文languageDirective，取content.html与content.widgetType，保留effectiveOutline及提供方元数据。后端仍须完成正式引用上下文构建、权限/请求认证、超时与未知结果策略、费用回报、同一套provider契约测试及HTML安全门禁。

不需要提议新增单场景端点，因为现有接口已覆盖本次能力。Q-034记录实际响应与部署接入差异，供后续适配使用。重新生成必须显式带--generate，另用--output指定新的证据目录。脚本通过wx原子独占报告，在写请求或提交生成之前取得资格；已有报告时拒绝重复生成，不因超时自动重试。提交意图落盘后、请求完成前进程中断，调用结果与次数保持未知；HTML成功保存后才标generated，失败记failed-to-save。离线故障测试的模拟fetch仅存在于测试子进程和临时目录，与真实样本分开。

## 边界

仅验证simulation这一类型与一个数学样本；其他widget类型、论文引用一致性、生产鉴权、故障降级和可用性尚未验收。样本无论文引用，不冒充研究结论。一次真实生成成功不等于Provider生产实现完成，也不是ReinLab live端到端链路或T-SEC全套通过。本批未实现P1-10或P2-02之后功能，Claude最终签核仍待完成。

## 2026-10-20 接入方式将变更

依据用户确认的BATCH3_ADDENDUM及ARCHITECTURE_BENCHES §11：本篇旧站点接口调查仅保留历史依据。正式P2-07改为自有课堂引擎内调用`@openmaic/generation`，经`AICallFn`连接模型网关；不再直接接OpenMAIC站点`scene-content`。本批不实现SDK课堂引擎，也不把旧服务探测当作新路径已验收。
