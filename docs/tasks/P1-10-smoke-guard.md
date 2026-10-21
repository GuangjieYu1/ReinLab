# 单次真实冒烟预算保护

本批CLI临时guard，非长期网关、非模型替身。真正DeepSeek key只由guard进程持有；OS只有32随机字节base64url形成的43字符临时token。全新专用smoke账号，不覆盖已有连接。当前实施仅测试transport，不读取真实key或请求真实API。

## ToSpec

startOneShotSmokeGuard({bindHost,port?,incomingToken,upstreamKey,markerPath,timeoutMs?,testOnlyTransport?})返回{port,status(),close()}。status只含forwardCount/bytes/priceBound/status，无headers/body/key/prompt；priceBound='0.500000'是保守预留估算，不是官方bytes→tokens硬证明。仅固定POST /v1/chat/completions转https://api.deepseek.com/chat/completions；默认不实现/models。无redirect、无自动retry。testOnlyTransport仅NODE_ENV=test。

先认证timingSafeEqual，再最多65536字节完整读取/UTF8严格JSON校验；固定model=deepseek-v4-flash，max_tokens整数1..1024，n缺省或1，messages1..32仅字符串/纯text数组；允许标准function tools与公开文本协议字段，拒图像/音视频/file/servertools/search/未知cap字段。归一JSON重编码消除重复键解析歧义，并复查字节上限。验证通过后私有目录O_EXCL/0600 marker，写入+fsync文件+目录之后才唯一fetch。并发/重试/重启同marker均拒；未知结果也不删除marker。forwardCount指当前guard实例实际transport调用次数，已有marker重启status=spent、count=0，不冒充已知账单。

请求需完整验证，采用有界buffer作fetch body，避免直接Node IncomingMessage交fetch导致duplex/提前转发；响应Readable.fromWeb→pipeline透明传递内容与状态、背压/取消联动AbortController；上游header只转content-type。clientclose/timeout/guardclose都取消，既有marker不回退。bindHost只允许显式loopback/私有IPv4，禁止0.0.0.0；root另负责容器到私有端口可达性。

RoleRuntime.configureSmokeGateway({origin,token})：origin仅http://host.docker.internal:port，test可127.0.0.1；根路径无userinfo/query/hash。token43字符且拒sk-。先检查project/plugin与provider connected（任何已有连接拒）；原始global config只留闭包。SDKauth.set仅deepseek临时token，global.config.update仅配置deepseek baseURL、模型真实context1048576/output1024/reasoningfalse。返回configured:true/outputCap:1024/cleanup()，不返回config/token；reader无该方法。cleanup用SDKrawSet恢复原global文件+auth.remove临时key，失败可重试清理但不自动重新配置。SDK无auth.get，必须使用新账号前提，connected列表只能辅助拒绝。

公开依据：[DeepSeek价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[Chat API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)、[token计算](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/)。峰价2/8元每M，旧v4-flash别名仍可调用并按Flash计费；token页仅估算，不把65536字节当官方硬token证明。来源仍direct_provider_usage，未来signed gateway_callback另行接入。

## ToTDD

先stub red；本地loopback/test transport验证一次/并发/marker重启、非法body/auth/path/model/cap/多模态拒绝且零forward、SSE/JSON透明、取消与超时不重试、private marker权限、production不允许testtransport。真实SDK HTTP fixture验证configure路由与模型限制、临时auth不进config/响应、无旧连接覆盖、raw恢复与auth删除、非法origin/token、reader不含管理能力。无真实模型调用。

## 作者验收与接口收口

有效guard red为16失败/1通过（唯一通过是拒注入的负例）；runtime SDK stub red为9失败。实现首轮26/26，扩展Node chunked、guard主动取消、cleanup raw/auth分别失败恢复、重复管理配置拒绝等后 **35/35**（guard19+runtime12+原runtime observation4）。仅loopback/test transport，无真实key读取、无外网模型请求。

额外公开 `RoleRuntime.cleanupSmokeGateway():Promise<{cleaned:true}>`，在setup失败而cleanup也部分失败时，只重试剩余raw恢复或auth删除，不重新设置临时auth/config。configured返回cleanup函数与直接cleanup方法均无敏感DTO。provider connected非空、已有config apiKey一律拒，仍须新账号前提，因为SDK没有完整auth枚举/备份能力。配置会固定titleoff/onlydeepseek/model/small_model；cleanup恢复原raw文件。

control tsc、tooling guard独立strict tsc通过；lint首次命中process.getuid加载器静态规则，已沿用现config.ts的node:process命名getuid导入修复，不放宽规则。最终结果见README/report。实际单次真实smoke与私网端口连通由root另执行；本模块无credential loader、无默认真实调用入口。
