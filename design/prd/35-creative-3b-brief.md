# 35 · 创作台 3B · 真出片（按实测定稿）+ 场景模板给导演用 · 给 DSH 的开场

日期：2026-11-10。分支 `codex/creative-3`。

输入：[20-creative-contract.md](20-creative-contract.md) **§13.9**（刚补，替换原 3B 的几处约定）、§13.4 的 3B 接口、§13.8 的白模布局。实测记录：[BENCHMARKS.md](../BENCHMARKS.md) 2026-11-10 夜三节，[creative-3/scene-first](../walkthroughs/creative-3/scene-first/)、[creative-3/kit](../walkthroughs/creative-3/kit/)。

## 已经验证过的（照做，不用再探）

- Seedance 2.0 `doubao-seedance-2-0-260128`，480p 5 秒，一段 ¥2.5–2.8、2.5–4 分钟；
- 参考视频必须公网 URL：预演转 mp4（24fps）→ 传 TOS 私有桶 `rein-lab-creative` → SigV4 预签名 2 小时 GET 链接；
- 立绘当参考图（base64）人物一致；
- 预演清楚 + 模板家具 → 构图、家具、走位、推镜几乎 1:1；
- 提示词结构见 §13.9 第 3 条；画面外的门窗要写明，否则模型会补一道门。

TOS 密钥已在 `local.env`：`TOS_ACCESS_KEY / TOS_SECRET_KEY / TOS_BUCKET / TOS_REGION`，只在进程内存里读；子账号只有这个桶的权限。

## 要交的

1. **出片**（§13.4 的 takes 接口）：转 mp4、传 TOS、签链接、拼提示词、建任务、轮询、取回存本机（和 MVP-2 同一套存储）、推 `creative.take`；失败取回标 `unsaved`、只重试取回。
2. **定稿**：候选上「出定稿」= 同一镜同一份参考再出一次 720p，记成新候选，`basis` 指向草稿。
3. **选用、拼片**：`PUT selected`、`POST cut`（ffmpeg 硬切拼接），推 `creative.cut`。
4. **计费**：`usage.total_tokens` × 官方价（带视频 ¥28 / 百万，不带 ¥46），记已知；失败记 0 注明。
5. **模板给导演**：`propose_whitebox` 可选 `template`；模板和家具名单从前端 `furniture.ts` 抽成共享模块，前后端共用；工具说明里列出模板和家具名，提示词底线：「家具的 label 用库里的名字，尺寸用真实尺寸」。
6. 上一轮遗留的三条后端问题一并修：已有房间时 `place.room.set` 不进提议、`whitebox.prim.update` 跑硬约束、导演回复说明摆设少的原因（见 `creative-3/RESULTS.md` 末尾）。

## 不做

- 换平台；4K；配音配乐字幕转场；
- 前端（出片格子、候选并排、定稿按钮、拼片面板我来做）；
- 新模板（茶馆、街巷等）——先把门厅这一套跑通。

## 预算（真花钱前我报给用户）

验收 3 镜 × 2 候选 480p ≈ ¥15–17，1 镜定稿 720p ≈ ¥6，你自测 ¥5–10，**合计约 ¥30**。

## 规矩照旧

契约已有语义不改，要改先回来说；不加审计类测试，针对性回归照写；费用只记不拦；key 只在进程内存里读；每批一个提交，`--no-gpg-sign`。

## 交付单写清楚

- 一镜出片实测多久、多少钱；
- TOS 上的文件怎么命名、多久清理；
- 在门厅第 2 镜留一个出好的候选，我直接验；
- 和契约 §13.9 有出入的地方。
