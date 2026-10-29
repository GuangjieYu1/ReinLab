# P2-01 / SPIKE-3 独立测试

结论：本次提前研究范围内通过。原始HTML为32426字节，SHA256 `9e0055ea44a640c0eec6bb16cab58e16e9725c66fac8707a55692d609303cc43`，与真实生成报告及既有浏览器记录一致。请求只含一个interactive outline，allOutlines与其逐字段一致；三个缺必需字段响应均记录400。

独立复核没有发出生成请求，没有读取.env或凭据，没有重启OpenMAIC服务。既有报告的callCount=1专指生成HTTP请求；providerCallCount=null、costCny=null，提供方内部调用/重试和费用均未知。报告记载HTTP200、109252ms；独立测试不声称重放这次生成。

## 实际浏览器核验

通过Cua新建后台测试标签，访问已运行的 `http://127.0.0.1:63241/`。直接读取iframe属性确认sandbox严格为`allow-scripts`、referrerpolicy为`no-referrer`；未修改沙盒或原始HTML。

| 操作 | x | f(x) | 梯度 | 迭代 |
| --- | --- | --- | --- | --- |
| 初始 | 0.000 | 9.000 | -6.000 | 0 |
| 默认η=0.10单步 | 0.600 | 5.760 | -4.800 | 1 |
| 重置 | 0.000 | 9.000 | -6.000 | 0 |
| 快速收敛预设η=0.45首步 | 2.700 | 0.090 | -0.600 | 1 |

以上为独立AX树直接观察，快速预设显示运行中。额外恢复η=0.10并再次单步，保存`independent-step.png`，数值与首轮一致。绘制效果和交互截图只证明本次样本，不表示完整T-SEC。

## 自动测试

新增`tooling/spikes/openmaic-independent.test.ts`共10例，连同既有2例、claim/save模块4例及CLI独立故障5例，最终亲跑21/21通过，输出`independent-vitest.json`。新增测试不依赖外部OpenMAIC源码目录、不调用服务：核对报告和HTML字节摘要、未知费用/调用范围、单outline请求、400记录及源码/构建摘要结构；通过标准输入Node子进程，在静态最小DOM支架中执行原始HTML的主要内联脚本，触发实际注册的单步/重置/四个预设按钮，使用独立闭式解 `x_n=3−3(1−2η)^n` 核验前三步，并验证快速收敛/发散停止后不再推进。

最小DOM支架不模拟Canvas绘制、真实动画时序、外部KaTeX和iframe隔离；浏览器隔离结论仅来自上述实际页面属性与交互。正则仅用于定位原始脚本，不是安全验收。

复现命令（Node22）：

```sh
pnpm exec vitest run tooling/spikes/openmaic-independent.test.ts tooling/spikes/openmaic.test.ts tooling/spikes/probe-evidence.test.ts tooling/spikes/probe-independent.test.ts
```

## 接口与证据边界

另只读查看OpenMAIC route.ts:355的`apiSuccess({ content, effectiveOutline })`、scene-types.ts:36–41的GeneratedInteractiveContent（html及可选scientificModel/widgetType/widgetConfig，无顶层type），以及scene-generator.ts:1351–1355的widget返回对象（html/widgetType/widgetConfig，无type）。三份源码的SHA256见独立JSON，并与已记录source-manifest一致。interactive判别来自effectiveOutline.type，不能要求此接口content.type为interactive。

原始完整HTTP响应未留存，故此处用源码契约与既有报告交叉核对，不能从HTML重新证明该次响应所有字段，更没有独立重放接口。完整费用/提供方调用数、其他widget、论文引用、生产鉴权、故障和可用性未验收；源码目录摘要不证明部署构建提交。本次没有实现AnimProvider、P1-10或ReinLab live端到端链路，未替代Claude最终签核。

机器可读结果见`independent-test.json`；独立产物摘要见`independent-test.sha256`。

## 防重与保存修复复验

复跑claim/save模块4例：40个并发争抢只获胜1个；原报告和获胜请求不能覆盖；请求文件写失败保留failed-before-submit占位（callCount=0）；HTML已存在时不覆盖，记录failed-to-save及已发生HTTP次数。

另新增`probe-independent.test.ts`独立5例：循环引用导致请求序列化失败时同样留下防重占位；通过Node子进程预加载替换global.fetch，离线检验CLI `--output`及成功、网络未知结果、响应JSON解析失败、HTML保存冲突四个分支。mock fetch执行时直接读取报告，确认先持久化submission-intent和callCount=null，再开始提交；响应处理失败与保存失败状态分开。每个分支第二次运行均被claim拒绝，原报告字节保留，生成mock调用合计一次（重复运行另有三次缺字段校验，不属于生成）。保存冲突保留既有HTML。

mock响应仅用于脚本故障测试，全部输出在自动清理的临时目录，不属于live样本或真实生成证据。没有访问任何真实生成接口；本轮未重复浏览器操作，原始interactive.html及真实生成报告不变。新增测试及被测脚本摘要记录在独立JSON与SHA256清单。

## P1-01依赖边界修正记录

此前全仓lint因本独立测试导入`node:vm`失败，这是当时独立复验遗漏的检查。现已移除该导入和相应执行方式，保持P1-01边界规则原样；改用`execFileSync(process.execPath, ['--input-type=commonjs'])`，标准输入依次提供静态DOM支架、原样提取的主脚本和固定快照操作，子进程输出state/HUD JSON，再用独立闭式解断言。没有使用eval、Function、vm或把违规导入隐藏到字符串。

修正后亲跑`pnpm lint`输出“依赖边界检查通过”，相关21例再次全部通过，报告已更新。原始HTML及先前浏览器结果不变；本次没有任何真实生成请求。
