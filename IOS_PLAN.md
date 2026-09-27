# ReinLab → iOS 应用：可行性结论与实施计划

> 目标设备：**M1 iPad Pro**（原为 iPhone，见第十节修订）
> 目标形态：自签真机安装（免费 Apple ID）+ 云端 macOS CI 出包
> 结论日期：基于当前工作目录实测

---

## 一、结论

**可以做，而且这个项目的底子比一般 Web 项目好得多。** 不需要重写成 React Native，
用 Capacitor 包一层 WKWebView 即可。真正的工作量不在「打包」，而在**移动端适配**
和**云端签名链路的分工**这两件事上。

---

## 二、实测现状（依据，非推测）

| 项目 | 实测结果 | 对 iOS 的意义 |
|---|---|---|
| 技术栈 | Vite 6 + React 19 + TS，纯前端 | 可直接打包 |
| 构建 | Node 20 下 `npm run build` 通过，2.4s | 可进 CI |
| 测试 | 10 个文件 / 75 个用例全过，1.2s | 可作门禁 |
| 产物体积 | JS ~800KB（gzip ~250KB）、CSS ~228KB（gzip ~49KB） | 首屏无压力 |
| WebGL | 零依赖（无 canvas / Three.js / 着色器） | WKWebView 上最省心 |
| 拖拽交互 | 已用 Pointer Events + `onPointerCancel` | 触屏安全，无需重写 |
| 视频 | `<video playsInline>` 已就位 | iOS 内联播放 OK |
| 音频 | 登录点击手势内 `new AudioContext()` + `resume()` | 满足 iOS 手势解锁要求 |
| 断点 | 最窄覆盖到 520px / 540px | iPhone 竖屏 390pt 在范围内 |
| 移动菜单 | `App.tsx` 已有 `mobileNav` + scrim | 已有基础 |
| 媒体资源 | `public/classroom/` 3 个文件共 358KB，全本地 | 离线可用，无需额外处理 |

**运行时层面几乎没有阻塞项。**

---

## 三、真实卡点（按严重程度排序）

### 1. 硬编码 `http://127.0.0.1:3000` —— 第一阻塞项

`src/components/cinematic/openMaicPortal.ts:1` 写死了 OpenMAIC 开发服务器地址，
调用点为 `App.tsx:75`、`CinematicExperience.tsx:178`、`CinematicExperience.tsx:533`。
在 iPhone 上 `127.0.0.1` 指向**手机自己**，该路径必然失败；ATS 默认还禁止明文 HTTP。

**必须改为** `import.meta.env.VITE_OPENMAIC_ORIGIN`，缺失时降级为本地提示而非跳转。

### 2. 本机工具链缺失（已选择绕过）

- `xcode-select -p` → `/Library/Developer/CommandLineTools`，`/Applications` 无 `Xcode.app`
- 无 CocoaPods、无 Rust
- 数据卷仅剩 **17GB**（已用 417GB），装不下 Xcode 26

→ 云端 CI 路线绕开此点，**不再是阻塞项**，代价是反馈变慢（见 Phase 1.5 缓解方案）。

### 3. 安全区 / 刘海未处理

`index.html` 的 viewport **缺少 `viewport-fit=cover`**；全项目仅 5 处
`env(safe-area-inset-*)`（全部位于 `research.css`）。开场动画使用硬编码像素偏移：

- `.boot-corner { top: 33px }` → 撞状态栏 / 灵动岛
- `.skip-boot { bottom: 35px; right: 40px }` → 撞 Home 指示条
- 开场右上角跳过 / 调试按钮同理

### 4. 调试面板在 iPhone 上打不开

性能面板靠 `Ctrl/Cmd+Shift+D`（`CinematicExperience.tsx:498`）。iPhone 无键盘，
**无法在真机测量那 25 秒开场的真实 FPS**——而 128 份 CSS 3D 档案阵列恰是最大性能风险点。

→ 必须补触屏入口（长按标题 / 五连点）。

### 5. 缺图标与启动图 + 不是 git 仓库

- `public/favicon.svg`（286 字节，64×64）可作图标种子，`Visuals.tsx` 的 `BrandMark`
  是同一图形；但真机需要 1024×1024 无透明通道 PNG。
- `git status` → **不是 git 仓库**，云 CI 路线的前置条件。

---

## 四、技术选型：Capacitor 8

**决定性理由**：Capacitor 从 `capacitor://localhost/` 提供服务，项目中的**根绝对路径**
（`/classroom/guitar-a.wav`、`/assets/...`）**原样可用**。若手写裸 WKWebView 加载
`file://`，这些路径全部失效。

**排除项**：

- **Tauri v2 iOS** — 需 Rust 工具链，生态成熟度不如 Capacitor，收益为零
- **React Native 重写** — 项目重度依赖 CSS 3D transform（`matrix3d` 相机）、SVG、`dvh`，等于全部重写
- **纯 PWA** — 作为验证手段而非交付形态（见 Phase 1.5）

**版本约束**（已核对官方文档）：Capacitor 8 要求 **iOS 15+ / Xcode 26.0+**；
GitHub Actions 已有 `macos-26` runner 镜像。使用 **SPM 而非 CocoaPods**
（`npx cap add ios --packagemanager SPM`），CI 省掉 `pod install`，本地也无需装 CocoaPods。

---

## 五、分发链路（关键分工）

> 免费 Apple ID **无法创建 App Store Connect API Key**，CI 拿不到签名身份，
> **云端不可能替你签名**。CI 只能产出**未签名 .ipa**，签名必须回到本机用你的 Apple ID 完成。

```
GitHub Actions (macos-26, Xcode 26)
  ├─ npm ci → npm test → vite build → cap sync ios
  ├─ xcodebuild CODE_SIGNING_ALLOWED=NO      ← 故意不签名
  ├─ 组装 Payload/App.app → ReinLab-unsigned.ipa
  └─ upload-artifact
        ↓ 下载
本机 Sideloadly / SideStore（免费 Apple ID，无需 Xcode）
  └─ 签名 + USB 安装到 iPhone
```

**免费账号硬限制**（SideStore 官方 FAQ 确认）：同时最多 3 个 App、每周最多 10 个
App ID、证书 **7 天过期需重签**。

**成本**：私有仓库免费额度 2000 分钟/月，但 macOS runner **按 10 倍计费** →
约 200 分钟 ≈ 每月 20–40 次构建。公开仓库完全免费。

**升级路径**：$99/年 开发者账号可解锁 365 天证书 + TestFlight 无线安装，
且**届时 CI 可直接签名**，链路才真正闭环。

---

## 六、分阶段执行计划

### Phase 0 — 准备（约 10 分钟，零风险）

1. `git init` + 首次提交（`.gitignore` 已就绪，会排除 `node_modules/`、`dist/`、
   `reference-clips/`、`previews/`）
2. 加 `.nvmrc` 锁 Node 20。**注意 `/usr/local/bin/node` 是 v16.14.2，跑不动 Vite 6**，
   必须用 nvm 的 v20.20.0
3. 推送仓库到 GitHub

### Phase 1 — 接入 Capacitor（约半天，本地可验）

1. `npm i @capacitor/core @capacitor/cli @capacitor/ios`
2. `capacitor.config.ts`：`appId: 'chat.reinlab.terminal'`、`appName: 'REINLAB'`、`webDir: 'dist'`
3. `npx cap add ios --packagemanager SPM` 生成 `ios/` 并**提交进仓库**（CI 需要）
4. 本地验证：`npm run build` + `npx cap sync ios`（**不需要 Xcode**）

### Phase 1.5 — 无 Xcode 的真机验证（约半天）★ 本项目最重要的一步

```sh
npm run dev -- --host 0.0.0.0    # 默认只绑 127.0.0.1，必须放开
```

用 **iPhone Safari 通过局域网 IP 打开**，逐条验证：触屏拖拽、安全区遮挡、
开场 25 秒真实流畅度、音频解锁、字体回退。**零成本暴露绝大多数问题**，
避免带着一堆问题去折腾云端签名。可再「添加到主屏」验证全屏与安全区。

### Phase 2 — 打通云 CI 出包（约半天）

`.github/workflows/ios.yml`（`workflow_dispatch` + push 触发）：

1. `actions/setup-node@v4`（node 20）→ `npm ci` → `npm test` → `npm run build`
2. `npx cap sync ios`
3. `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release
   -sdk iphoneos -destination 'generic/platform=iOS'
   CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""`
4. 组装 `Payload/App.app` → `zip` 成未签名 ipa
5. `actions/upload-artifact@v4`

75 个测试可设为构建门禁（仅 1.2s）。

### Phase 3 — 装机 + 真机验收（约半天）

安装 Sideloadly（约 50MB，**不需要 Xcode**），拖入 ipa、登录 Apple ID、USB 安装，
然后跑第七节验收清单。

### Phase 4 — 移动端适配修复（按实测结果排期）

1. **修 `openMaicPortal.ts` 硬编码 origin**（`VITE_OPENMAIC_ORIGIN` + 优雅降级）
2. `index.html` 加 `viewport-fit=cover`；给 `.boot-corner` / `.skip-boot` /
   开场右上角控件补 `env(safe-area-inset-*)`
3. 调试面板补触屏入口，让真机 FPS 可测
4. `@capacitor/assets` 从 `favicon.svg` 生成 1024×1024 图标 + 启动图
5. 字体：`src/styles.css:1` 的 Google Fonts `@import` 在原生壳需联网
   （Noto Sans SC 是 CJK 大字体，自托管要按 unicode-range 切子集）。
   建议先依赖已有的系统字体回退（README 第 152 行已说明），确认观感后再决定
6. 性能：若 128 档案阵列在真机掉帧，按 README 第 29 行已有的「材质分级」机制
   加一档移动端降级

### Phase 5 — 可选：TestFlight / App Store

**必须明确**：本项目是《明日方舟》莱茵生命**非官方同人概念设计**（README 第 3 行）。
自用无碍，但上架 App Store 有较大概率因 IP / 冒充问题被拒。建议止步于自签或 TestFlight。

---

## 七、真机验收清单

- [ ] 冷启动 → 3.8s 登录过渡 → 登录表单，全程无白屏
- [ ] 全屏模式下刘海与 Home 条不遮挡任何可点元素
- [ ] 开场 25 秒：调试面板实测 FPS / P95 帧间隔（桌面 60 为标准）
- [ ] 切后台再回来：演出正确暂停、音频正确淡出（README 第 25 行声称已实现，需实测）
- [ ] 系统「减弱动态效果」开启后行为正确
- [ ] 档案阵列：拖动、选中、抽取、归位全部可触屏完成
- [ ] 六科课堂逐一进入；地球拖拽旋转、数学画布节点拖动在触屏上跟手
- [ ] 吉他课的 `.wav` / `.mp4` 可播放；播放时背景音乐正确降低
- [ ] 课后导出 Markdown 可用；`navigator.clipboard` 走通或正确回退
- [ ] 杀进程重开：localStorage（`reinlab-learning-classrooms-v1` 等）数据仍在
- [ ] 断网启动：字体回退正常，无功能阻塞

---

## 八、风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 证书被 Apple 吊销 | sideload 应用集体打不开（2026 年有此类报告） | 重签安装；或升级 $99 账号 |
| 7 天重签 | 每周需联机刷新 | SideStore 后台刷新；或付费账号 |
| 云端反馈慢 | 每次 iOS 改动要等 CI | Phase 1.5 局域网验证覆盖大部分问题 |
| 128 档案阵列掉帧 | 开场不流畅，核心体验受损 | 已有材质分级机制，可加移动端降档 |
| 同人 IP | 无法上架 | 明确定位为自用原型 |
| 免费账号 Anisette 风控 | Apple ID 被临时锁定 | 用官方服务器，勿用第三方 |

---

## 九、待决定项

1. **仓库公开还是私有？** 公开 = CI 完全免费；私有 = 每月约 200 macOS 分钟额度
2. **全屏策略**：`contentInset: 'never'` + `viewport-fit=cover` 让开场动画真正全出血，
   但需手动补全所有安全区；保守方案是让系统自动内缩。**建议先做全出血**
3. **是否在 Phase 0 就加 `.nvmrc` 与类型检查门禁**，还是保持最小配置

---

## 十、目标设备修订：M1 iPad Pro（2026-09-27）

目标从 iPhone 改为 M1 iPad Pro 后，**风险等级整体下降一档**。以下是逐条修订。

### 10.1 屏幕宽度改变了整个适配故事（最大利好）

| 设备 | 原生分辨率 | CSS 逻辑尺寸 |
|---|---|---|
| iPad Pro 12.9" (M1) | 2732×2048 @2x | **1366×1024 pt** |
| iPad Pro 11" (M1) | 2388×1668 @2x | **1194×834 pt** |

对照本项目断点（窄屏调整在 `max-width` 1180 / 960 / 760 触发）：

- **两台 iPad 横屏都在 1180px 之上 → 直接获得桌面级布局**
- 12.9" 竖屏 1024pt → 落在 960–1180 区间，接近桌面
- 11" 竖屏 834pt → 落在 760–960 区间，中间档

→ 第三节未提及、但为 iPhone 预留的「三栏课堂被压扁 / 需要移动端重排」基本不成立。
**这是本次目标变更最大的收益。**

### 10.2 新发现的具体问题：`min-width: 1400px` 那一档够不到

`src/components/classroom/learning.css:210`：

```css
@media(min-width:1400px){#rhine-wide .rl-split{grid-template-columns:minmax(240px,.82fr) minmax(390px,1.4fr);gap:38px}...}
```

该档位把课堂升级为最宽布局并放大讲义字号。而：

- 12.9" 横屏 1366pt → **差 34pt，够不到**
- 11" 横屏 1194pt → 更够不到

**建议**：把该断点下调至 **1190px**，两台 iPad 都能吃到原本为宽屏设计的课堂布局。
注意这会改变窄桌面窗口下的观感——**正是应该只在 `ios/capacitor` 分支上做的改动**。

### 10.3 性能风险基本消失

M1（8 核 GPU）+ ProMotion 120Hz。第三节曾把「128 份 CSS 3D 档案阵列掉帧」
列为头号体验风险，在 M1 iPad 上基本不成立。仍需实测，但不再是主要担忧。

### 10.4 安全区问题减轻但未消失

- M1 iPad Pro **无刘海、无灵动岛** → 第三节中的「撞灵动岛」不适用
- 但仍有：状态栏、Home 指示条、圆角屏幕
- `.boot-corner { top: 33px }` 仍贴近状态栏；`.skip-boot { bottom: 35px }` 仍贴近 Home 条

### 10.5 调试面板有救了

配妙控键盘则 `Cmd+Shift+D` 直接可用（第三节卡点 4 缓解）。
无键盘时仍需补触屏入口。

### 10.6 方向与装机

- iPad 应用默认支持四方向；建议横屏为主，**不必锁死**（竖屏 1024 / 834pt 依然够宽）
- 免费 Apple ID + Sideloadly / SideStore 流程与限制完全一致
  （3 个 App、10 App ID/周、7 天重签）
- **设备侧提醒**：sideloading 会在 iPad 上安装「信任的开发者证书」，
  SideStore 还会装一个本地 VPN 描述文件。属设备级改动，低风险且可撤销
  （设置中删除描述文件即可），介意的话可先做一次 iPad 备份

### 10.7 Phase 1.5 验证方式更新

原建议「iPhone Safari 局域网验证」在 iPad 上更好：iPad Safari 是桌面级渲染，
`npm run dev -- --host 0.0.0.0` 后直接访问即可，还可「添加到主屏」预检全屏与安全区。
注意 Safari 有工具栏高度，与 WKWebView 的真实视口**接近但不完全等同**。

---

## 十一、备份与回退（已于 2026-09-27 完成）

采用**双层备份**：

| 层 | 位置 | 内容 | 用途 |
|---|---|---|---|
| 1. Git 基线 | 仓库内 `main` + 标签 `baseline-pre-ios` | 95 文件 / 18598 行 / 1.6MB | 日常回退，秒级 |
| 2. 物理副本 | `../ReinLab-backup-20260927`（4.6MB） | 含 `.git`、`dist/`、`reference-clips/` | 防误删整个目录 |

开发在 `ios/capacitor` 分支进行，`main` 保持冻结基线。

**回退命令**：

```sh
git switch main                     # 切回基线（工作区跟随回退）
git restore .                       # 或只丢弃未提交改动
git switch ios/capacitor            # 回到开发分支
```

**注意事项**：

1. 物理副本**不含 `node_modules`**（有意排除，`package-lock.json` 已包含）。
   恢复后需 `npm ci` 重新安装。
2. `reference-clips/BV1eFVS6YEat_01-25_01-35.mp4`（668KB）被 `.gitignore` 排除，
   **只存在于物理副本中**，不进入 git 历史。
3. ⚠️ 本机 `commit.gpgsign=true` 但**未安装 gpg**，任何 `git commit` 会以
   `gpg failed to sign the data` 失败。本次提交用 `-c commit.gpgsign=false` 绕过，
   未改动全局配置。需自行二选一：安装 `gnupg`，或 `git config --global commit.gpgsign false`。

---

## 十二、OpenMAIC 集成真相（2026-09-27 核查）

原以为 `127.0.0.1:3000` 只是个本地开发服务器，实际核查后结论完全不同。

### 12.1 两个项目的关系

```
ReinLab（本仓库，Vite SPA，5173）        OpenMAIC（/Users/guangjieyu/Documents/OpenMAIC，3000）
  沉浸式外壳 / 档案终端          ←→         真实课程库 / AI 生成课堂
  ├─ 开场演出、登录                        ├─ Next.js App Router 服务端路由
  ├─ 档案阵列、抽取                        ├─ /reinlab      课程档案
  ├─ 研究实验室                            ├─ /classroom/stage-xxx  原生课堂
  └─ 对话工作台 / 模板工坊                 ├─ /workspace    Pro 工作台
                                           ├─ PostgreSQL（127.0.0.1:55433）
                                           └─ DeepSeek Agent 运行时
```

OpenMAIC 才是主体产品；ReinLab 是它的沉浸式前端。集成是**双向 localhost 跳转**：

- 5173 → `http://127.0.0.1:3000/reinlab?entry=rhine`
- 3000 → `http://127.0.0.1:5173/?return=archive`（**硬编码**于 `components/rhine/RhineArchive.tsx:245`）
- ReinLab 侧由 `CinematicExperience.tsx:31` 读取 `?return=archive`

### 12.2 「能原生融入吗」——不能

OpenMAIC 是独立的 Next.js 服务端应用，具备：

- 服务端路由（`app/reinlab`、`app/classroom/[id]`、`app/workspace`）
- 独立 PostgreSQL 集群（`~/Library/Application Support/ReinLab/OpenMAIC/pg16-data`，端口 55433）
- 服务端 DeepSeek Agent 运行时（API key 在服务端）
- 课程内容在服务端生成与存储

这些**无法**塞进 ReinLab 这个纯前端 SPA。且本仓库设计原则明确「不嵌套 iframe」（README 第 63 行）。
→ 结论：只能作为**外部服务**访问，采用应用内浏览器。

### 12.3 好消息：原生外壳让集成反而变简单

Web 版之所以需要 `?return=archive` 双向跳转，是因为浏览器整页跳转后无法自行返回。
而在 iPad 原生外壳里：

> **用应用内浏览器 sheet 打开 OpenMAIC，用户点「完成」关闭 sheet，
> 自动回到 ReinLab 原位置——不需要任何回跳 URL。**

sheet 的关闭动作天然完成了 Web 版要靠 URL 伪造的「返回」。
`?return=archive` 在 iPad 场景下可以完全不使用。

### 12.4 必须处理的四件事

| # | 事项 | 现状 | 需要做什么 |
|---|---|---|---|
| 1 | OpenMAIC 监听范围 | `HOSTNAME=0.0.0.0` | 已改为监听所有网卡；局域网/iPad 可通过本机 IP 访问 |
| 2 | PostgreSQL | 手动启动，不随开机 | 每次重启 Mac 后手动起（见 RHINE_INTEGRATION.md 第 34 行） |
| 3 | ReinLab 目标地址 | 无 | `VITE_OPENMAIC_ORIGIN=http://10.82.81.123:3000` |
| 4 | iOS ATS | 默认禁止明文 HTTP | `Info.plist` 加 `NSAppTransportSecurity` 例外 |

本机局域网 IP 当前为 **10.82.81.123**（DHCP，可能变化 → 建议路由器固定或改用 `.local` 主机名）。

### 12.5 OpenMAIC 侧建议改动（在另一个仓库）

`RhineArchive.tsx:245` 的返回地址硬编码：

```ts
window.location.assign('http://127.0.0.1:5173/?return=archive')
```

在 iPad 场景下这是一个**死地址**（设备上没有 5173 服务）。建议二选一：

- 抽成环境变量（如 `NEXT_PUBLIC_RHINE_RETURN_URL`），未设置时隐藏该入口；
- 或按 `?entry=native` 之类的查询参数判断，在原生外壳中隐藏「返回」入口
  （因为 sheet 关闭已经完成返回）。

### 12.6 边界与风险

- **Mac 必须开机**且 Postgres + OpenMAIC 在跑，否则 iPad 上学习通道不可用。
- 明文 HTTP 仅限局域网；同一 Wi-Fi 下的其他设备也能访问该服务。
- 本部署**无服务端 TTS**，Agent 生成的语音稿可读但无法合成音频
  （RHINE_INTEGRATION.md 第 32 行），此限制与文本/Agent 连接无关。
- ReinLab 自带的六种原生课堂仍是**可离线**的备选：若希望 iPad 在无网/无 Mac 时也能学，
  可以把它们接回为默认入口（改动点已在会话中定位）。

---

## 十三、实施进度

分支 `ios/capacitor`，`main` 保持冻结基线。

### 已完成

| 阶段 | 内容 | 状态 |
|---|---|---|
| 备份 | git 基线 + 标签 `baseline-pre-ios`；目录外物理副本 | ✅ |
| Phase 0 | `.nvmrc`、`.env.example`、`.gitignore` 补充 | ✅ |
| Phase 4-1 | 移除硬编码 `127.0.0.1:3000`，改 `VITE_OPENMAIC_ORIGIN` | ✅ |
| Phase 4-2 | 安全区 `env(safe-area-inset-*)`，用法 5 → 24 处 | ✅ |
| Phase 4-3 | 课堂宽屏断点 1400px → 1190px | ✅ |
| Phase 4-4 | `index.html` 加 `viewport-fit=cover` | ✅ |
| Phase 1 | Capacitor 8 接入，`ios/` 工程（SPM，iOS 15.0） | ✅ |
| Phase 1 | `Info.plist` ATS 例外（局域网明文 + 本地网络权限说明） | ✅ |
| Phase 1 | `@capacitor/browser` 应用内浏览器，原生分支已接线 | ✅ |
| Phase 2 | `.github/workflows/ios.yml`（macos-26，出未签名 ipa） | ✅ |

构建与 75 个测试在 Node 24 下全绿；生产产物中已确认不含 `127.0.0.1:3000`。

### 待办（按依赖顺序）

**需要你操作：**

1. **创建 GitHub 仓库并推送** —— CI 的前提。公开仓库 Actions 免费；私有仓库
   每月 2000 分钟额度，macOS runner 按 10 倍计费 ≈ 每月 20–40 次构建。
2. **OpenMAIC 改为局域网可访问** —— ✅ 已配置启动时 `HOSTNAME=0.0.0.0`。
3. **启动 PostgreSQL**（每次重启 Mac 后需手动起，命令见 RHINE_INTEGRATION.md 第 34 行）。
4. **配置 `VITE_OPENMAIC_ORIGIN=http://10.82.81.123:3000`**（IP 为 DHCP，建议固定）。
5. **安装 Sideloadly**（约 50MB，不需要 Xcode），用免费 Apple ID 签名装机。

**待开发：**

6. 用 `@capacitor/assets` 从 `favicon.svg` 生成 1024×1024 图标与启动图
   （当前是 Capacitor 默认占位图）。
7. 调试面板补触屏入口（`Ctrl/Cmd+Shift+D` 在无键盘时不可用）。
8. 真机验收清单（见第七节）。
9. OpenMAIC 侧：`RhineArchive.tsx:245` 的返回地址抽成配置或按原生场景隐藏。

---

## 一句话总结

**打包不是难点，Capacitor 半天能通；难点是移动端安全区与性能适配，以及
「CI 只能出未签名包、签名必须回本机」这条被迫的两段式链路。**
建议严格按 Phase 1.5 的顺序走——先用局域网 iPhone Safari 把体验问题全部暴露，
再动云端 CI，否则会在一个每次要等 CI、每 7 天要重签的慢循环里调试布局。
