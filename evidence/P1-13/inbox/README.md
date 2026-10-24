# Claude收件箱同步与live数据适配

src/components/inbox的6文件与第19场景均逐字节同步，SHA256见sync-source-hashes.json。main.tsx仅保留其preview路由并接live会话与adapter；CinematicExperience仅同步import/InboxHost两处并传adapter，不带入主仓库其他motion-preview改动。Claude组件样式/交互未改，删除旧LiveInbox。主仓库只读。

ToTDD：adapter模块与被替换条目API先红；API/adapter/session定向13/13。独立安全先发现3红：证据来源、旧项id/key、sent审批；补强后独立亲跑7文件23/23，原报告注明边界。新增最小RLS来源绑定superseded API，不能用它任意读取记忆；会话B登录开始立刻清A token/视图，所有缓存与返回绑定代数。

19/19 T-REG全部通过，既有18个场景0修改。真实本地Supabase/Auth/API/Claude组件9/9，四操作、原文、真实旧记忆替换、once、重新打开刷新、离开31分钟后回前台刷新、页面刷新需重登；附截图与账本。全部人工录入审阅验证数据，模型0调用，不冒称T-MCP-10。最初旧restart脚本因入口路径不匹配未动旧控制面；改用record中的tooling/local/control.ts身份核对后OWNED_CONTROL_READY并重跑9/9。类型与依赖检查通过。

遵循Claude宿主30分钟离开再自动打开，不保留旧自制5分钟弹窗行为。问答answers/真实跳转接口限制见Q-085，未捏造答案、依据、链接或长期授权。P1-13 worker仍在下一步实现，Q-086设计审查不计为实现通过。
