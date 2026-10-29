# 原生课程模块（保留，待接入课程台）

课程接口（`courseApi`）、离线媒体缓存（`courseCache`）、学习进度（`courseProgress`）、原生渲染（`NativeCourse`）都是真实实现。
2026-10-27 前端瘦身时，旧原型 `App` 被移除，这里暂时只有单元测试在引用。
课程台按 `design/CURRICULUM_DSH_FLOW.md` 改造时，从档案库打开 OpenMAIC 生成的课程，走这里的渲染和缓存。**不要当成旧代码删掉。**
