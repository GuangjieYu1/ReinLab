# 后端设计 · 总览：整个系统

版本 0.1 · 2026-10-18 · 配合 [BACKEND_MEMORY_SESSION.md](BACKEND_MEMORY_SESSION.md)（记忆与会话的规则细节）一起读

这份文档只放结构，规则写在记忆与会话那一篇。八张图依次回答八个问题：

1. 系统分几层
2. 记忆怎么流动
3. 一个需求怎么穿过多个工作台
4. 一次运行经过哪些环节
5. 门禁怎么流转
6. 台与台之间怎么委托
7. 数据存在哪里
8. 云上怎么部署

---

## 1. 分层

```mermaid
flowchart TB
  C[客户端<br/>iPad / 浏览器 · 七个工作台] --> G[网关<br/>登录 · 多租户 · 限流]
  G --> CP
  subgraph CP[控制面 · ReinLab 自己写]
    D[档案 · 角色 · 门禁<br/>运行令牌]
    L[事件账本<br/>只追加 · 审计重放]
    M[记忆服务<br/>L1–L4 · 按角色过滤]
    W[委托 · 编排<br/>Hatchet]
    R[模型路由<br/>位置 → 模型 / 凭据]
    I[待批准收件箱<br/>上线时弹出]
  end
  CP --> B[翻译层 bridge/openscience<br/>概念下行 · 事件上行 · 统一风格]
  B --> X
  subgraph X[执行面 · 每账户一个隔离容器]
    OS[OpenScience 运行时<br/>上游依赖 · 档案 = project]
  end
  X --> P[模型提供方<br/>API · 会员 · 外部执行器 · 自托管]
  X --> S[专用服务<br/>ComfyUI · Data Formulator · OpenMAIC · OCR]
```

- 控制面是我们自己写的部分。
- 翻译层是唯一同时认识 ReinLab 与 OpenScience 两边的地方。
- 执行面原样使用 OpenScience，跟随上游升级。

## 2. 记忆的流动

```mermaid
flowchart BT
  subgraph A[档案 A · 群论课]
    A2[L2 档案记忆<br/>study_plan · 按角色可读]
    A1a[L1 会话 · U1 工作区]
    A1b[L1 会话 · 独立审查]
  end
  subgraph B2[档案 B · 东山拍照]
    B2m[L2 档案记忆<br/>机位 · 服饰 · 现场记录]
    B1a[L1 会话 · 计划助手]
    B1b[L1 会话 · 现场助手]
  end
  A2 -- 提议升级 --> IN[待批准收件箱<br/>上线时弹出]
  B2m -- 提议升级 --> IN
  IN -- 批准后写入 --> L3[L3 个人记忆<br/>侧写 · 偏好 · 器材 · 经验]
  IN -- 批准后写入 --> L4[L4 知识库<br/>论文 · 地点 · 资源 · 数据]
  L3 -. 按引用 · 按角色过滤 .-> A
  L4 -. 按引用 · 按角色过滤 .-> B2
  A -- 委托 --> B2
```

会话之间、档案之间默认互相看不见。

## 3. 跨台长链

```mermaid
flowchart LR
  subgraph 学一样东西 → 沉淀成可用项目
    R1[研究台<br/>研判 · 调研] --> C1[课程台<br/>学习 · 理解] --> E1[工程台<br/>应用 · 做成项目] --> A1[自动化台<br/>变成例程]
  end
  subgraph 约一次拍摄 → 一部作品
    R2[研究台<br/>全网调研景色] --> X2[探索台<br/>机位 · 方案 · 现场] --> K2[创作台<br/>后期 · 小说] --> A2[自动化台<br/>归档 · 回收]
  end
```

每个箭头都是一次委托（第 6 张图），它们共用同一个底座：账本、记忆、委托、门禁、模型路由。

## 4. 一次运行的生命周期

```mermaid
flowchart TB
  T[触发<br/>你点按钮 · 例程定时 · 别的台委托] --> K[控制面<br/>查门禁 · 划预算 · 签发运行令牌]
  K --> Dn[翻译层 · 下行<br/>生成 agent 定义 · 注入过滤后的记忆]
  Dn --> O[OpenScience 运行<br/>工具 · 子运行 · 结构化卡片工具]
  O <--> AP[审批卡<br/>风险动作停下 · 你决定后回填]
  O --> Up[翻译层 · 上行<br/>事件去重 → 账本 → 界面]
  Up --> F[收尾<br/>登记产物 · 写会话摘要 · 提议升级]
```

## 5. 门禁状态机

```mermaid
stateDiagram-v2
  [*] --> 锁定
  锁定 --> 可开始: 上一段已批准
  可开始 --> 执行中: 你手动开始
  执行中 --> 待批准: 交回可审阅的产物或 Plan
  待批准 --> 讨论中: 讨论修改
  讨论中 --> 待批准: 改完（仍不算批准）
  待批准 --> 已批准: 你批准
  已批准 --> [*]: 只把下一段变为「可开始」
```

适用于：课程的七段备课、维护的四道工序、例程上线，以及所有「写入需批准」的动作。门禁的判断放在控制面，页面、聊天、接口三个入口走同一个判断。

## 6. 一次委托

```mermaid
sequenceDiagram
  participant C as 课程档案（发起）
  participant K as 控制面 · 委托合同
  participant R as 研究台档案（执行）
  participant L as 事件账本
  C->>K: 请求调研（只给引用、可读范围、预算、期望格式）
  K->>K: 校验范围与预算，从发起方预算里划出
  K->>R: 开运行（携带受限的运行令牌）
  R->>R: 群研 · 精读 · 子运行
  R-->>L: 记一条（执行方）
  R->>K: 产物与负结果（按 schema）
  K->>C: 按引用交回（ID + 版本）
  C-->>L: 记一条（发起方）
```

## 7. 控制面数据模型

```mermaid
erDiagram
  ACCOUNT ||--o{ DOSSIER : owns
  ACCOUNT ||--o{ CREDENTIAL : holds
  DOSSIER ||--o{ THREAD : has
  DOSSIER ||--o{ RUN : has
  ROLE ||--o{ RUN : plays
  ROLE ||--o{ THREAD : plays
  RUN ||--o{ EVENT : emits
  RUN ||--o{ ARTIFACT : produces
  DOSSIER ||--o{ MEMORY_ITEM : scopes
  PROMOTION ||--o{ MEMORY_ITEM : creates
  RUN ||--o{ PROMOTION : proposes
  DOSSIER ||--o{ DELEGATION : sends
  DELEGATION }o--|| RUN : executes
```

- 每张表都带 `account_id`，用 Postgres 行级安全（RLS）做租户隔离。
- `EVENT` 只追加，去重键是 OpenScience 的 runID + sequence。
- `MEMORY_ITEM.layer` 取 L1–L4，`supersedes` 串起版本链。
- `PROMOTION` 批准后才生成 L3 / L4 的条目。
- `CREDENTIAL` 只存类型与指纹，密文放在 KMS 里。

## 8. 云端部署

```mermaid
flowchart TB
  GW[网关<br/>登录 · 租户 · 限流] --> CS[控制面服务<br/>TypeScript · 无状态多副本]
  GW --> HT[Hatchet 编排<br/>长流程 · 等待批准 · 续跑]
  CS --> DL
  HT --> DL
  subgraph DL[数据层]
    PG[Postgres<br/>RLS · pgvector · 账本]
    OBJ[对象存储<br/>产物 · 工作区快照]
    KMS[KMS<br/>凭据加密]
  end
  DL --> EX
  subgraph EX[执行面]
    AC[账户容器 × N<br/>OpenScience · 按需唤醒 · 空闲休眠]
    GPU[GPU · 专用服务池<br/>ComfyUI · 转录 · OCR]
  end
  EX --> MP[模型提供方<br/>API · 会员 · 外部执行器 · 自托管]
```

### 8.1 已定（2026-10-19）

前提：第一年为你自己加少量朋友（< 20 人）；进入工作台要求永远秒开；用托管平台，尽量不管服务器；服务器放在亚洲。

| 部件 | 选择 | 说明 |
|---|---|---|
| 地区 | **东京**（新加坡备选），**不用香港** | 据目前了解，OpenAI / Anthropic 的 API 不对香港提供服务；日本、新加坡在支持范围内。开通前逐家核对 |
| 账户容器 | **Fly.io Machines**，每账户一台**常驻**机器 + 一块持久卷（档案工作区） | 控制面通过 Machines API 为账户建、停、扩机器；工作区每晚快照到对象存储 |
| 控制面、Hatchet | Fly 同区，各 2 副本 | 与账户容器内网互通 |
| 数据库、身份、对象存储、密钥 | **Supabase**（东京） | 托管 Postgres，原生支持 RLS 与 pgvector；Auth 作为网关身份层；Storage 放产物与快照；Vault 存凭据，应用层再加一层信封加密 |
| GPU | **Modal 按需** | 只在 ComfyUI 出图、研究台实验时拉起；复用 OpenScience 已有的 Modal 计算控制面。起步阶段不自建、不常驻 GPU |

**秒开怎么保证：**
- 界面数据（档案、账本视图、记忆）由控制面直接给，不依赖账户容器。
- 账户容器常驻，第一次调用 Agent 不用等唤醒。
- 将来用户多了，只需把常驻改成「空闲休眠、按需唤醒」，架构不变。

**成本量级（以开通时价格为准）：**
- 常驻账户容器：约每人每月 10–20 美元。
- Supabase 付费版：每月 25 美元起。
- GPU：按秒计费。
- 20 人以内合计约每月一两百到三百美元，主要随常驻人数增长。

**开通前要核实的：**
1. Fly 东京区当前提供的机型与卷。
2. 各模型提供方对日本 / 新加坡出口 IP 的支持情况。
3. Supabase 东京区的套餐限制。

---

## 还没定的（下一轮讨论）

1. **研究台第二篇：** 群研的 Agent 间通信在 OpenScience 之上补多少。
2. **前端托管：** 前端静态资源放在哪里（Fly 同站，或 CDN），以及大陆访问速度要不要额外加速。
