# OpenMAIC 课程原生渲染 + 离线缓存（方案 B）实施计划

> 目标：让 iPad 上的 REINLAB **原生渲染课程**（不弹应用内浏览器），并让**已下载的课程离线可用**。
> 前置：`IOS_PLAN.md` 第十四节记录的链路已跑通（CI → 签名 → 装机 → 连服务）。

---

## 一、目标与非目标

**目标**

1. 课程在 REINLAB 界面内原生渲染，不再弹出应用内浏览器 sheet
2. 已下载的课程**离线可用**——Mac 关机、离开局域网都能看
3. 保留交互：切场景、书签续读、进度记录

**非目标**

- 不做课程编辑
- 不做课程生成（生成仍需 OpenMAIC 服务端 + DeepSeek Agent）
- 不追求与原站像素级一致

---

## 二、已验证的事实（这是计划的地基）

| 事实 | 状态 |
|---|---|
| `@openmaic/renderer@0.1.11` 能在 React 19 下渲染 | ✅ 已实测，`openmaicRenderer.test.tsx` 有 2 个用例 |
| 课程内容是纯数据（`Slide` JSON） | ✅ 渲染器与内容分离 |
| renderer 要求 `tailwindcss >= 4` | ⚠️ **硬性要求**，REINLAB 目前是纯 CSS |
| `ClassroomSurface.tsx`（531 行）不可移植 | ⚠️ 深度耦合 zustand store 与 document-store |
| OpenMAIC 无 Service Worker、无 PWA manifest | ⚠️ 浏览器层零离线能力，缓存必须自己做 |
| 课程存于服务端 PG + 浏览器本地 JSON | ✅ `plain-json-store.ts` |
| 主包体积不受影响（renderer 未进打包图） | ✅ 已实测，308.68 kB 未变 |

---

## 三、架构

```
iPad 上的 REINLAB
├─ 学习档案
│   ├─ 【新增】原生课程层
│   │   ├─ 课程列表  ← IndexedDB 缓存
│   │   ├─ 场景编排器（自研，替代不可移植的 ClassroomSurface）
│   │   │   └─ <SlideCanvas>  ← @openmaic/renderer
│   │   └─ 媒体资源  ← 本地缓存（Blob URL）
│   └─ 【保留】应用内浏览器 → OpenMAIC 在线课程库
│       （用于浏览未下载课程、生成新课程）
└─ Mac 上的 OpenMAIC
    └─ 【新增】/api/reinlab/* 导出端点（列表 / 单课 / 媒体清单）
```

**为什么保留应用内浏览器**：生成新课程、浏览未下载课程仍然需要它。原生层负责"已经拿到的课程"。

---

## 四、分阶段

### 阶段 B1：原生渲染（在线取数）—— 约 1.5 天

目标：课程在 REINLAB 界面内渲染，数据仍从 Mac 实时取。
**做完这一步就已经有明确价值**（不再弹浏览器、体验原生），离线是下一步。

**B1-1　Tailwind 4 接入（0.5 天）**

- 只引 utilities 层，**跳过 preflight**，避免重置现有样式：
  ```css
  @import "tailwindcss/utilities";
  @source "../../node_modules/@openmaic/renderer/dist";
  ```
- **验收：现有页面视觉零变化**——改动前后逐页截图对比

**B1-2　OpenMAIC 侧导出端点（0.5 天）**

- `GET /api/reinlab/courses` → 课程列表（id、标题、场景数、封面）
- `GET /api/reinlab/courses/[id]` → 完整课程 JSON（`scenes[]`）
- 允许 CORS（`capacitor://localhost` 与局域网来源）
- 用 `PERSISTENCE_SHARED_OWNER_ID` 固定 owner，绕开 cookie 跨域问题

**B1-3　场景编排器 + 渲染（0.5 天）**

- 新增 `src/components/classroom/native/NativeCourse.tsx`
- 场景切换、上下页、触屏手势
- 书签（续读位置）存 localStorage，沿用现有 `learningState.ts` 的模式
- 复用 REINLAB 现有设计语言（讲义区 + 交互区 + 手记）

### 阶段 B2：离线缓存 —— 约 2 天

**B2-4　课程 JSON 缓存（0.5 天）**

- IndexedDB 存储
- 课程列表每项加「下载」按钮 → 拉课程 JSON → 存本地
- 列表区分「已下载 / 在线」

**B2-5　媒体资源缓存（1 天）⚠️ 本项目最大的技术风险**

课程里的图片、视频、音频都是 **URL 引用**，离线时必须一起缓存，否则课程能打开但画面空白。

- 从课程 JSON 枚举全部媒体 URL → 逐个下载 → 存 IndexedDB（Blob）
- 渲染时把原始 URL 替换为本地 Blob URL
- 需要处理：单课体积（可能几十 MB）、失败重试、并发控制

**B2-6　离线判定与降级（0.5 天）**

- 启动探测 OpenMAIC 可达性
- 可达 → 正常；不可达 → 只用已下载课程，界面明确提示
- 未下载的课程显示「需要连接」

### 阶段 B3：验证 —— 约 0.5 天

- 真机：下载 → 飞行模式 → 打开课程 → 切场景 → 书签续读
- 回归：确认现有 REINLAB 功能与视觉未受影响

---

## 五、风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **媒体离线化** | 课程能开但图/视频空白 | 单独成阶段；先做图片，视频按需 |
| Tailwind 引入破坏现有样式 | 界面错乱 | 跳过 preflight；改完逐页截图对比 |
| renderer 版本漂移（0.1.x） | 升级后渲染异常 | `openmaicRenderer.test.tsx` 作哨兵 |
| iOS WebView 存储配额 | 下载多了被清理 | 加「导出为文件」兜底；限制缓存总量并提示 |
| 场景数多（某课 23 个场景） | 首次下载慢 | 显示进度，支持后台下载 |
| 跨域 + owner 身份 | 数据取不到 | `PERSISTENCE_SHARED_OWNER_ID` 固定 owner |

---

## 六、验收标准

- [ ] 已下载课程：**飞行模式下**能打开、切场景、书签续读
- [ ] 图片与音频正常显示（视频至少不报错）
- [ ] **现有 REINLAB 界面视觉零变化**
- [ ] 离线时未下载课程明确提示「需要连接」
- [ ] 85 个现有测试 + 新增测试全绿
- [ ] 生产产物仍不含 `127.0.0.1:3000`

---

## 七、工作量

| 阶段 | 内容 | 估时 |
|---|---|---|
| B1-1 | Tailwind 4 接入 | 0.5 天 |
| B1-2 | OpenMAIC 导出端点 | 0.5 天 |
| B1-3 | 场景编排器 + 渲染 | 0.5 天 |
| B2-4 | 课程 JSON 缓存 | 0.5 天 |
| B2-5 | 媒体资源缓存 | 1 天 |
| B2-6 | 离线判定与降级 | 0.5 天 |
| B3-7 | 真机验证 + 回归 | 0.5 天 |
| | **合计** | **约 4 天** |

**里程碑切分**：**B1 完成即可交付**（体验原生），B2 才实现离线。
建议先交付 B1，确认 Tailwind 没有破坏现有样式、渲染效果可接受，再投入 B2。

---

## 八、需要你先决定的三件事

1. **媒体离线化的范围**：先只做图片（快），还是一次把视频/音频做全（慢但完整）？
2. **是否保留应用内浏览器入口**？（我的建议：保留，用于生成新课程与浏览未下载课程）
3. **iPad 上的缓存上限**：允许占多少空间（例如 500 MB）？

---

## 九、与其它方案的对比

| | 当前（应用内浏览器） | **方案 B** | 上云 |
|---|---|---|---|
| 课程在哪渲染 | OpenMAIC 页面 | **REINLAB 原生** | OpenMAIC 页面 |
| 离线 | ✗ | **✓（已下载的）** | ✗ |
| Mac 必须开机 | 是 | **否（已下载的）** | 否 |
| 体验一致性 | 弹出网页，有 Safari chrome | **与 REINLAB 同一套界面** | 弹出网页 |
| 工作量 | 已完成 | 约 4 天 | 约 1–2 天 + 每月费用 |
| 主要风险 | — | 媒体离线化、Tailwind 冲突 | ECS 内存、API 额度暴露 |

**方案 B 同时解决了"离线"和"体验原生"两个问题**，而且不产生持续费用——这是它比上云更优的地方。

---

## 十、实施记录与对计划的修订（2026-09-28）

### 10.1 B1-1（Tailwind 4 接入）已取消——前提不成立

原第二节写着「renderer 要求 `tailwindcss >= 4` ⚠️ **硬性要求**」。核查 `@openmaic/renderer@0.1.11` 的实际产物后，这个前提不成立：

- `dist/**/*.js` 里**没有任何 Tailwind 工具类**。全部 26 个 `className` 字面量都是语义钩子（`slide-element`、`base-element-text`、`rotate-wrapper`、`slide-renderer-prose`……）。
- 布局全部走内联 `style`；包自己通过 `dist/styles.js` 的 `SLIDE_RENDERER_STYLES` 在 `<SlideCanvas>` 顶部注入一个 `<style>`，其源码注释写着 "so the package stays self-contained without Tailwind"。
- 唯一与 Tailwind 有关的运行时依赖是 `tailwind-merge`（`dist/utils/cn.js`），那是纯 JS 字符串合并函数，不需要 Tailwind 构建链；由于没有任何工具类传入，它实际是恒等函数。
- `package.json` 的 `peerDependencies.tailwindcss: ">=4"` 与 README 的说明，是包从 OpenMAIC 主仓（一个 Tailwind 项目）里抽出来时留下的声明，不是运行时事实。

**结论：不接入 Tailwind。** 省掉 0.5 天，并且直接消除风险表第二项（「Tailwind 引入破坏现有样式」）与「现有页面视觉零变化」这条验收项的不确定性——不引入就不需要逐页截图对比。

保留哨兵：`NativeCourse.test.tsx` 与 `openmaicRenderer.test.tsx` 一起，会在 renderer 升级后真的开始发射工具类时暴露出来（那时渲染出的元素会带上一批没有样式定义的 class）。

### 10.2 owner 身份：`PERSISTENCE_SHARED_OWNER_ID` 走不通，改用 `REINLAB_OWNER_ID`

原第五节写的是「用 `PERSISTENCE_SHARED_OWNER_ID` 固定 owner，绕开 cookie 跨域问题」。核查后发现两点：

1. 本机部署**没有设置 `ACCESS_CODE`**（`/api/health` 返回 `accessCodeConfigured: false`），而 `lib/server/agent-runtime/shared-owner.ts` 要求 `PERSISTENCE_SHARED_OWNER_ID` 必须与 `ACCESS_CODE` 同时存在，否则启动即抛错。
2. 即便设置了，`ACCESS_CODE` 会让 `middleware.ts` 对 `/api/*` 一律要求浏览器 cookie，而 iPad 上拿不到。

改用导出端点自己的 owner 覆盖：**`REINLAB_OWNER_ID`**。它让 `/api/reinlab/courses*` 直接以指定 owner 读文档，与 cookie、`ACCESS_CODE` 都无关。配合 `GET /api/reinlab/whoami`（在 Mac 浏览器里打开即可读出当前 cookie 的 owner id），配置流程是自解释的。

### 10.3 部署位置：改动要落到真正在跑的那一份 OpenMAIC

本机有两份 OpenMAIC 检出，**不是同一份**：

| 路径 | 角色 |
|---|---|
| `~/Documents/OpenMAIC` | 仓库工作树 |
| `~/Documents/Codex/2026-09-26/new-chat/outputs/OpenMAIC` | **实际部署的那份**：`.next-rhine-v8/standalone/server.js` 以 `0.0.0.0:3000` 在跑 |

两者分支同为 `codex/rhine-openmaic`，只差 `start:rhine` 脚本与 `RHINE_INTEGRATION.md` 的几行。导出端点的源码两份里都有，但**要让 iPad 真的用上，必须重建部署那一份**。

### 10.4 两个只有对着真实数据才会暴露的问题

**(a) owner id 的形状判断反了。** 导出端点最初把 `REINLAB_OWNER_ID` 的校验照抄了 `shared-owner.ts` 的 `/^[A-Za-z0-9._-]{1,128}$/`，也就是**排除** `:`。但 `resolveRequestOwnerId` 返回的是 `anon:<uuid-v4>`——这正是 `document_stages.owner_id` 里实际存的值。于是在这个部署上，唯一被文档推荐的配置方式（把 whoami 读到的 owner 填进去）会直接 500。

两个变量对 `anon:` 前缀的需求是相反的：`PERSISTENCE_SHARED_OWNER_ID` 必须排除它（共享 owner 不能与某个 cookie owner 重合），而 `REINLAB_OWNER_ID` 恰恰要靠它把导出面钉在某个 cookie owner 上。照抄模式时很容易忽略这一点。

已修：`REINLAB_OWNER_ID` 现在接受 `anon:<uuid-v4>` 或纯标识符两种形状，并加了以本机真实 owner id 为样例的回归测试。

**(b) 课程库本来就是分裂的。** 查库后发现三门课分属**三个不同的 owner**：

| 课程 | 场景数 | owner |
|---|---|---|
| 罗马史大师课：从城邦到帝国，制度与权力的因果链 | 23 | `anon:91c07ee9-…` |
| Rhine integration acceptance | 1 | `anon:390fedc3-…` |
| 矩阵乘法入门（一页搞定） | 1 | `anon:57b9051f-…` |

这是「一个浏览器 = 一个学习者」的直接后果：每门课是在不同的 cookie 分区里创建的。只钉一个 owner 会让用户看到三门里的**一门**，而且不知道为什么其余的不见了。

已修：`REINLAB_OWNER_ID` 接受**逗号分隔的列表**，`/courses` 合并各分区并按 id 去重，`/courses/[id]` 依次查找。这也顺带覆盖了将来继续分裂的情况。想彻底不再分裂，需要设置 `ACCESS_CODE` + `PERSISTENCE_SHARED_OWNER_ID`（代价是 Mac 浏览器要输一次访问码，且已有的三门课会落到旧分区里看不见）。

### 10.4b 与原计划的差异

| 项 | 计划 | 实际 |
|---|---|---|
| B1-1 Tailwind 接入 | 0.5 天 | **取消**（见 10.1） |
| owner 固定方式 | `PERSISTENCE_SHARED_OWNER_ID` | `REINLAB_OWNER_ID` + `/whoami`（见 10.2） |
| 导出端点鉴权 | 未提 | 可选 `REINLAB_EXPORT_TOKEN`（Bearer 或 `?token=`，定时安全比较） |
| 媒体清单 | 客户端枚举 | **服务端计算**并随单课返回，客户端只做通用深走替换 |
| 离线时的未下载课程 | 提示「需要连接」 | 增加「上次看到的课程索引」（localStorage），否则离线时这些课会**从列表里消失**，无从提示 |
| 场景编排器 | 「场景切换、上下页、触屏手势」 | 另加：slide 原生渲染 / quiz 只读展示 / interactive+pbl 说明面板 |

### 10.5 已完成

**REINLAB 侧**（新增 `src/components/classroom/native/`）

| 文件 | 作用 |
|---|---|
| `courseApi.ts` | `/api/reinlab/*` 客户端 + 跨版本形状校验 |
| `courseCache.ts` | IndexedDB：课程 JSON + 媒体 Blob + 配额记账 |
| `courseIndex.ts` | 上次看到的课程索引（离线时标「需要连接」） |
| `mediaRewrite.ts` | 通用深走替换媒体地址 + 下载排序 |
| `courseLibrary.ts` | 列表合成、配额判定、下载编排（固定并发） |
| `courseProgress.ts` | 续读位置（按场景 id，不按下标） |
| `NativeCourseLibrary.tsx` | 课程档案页 |
| `NativeCourse.tsx` | 场景编排器（`SceneSurface` 单独导出以便测试） |
| `native-course.css` | 沿用 classroom.css 的视觉语汇，手写 CSS |

接线：`App.tsx` 中「学习平台」不再整页跳走，改为进入课程档案页；在线课程库入口保留在档案页右上角。两个原生组件走 `React.lazy`，**renderer 因此仍在独立 chunk 里**（`NativeCourse-*.js` 81.65 kB），主包 308.68 → 312.11 kB（仅接线成本）。

**OpenMAIC 侧**：`app/api/reinlab/{health,whoami,courses,courses/[id]}`、`lib/reinlab/export-server.ts`（596 行，CORS + 令牌闸门 + owner 覆盖 + 媒体清单）、`middleware.ts` 白名单、`tests/reinlab/`（86 个测试）。`tsc` / `eslint` / `prettier` 均干净，无新增类型错误（仓库原本就有 2 个 `tests/workbench/*` 的错误，与本次改动无关）。

### 10.8 部署（已执行）

部署那一份已重建为 `.next-rhine-v9` 并在跑：

| 项 | 值 |
|---|---|
| 构建 | `RHINE_BUILD_DIR=.next-rhine-v9 pnpm build` |
| 启动 | `HOSTNAME=0.0.0.0 PORT=3000 node --env-file=.env.local .next-rhine-v9/standalone/server.js` |
| `start:rhine` | 已改为指向 v9（`pnpm start:rhine` 即启动新版） |
| 回退 | v8 完整保留：把 `start:rhine` 改回 v8 并重启即可 |

> 本机**只有 `.next-rhine-v8` 一份旧构建**，没有 v7，所以刻意构建到新目录而不是覆盖 v8——v8 就是回退点。

`.env.local` 追加了一行（原文件已备份为 `.env.local.before-reinlab`）：

```
REINLAB_OWNER_ID=anon:91c07ee9-…,anon:390fedc3-…,anon:57b9051f-…
```

### 10.9 端到端核对结果（对着真实数据）

用临时脚本（跑完已删）把真实的导出端点接到真实客户端上：

| 检查 | 结果 |
|---|---|
| `/api/reinlab/health` | `{ok:true, apiVersion:1, persistence:true}` |
| `/api/reinlab/courses` | 返回 2 门课；第三门（`stage-z3REtHbnZTpu`）`stage_meta.deleted_at` 非空，被正确排除 |
| `/api/reinlab/courses/stage-8iCl_d9LOw` | 23 个场景，`media: []` |
| 客户端形状校验 | 全部通过；场景类型 `slide` 19 / `quiz` 3 / `interactive` 1 |
| **原生渲染** | 19 张幻灯片全部渲染出真实元素（含 `slide-element`），首张「一个问题，两次：扩张与制度」产出 41,771 字节 HTML；3 个测验场景走只读面板；1 个交互场景走说明面板 |
| 已删除课程 | 404 → 客户端 `CourseApiError{kind:'http', status:404}` |
| CORS | `capacitor://localhost` 与局域网来源放行；`http://localhost.evil.com` 不放行 |

**一个必须说明的数据事实：这个部署里的三门课都没有任何媒体**（`asset_entries` 为 0 行，全部课程数据里只有 3 个 KaTeX CDN 地址，属于交互场景的内嵌 HTML）。因此**媒体离线缓存这条路只有单元测试覆盖，没有真实素材验证过**。等生成一门带配图或视频的课程后，需要补一次真机验证。

> 顺带：正是这 3 个 KaTeX 地址暴露了「通用深走会把 CDN 脚本当成课程媒体」的误报，见 `looksLikeMediaUrl`。

### 10.6 已知限制

- **图表与代码元素**：renderer 用动态 `import()` 加载 `echarts` / `shiki`，两者是可选的 peer 依赖，本仓库未安装。含图表的幻灯片会落到渲染器自带的错误态，含代码块的退化为无高亮。要完整还原，加这两个依赖即可（都是按需 chunk，不进主包）。当前由 `SlideBoundary` 兜住，**不会白屏**。
- **actions 未接**：spotlight / laser / speech 不会自动播放，幻灯片可看但不会自己讲。部署上本来也没有 TTS 能力。
- **视频离线体积**：全量缓存下首课可能很大，配额 1 GB 需要留意。

### 10.7 验收状态

| 验收项 | 状态 |
|---|---|
| 已下载课程飞行模式下能打开、切场景、书签续读 | 服务端与渲染已端到端核对；**iPad 上的飞行模式仍待人工验证**（见 10.9） |
| 图片与音频正常显示 | 媒体地址全量重写（含 audio——renderer 没有 audio 插槽，只能改写 JSON）；但本部署**没有含媒体的课程**，只有单元测试覆盖 |
| 现有 REINLAB 界面视觉零变化 | 未引入 Tailwind；新增页面独立；测试全绿 |
| 离线时未下载课程提示「需要连接」 | 由课程索引支持，有测试 |
| 测试全绿 | REINLAB **156 个**（85 原有 + 71 新增）；OpenMAIC **86 个**新增 |
| 生产产物不含 `127.0.0.1:3000` | 已确认 `dist/` 内零命中 |

