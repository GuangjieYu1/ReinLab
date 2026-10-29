# 01 · 全文来源兜底与候选预检

状态：用户已确认；2026-10-27。实施顺序：02 → 01 → 03。来源：[走查 R3/R4、C2](../walkthroughs/2026-10-26-research-read/RESULTS.md)。

## 1. 要解决什么
Toolformer 的 OpenAlex 记录缺全文链接/许可，当前直接降为摘要；候选却曾显示“有开放全文”。候选与下载必须共用来源解析，区分“找到入口”和“全文已核验”。

## 2. 定下来的决定
- 按用户指定顺序：OpenAlex 的可用 PDF（含其他 locations）→ arXiv → 论文落地页公开 PDF；缺链接、下载失败或文本不可读均继续下一源，记录原因。
- arXiv 优先从 DOI/locations 解析标识；没有标识才按标题检索，并核对标题、作者及年份。多项匹配不擅自认定；不改用户选择的 paperId。落地页只解析明确 PDF 链接（如 citation_pdf_url），不执行页面脚本。
- 候选阶段对本次最多 8 篇做有界预检：元数据/页面定位＋小范围 PDF 读取，复用结果；暂态失败记 unknown。不下载整篇、不生成 asset。批准 papers.fetch 后才完整下载、校验 PDF 和文本层，得到实际页数；纯扫描件记 text_unavailable。
- 公开阅读、OA 标记、再利用许可分别记录。许可/权利人没写就存 null；记录最终副本自己的声明，不继承另一个 location 的许可。arXiv 非独占分发许可不能写成 CC；仅开放阅读不代表允许再发布。
- 否决“is_oa/有链接就承诺全文”及“license 为空就断言只有摘要”：二者都不能证明实际可获取性。

## 3. 改哪里
后端 TS 路径相对 `services/control/src/`：`mcp/papers.ts` 的 search/fetch 共用新增来源 resolver；`mcp/paper-http.ts` 增加有界 probe，保留逐跳域名/DNS检查；`clarify/candidates.ts` 去掉 downloadable 猜测。更新 `tools/registry.json` 输出契约及明确 egress 域名，不从页面动态放行域名。`read_candidate.metadata`、`paper_asset.view_metadata` 保存来源判断；`api/read-view.ts` 透传。Claude 接候选字段/文案，布局交互不变。

## 4. 接口
请求仍为 `papers.fetch({paperId})`，下载批准覆盖同论文的允许来源兜底。候选新增 `fullText:{status:reachable|unavailable|unknown,sourceType,url,checkedAt,reason}`；reachable 显示“找到全文入口，下载后核验”，unknown 显示“全文待确认”。旧 access 只作兼容字段，不再负责候选判断。
fetch 保留 `status:full_text|abstract_only`，新增 `reason`、`provenance:{sourceType,landingUrl,finalUrl,sourceVersion,license,licenseUrl,copyrightNotice,rightsHolder,checkedAt}`（缺项为 null）；全文成功另给实际 pages，许可不授予额外操作权限。

## 5. 验收项
1. 真实检索 Toolformer → arXiv 2302.04761 可定位，候选提示入口待下载核验；批准后 papers.pages 能读原文。
2. 核对该副本 → arXiv 版本、最终 URL、实际页数与原文一致；许可记录为原站非独占分发许可，不冒称 CC。
3. 选只有落地页链接的真实论文 → 从该页定位公开 PDF；元数据许可缺失不编造，访问被限制则保留摘要和原因。
4. 候选预检遇超时/403/无明确链接 → 分别显示未知/受限/未找到；不承诺有全文，不绕过登录或付费墙。
5. 预检可达、下载时失败或无文本层 → 尝试下一来源，最终如实降级；不编造页码或引用，不绕过下载批准。

## 6. 不做的事
不批量爬站、不绕过访问限制、不做 OCR、不公开分发全文。依据：[OpenAlex location 字段](https://help.openalex.org/data/locations/)、[arXiv 阅读与许可说明](https://info.arxiv.org/help/license/index.html)、[Toolformer 原页与许可入口](https://arxiv.org/abs/2302.04761)。
