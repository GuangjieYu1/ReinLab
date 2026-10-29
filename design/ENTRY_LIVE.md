# 正式入口接 live（2026-10-26）

真实模式的入口必须是 Rhine 入口（`RhineEntry`：缎带登录 → 选台 → Files → 工作台），不是旧版 `LoginGate` / `App`。

## 主仓库已改（前端，Codex 原样同步）

- `src/components/entry/entryAuth.ts`（新）：`EntryAuth` 接口，`mockEntryAuth`，以及 `previewLiveAuth`（`?preview=entry&auth=live` 预览 live 登录的样子）。
- `src/components/entry/RhineLogin.tsx`：接 `auth` 参数。`auth.identity` 存在时多一栏「邮箱」；核验改成异步，结果和核验动画都到了才放行，失败进入封锁画面并提示。
- `src/components/entry/RhineEntry.tsx`：接 `auth` 参数；从工作台返回（`?return=`）时，`auth.active()` 为假就重新登录；锁定时调 `auth.lock()`。
- `src/components/entry/rhine-login.css`：邮箱栏两行样式。
- `src/main.tsx`：根地址 `/` 改为 `RhineEntry`；旧原型只在 `?preview=legacy` 等未知参数下出现。

## Codex 要做的接线

1. 实现 `liveEntryAuth: EntryAuth`：
   - `kind: 'live'`；`identity: { label: '邮箱', placeholder: 'EMAIL', type: 'email' }`；`keyPlaceholder: 'PASSWORD'`；`hint: '本地账户登录 · 会话只保存在本页内存中'`；
   - `verify` 调现有 `login(email, password)`，成功返回 true；`active` 就是 `loggedIn()`；`lock` 就是 `logout()`。
2. live 下根地址和 `?preview=entry` 都渲染 `<RhineEntry auth={liveEntryAuth} />`。
3. `LiveSessionBoundary`：未登录时不再渲染 `LoginGate`，改为跳回 `/?preview=entry`（用 `navigate`）。入口页本身不包在 boundary 里。
4. 不改入口的样式、动画和交互。
