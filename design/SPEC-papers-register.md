# papers_register（论文入档补充决定）· 实现说明

依据：`design/prd/02-foundation.md`「论文入档补充决定（2026-10-30）」。方案已定，不再讨论。

## 1. 契约

新增业务能力 `papers.register`，工具名 `papers_register`。

参数（都不由模型填账户/档案）：

| 参数 | 必填 | 说明 |
|---|---|---|
| `path` | 是 | 当前档案工作区里的 PDF 路径（绝对路径或相对工作区根） |
| `title` | 是 | 论文标题；未知就照实问用户或留待补，不编造 |
| `authors` | 否 | 已知作者（数组或字符串） |
| `doi` | 否 | DOI 或 arXiv 号，未知留空 |
| `source` | 否 | 来源 URL，未知留空 |

返回：`assetId`、`status`、`title`/`authors`/`doi`/`source`、`sha256`、`path`（正式文件引用）、`reused`。
解析失败时 `status='parse_failed'` 并带 `reason`，不编造全文或页码。

## 2. 边界

- 文件必须在当前档案工作区内（ricky realpath 后仍在根内、不是符号链接逃逸），可读、是 PDF（`%PDF-` 头）、大小在既有上限内。
- 审批**绑定内容**：请求审批时读文件、算 sha256、把元数据与摘要放进 effects；批准后重新读并比对摘要，不一致就拒绝（不批准一个已被换掉的文件）。
- 同档案同摘要已有资产 → 直接返回已有资产，不再审批、不再建资产、不再下载。`papers_fetch` 已入档的同文件同样命中。
- 拒绝：不建资产、不改名，工作区原文件保留。
- 不新增 OCR；解析失败如实返回。

## 3. 共用「入档成功」处理

两种入口（`papers.fetch` 远程获取、`papers.register` 工作区登记）走同一条收尾：

1. 写资产（复用 `PaperDeposit` 与 `paper_asset`，不另造体系）
2. 自动改名：只给「占位或未固定的独立精读」补论文名；用户手动名与课题名不动
3. 同步：更新档案 `last_activity_at`/`version`，推 `dossier.changed`；写 `user_op` 操作记录，下次相关模型调用可感知

## 4. 不做

不改前端样式与交互；不给 `papers_fetch` 加本地文件参数；不加 OCR、边缘情景区块或验收脚本。
