# 探索台第二版 · 以后再优化

基线：`codex/explore-2` / `5ec9b91`，2026-11-02。只读 PRD 09、契约 10（含 §7）、走查 RESULTS/REPORT 与代码；未跑测试、未调用模型，性能收益与耗时待实测；已回归修复项不重复列为未修。

## 1. 性能

- `src/components/workbenches/explore/live/WhiteModel.tsx` · 最多 3000 栋逐栋建 Mesh、边线和阴影，已有按需绘制但未见密集场景性能实测 · 手机绘制调用与首次建模可能卡顿 · 测量后按材质合并几何、简化远景与阴影范围，保留楼 ID 拾取 · 优先级：中
- `src/components/workbenches/explore/live/WhiteModel.tsx` · 卸载只释放 renderer/controls，未逐项释放 geometry、material、CanvasTexture 和阴影资源 · 反复切机位可能累积 GPU 内存 · 遍历场景释放资源，共享材质去重释放 · 优先级：高
- `src/components/workbenches/explore/live/StopPanel.tsx`、`field/FieldScene.tsx` · 1–2 MB 场景 JSON 在主线程解析，模块级 sceneCache 无容量淘汰，现场面另取另存 · 多机位长会话会增加解析开销与内存 · 共用按场景 ID/version 的有限缓存及在途请求，测量后决定是否移到 Worker 解析 · 优先级：中
- `live/review/ReviewFace.tsx`、`Photos.tsx` · 接口虽分页，页面仍循环拉完所有页再显示，照片变化后重拉全量，网格未虚拟化 · 数百至数千照片拖慢首屏及精选操作 · 按需分页、增量更新照片状态、虚拟化分组网格 · 优先级：中
- `live/offline/pack.ts`、`services/control/src/explore/offline.ts` · 每包重复保存场景/参考图等资源，大小估算主要来自瓦片，删除包未清理对应 IndexedDB 快照 · 多日出行占用与展示大小可能不一致 · 汇总整包实际字节、按版本复用公共资源并清理无引用快照，保留未同步记录 · 优先级：中
- `public/explore-sw.js` · 同一 shell 缓存长期累积带哈希构建产物，命中静态资源也后台取网，离线资源用全缓存搜索 · 更新次数和离线包增多后增加空间及查找/联网开销 · 按构建版本管理页面壳、清理不用的旧资源，离线请求定向当前包 · 优先级：中
- `services/control/src/explore/scene.ts` · 缓存每次读盘并 JSON.parse，同区域并发 miss 没有共享在途请求，临时文件名也只区分进程 · 重复 Overpass 请求、解析和同进程缓存写入竞争 · 按区域合并请求、加有界内存缓存，临时文件使用独立名称 · 优先级：中
- `services/control/src/explore/service.ts`、`light-job.ts`、`light2.ts` · 普通停留点编辑也可能同步重算山影，双位置按全天两分钟采样逐楼求交，各批异步任务可重叠 · 连续编辑放大取数和 CPU 开销 · 只按受光输入变化触发、合并同点最新任务、复用几何索引与太阳采样，记录耗时后决定计算隔离 · 优先级：中
- `services/control/src/explore/uploads.ts`、`photos.ts` · 上传完成回调在数据库事务内等 EXIF/Sharp 派生处理，原图整张读入内存，无独立处理队列 · 多批上传可能占满连接与图像处理内存 · 完成登记后进入有界处理队列，缩短事务并保留真实 processing/failed 状态 · 优先级：中
- `services/control/src/explore/photo-store.ts` · storageUsage 每次递归遍历照片目录，上传进度会触发页面反复查询 · 照片越多磁盘元数据扫描越重 · 上传/删除时更新占用统计，磁盘空闲查询短时缓存 · 优先级：低
- `services/control/src/explore/book-job.ts`、`books.ts` · 每次导出读取字体及全部参考图，排版仍在控制面进程执行 · 多份长计划同时导出可能拖慢其他请求，实际耗时待测 · 仅加载本版所需图片、复用字体字节、限制导出并发，必要时独立排版任务 · 优先级：中
- `services/control/src/explore/scene.ts`、`photo-store.ts`、`src/data/explore-live.ts` · 场景整份 JSON 往返，照片文件读取返回整份 Buffer · 大响应增加内存和传输等待 · 核实入口压缩与 ETag，照片流式返回，页面按需取几何；保持 explore_scene 已有统计摘要返回 · 优先级：中
- `src/data/explore-live.ts` · 历史流泄漏已修，但仍顺序回放最多 11 个旧轮次，每轮可等 2 秒，多个 subscribe 各开 SSE · 长对话恢复等待、多面板连接占用仍值得减小 · 用有结束边界的分页历史读取，共享档案事件连接，实测切页后的连接释放 · 优先级：中

## 2. GAP

- 探索入口文件列（走查 RESULTS 段 0） · 【已知】只显示 4 份探索档案且无新建空位，工作台菜单能新建 · 入口无法完整访问已有档案 · 列表支持全部档案与显式新建入口 · 优先级：中
- V7 / V4（走查 RESULTS 待验） · 【已知】原图对时、“到了”实地定位及高德跳转未用原图/实地真机验完 · 核心现场及回顾路径仍有真实条件待验 · 用相机直出 JPG 和实际拍摄地点补走查，分别记录 GPS、无 GPS、时差与跳转结果 · 优先级：高
- `scene.ts` 建筑源 · 【已知】陆家嘴 512 栋中 301 栋缺高度，OSM 原始数据缺失 · 楼影估算覆盖受限 · 比较 Overture 等候选源的真实覆盖、来源与可用性，缺项继续标未知 · 优先级：中
- `packages/contracts/src/explore.ts`、契约 §7.6 · 【已知】用量用途仍只有 4 类，回顾看图记 vision · 无法拆分挑片、对照、游记和经验的使用量 · 同步扩展 contracts、调用归属与展示，未知不记 0 · 优先级：中
- 同 effect 审批去重（走查 RESULTS 回归） · 【已知】普通新计划回归无重复卡，但同一改动连提两次合成一张卡只有单测 · 页面与会话续接的实际效果尚未复现 · 下次真实使用遇到同一改动时核对卡片和应用结果，不为本项新造付费脚本 · 优先级：低
- `scene.ts`、`light2.ts`（PRD §7.1） · 建筑 baseM 固定 0，楼影求交未纳入基底高差 · 坡地与高架附近可能把建筑和机位错误当同一地面 · 接入有依据的相对高程并统一计算/渲染基准，无法取得时标未知或平地假设 · 优先级：高
- `light2.ts`、`WhiteModel.tsx` · 后端 shapesOf 只取外环，白模却渲染 holes；受光机位在建筑内院时可能不一致 · 内院楼影判断可能漏掉内壁遮挡 · 求交包含内环及实体内外关系，保持前后端同一几何语义 · 优先级：中
- `light2.ts` · 无 scene 时太阳位置回退到 [0,0]，时区偏移取计算当天而非拍摄日 · 缺建筑时仍可能给错误夜间状态，跨夏令时计划可能错时 · 太阳独立使用停留点坐标，偏移取目标日期适用值 · 优先级：高
- `light2.ts` · 街区未选 areaRef 时 segments 改 unknown，但 litWindows 仍来自原计算 · 同一结果同时含未知状态和具体见光窗口 · 无参考点时同步清空窗口，保留明确缺项 · 优先级：中
- `light-job.ts` · 自动重算 stopIds 直接 slice(0,8)，后续点没有继续排队 · 一次修改超过 8 点可能留下旧受光结果 · 限制并发而不丢任务，逐批处理全部变化点 · 优先级：中
- `light-job.ts`、`service.ts` · 已有 terrain.horizon 会直接复用，areaRef 变化仍可能沿用区域中心山影，重算输入校验也未覆盖目的地时区 · 换参考点/时区可能保留旧计算依据 · 将位置、日期、时区及数据版本纳入派生输入标识并据此失效 · 优先级：中
- `scene.ts` · 缓存键将坐标取两位小数，查询半径却围绕首次真实位置，复用时未检查新点的完整覆盖 · 同格较远机位的周围 1 km 可能不全 · 用固定格心加覆盖余量，或复用前校验覆盖并明确实际范围 · 优先级：中
- `WhiteModel.tsx`（PRD §7.3） · 直射光开关只判断太阳高度大于 0，未使用山挡状态 · 提示为山挡时白模仍可能画出阳光楼影 · 将山影状态接入视觉光照，继续区分示意阴影与权威受光 · 优先级：中
- `offline/sw.ts`、`offline/pack.ts` · cacheShell 发消息即返回，SW 吞掉单项失败，missingIn 不检查页面壳 · 包可能显示 ready 但断网重开缺脚本 · 等待壳缓存完成回执，将必需构建资源纳入完整性检查 · 优先级：高
- `public/explore-sw.js`、`offline.ts`、`field/FieldScene.tsx` · 场景/天气 URL 不带包版本，离线 fallback 用 caches.match 搜所有包 · 同档案多个拍摄日/修订可能读到另一包的场景或天气 · 使用包内不可变资源地址或指定包缓存读取，绑定出发快照 · 优先级：高
- `offline/pack.ts` · 续下载按 rec.done 跳过资源，校验发现缓存已被清理后只列 missing · 缺资源的包再次准备仍可能不补下载 · 下载前核对实际缓存，将 missing 重新加入待下载项 · 优先级：中
- `offline.ts` · 瓦片下载前只检查已有 tile_bytes，未计入本次响应及并发在途大小 · 临近 50 MB 时可能越过既定上限 · 对新增字节做原子累计与限额判断，并处理重复瓦片请求 · 优先级：中
- `review-tools.ts`、`review.ts`、插件 explore_compare（PRD §6.2） · 默认用当前修订，显式传旧 revision 也仍用当前 plan.document 对照 · revisionUsed 可能与实际对照内容不符，未落实默认出发版本 · 按修订读取保存的计划正文，默认选出发快照并提供版本切换 · 优先级：高
- `review.ts` · 对照光线仍只读取第一版 stop.light.lit，照片查询固定 limit 5000 未标截断 · 楼影/双位置信息未进入对照，大图库证据可能不全 · 接入 light2 与依据快照，分批读照片或明确返回覆盖范围 · 优先级：中
- `live/field/LiveField.tsx`、`useFieldLog.ts` · 记录界面有重新关联，但未见撤销、改正文及冲突选版本入口；更正成功未更新原队列 attention 状态 · 契约更正能力尚未完整落到用户操作 · 补最小更正/冲突处理入口，成功后刷新原记录有效状态 · 优先级：中
- `photos.ts:listPhotos` · 分页只用 created_at 游标和排序，无稳定 ID 次序 · 相同时间戳跨页可能漏照片 · 改用 created_at + id 复合游标与排序 · 优先级：中
- `book-job.ts:generateBook` · 请求绑定旧 revision，但生成时重新读取当前计划并配旧修订快照；版本号计数锁在成果写入前已释放 · 排版期间修改或并发导出可能混版本、重名 · 固定生成输入快照并原子分配成果版本号 · 优先级：中
- iPad / Safari 离线走查（PRD V1/V12） · 【待确认】本轮 RESULTS 明确记录安卓真机通过，未明确 iPad 的证书、中文字体、离线重开结果 · 原定 iPad 使用路径需设备证据 · 核对既有走查记录，缺项再用目标 iPad 补验 · 优先级：中
