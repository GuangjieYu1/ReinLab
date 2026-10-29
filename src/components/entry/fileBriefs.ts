// 档案预览用的示例数据：每份 File 的简介、上次停在哪里、最近几条记录。
// 键为工作台 id，数组顺序与 entryWorkbenches 中的 files 一致。

export type FileBrief = {
  desc: string;
  last: { step: number; total: number; label: string; when: string; where: string };
  recent: string[];
};

export const fileBriefs: Record<string, FileBrief[]> = {
  curriculum: [
    { desc: '从正多边形的旋转与翻转出发，理解群的四条公理与陪集。', last: { step: 3, total: 5, label: '陪集与拉格朗日定理', when: '昨天 21:40', where: '第 3 节 · 互动页 2' }, recent: ['完成练习：D₄ 的子群', '标记疑问：正规子群的直觉', '笔记：轨道-稳定子'] },
    { desc: '用几何变换看矩阵：哪些方向在变换后只被拉伸。', last: { step: 2, total: 4, label: '特征值的几何含义', when: '3 天前', where: '第 2 节 · λ 滑杆' }, recent: ['调整 λ 观察伸缩', '完成：对角化条件', '收藏：旋转矩阵无实特征向量'] },
    { desc: '从弹簧振子到驻波，把微分方程和看得见的运动对上。', last: { step: 4, total: 6, label: '阻尼与共振', when: '上周', where: '第 4 节 · 共振曲线' }, recent: ['实验：改变阻尼系数', '笔记：品质因子 Q', '待复习：受迫振动相位'] },
    { desc: '从一行 C 代码一路追到汇编、缓存与虚拟内存。', last: { step: 1, total: 8, label: '信息的表示与处理', when: '2 周前', where: '第 1 章 · 补码练习' }, recent: ['完成：位运算谜题 3/5', '标记：浮点舍入'] },
  ],
  research: [
    { desc: '文献中的训练技巧，在 124M 小模型上能否复现收益。', last: { step: 1, total: 5, label: '等待确认研究方向', when: '今天 09:12', where: '研究简报 · 待签发' }, recent: ['检索 3 篇相关文献', '生成研究简报草稿', '预算估算：约 96 次实验'] },
    { desc: '整理每条结论背后的证据链，标出薄弱环节。', last: { step: 3, total: 4, label: '证据强度评级', when: '昨天', where: '方法表 · 第 12 行' }, recent: ['补充对照实验 2 组', '标记 1 条结论证据不足'] },
    { desc: '对比三种结构变体在相同预算下的表现。', last: { step: 2, total: 5, label: '运行第二组对照', when: '2 天前', where: '前沿曲线 · 第 38 次实验' }, recent: ['保留：RMSNorm 替换', '回滚：层数 14', '最优 val_bpb 1.0072'] },
    { desc: '研究过程中的零散想法与待验证的猜想。', last: { step: 0, total: 0, label: '自由记录', when: '上周', where: '第 14 条笔记' }, recent: ['新增猜想：学习率预热过长', '关联文献 2 篇'] },
  ],
  engineering: [
    { desc: '档案浏览器的键盘操作与窄屏布局，供交互原型使用。', last: { step: 4, total: 6, label: '补键盘与窄屏测试', when: '今天 22:56', where: 'ISS-34 · feat/ISS-34-keyboard-nav' }, recent: ['改动 browser.css：窄屏改为上下排布', '测试 3/4 通过，CASE-118 失败', '等待审批：写入 browser.css'] },
    { desc: '整理组件规范，让各工作台共用同一套构件。', last: { step: 2, total: 5, label: '抽出面板头与审批卡', when: '昨天', where: 'REQ-021 · 需求面' }, recent: ['WhatIf 检查：0 冲突', '提交 MR，等待审核'] },
    { desc: '把模型工具调用接入工作台的动作表。', last: { step: 1, total: 4, label: '定义动作风险等级', when: '3 天前', where: 'REQ-030 · 草稿' }, recent: ['起草：read / write / danger 三级', '开放问题 2 条'] },
    { desc: '交付前的验证清单与测试报告。', last: { step: 5, total: 6, label: '生成测试报告', when: '上周', where: '测试面 · 批次 #6' }, recent: ['运行矩阵：38/40 通过', '录制回放 2 段'] },
  ],
  creative: [
    { desc: '《魔戒》同人中篇：山姆西去之前，把红皮书交给伊拉诺；最后一页的字迹不属于任何人。', last: { step: 2, total: 5, label: '第 3 章 · 最后一页', when: '今天 16:20', where: '小说面 · 第 3 章 · 场景 2' }, recent: ['设定冲突 5 条待处理', '世界观 15 个条目', '第 2 章转为分镜 6 镜'] },
    { desc: '灰港送别一场的分镜与白模预演。', last: { step: 2, total: 5, label: '白模机位调整', when: '昨天', where: '视频面 · 镜 04 · 推镜' }, recent: ['镜头表 12 镜', '白模 9/12'] },
    { desc: '夏尔一年四季的四个短篇，每篇一个季节。', last: { step: 1, total: 4, label: '春 · 初稿', when: '4 天前', where: '小说面 · 春' }, recent: ['大纲节拍调整', '连续性提醒 1 条'] },
    { desc: '霍比屯、灰港等地点的视觉设定与参考。', last: { step: 1, total: 3, label: '灰港配色', when: '上周', where: '世界观面 · 地点' }, recent: ['参考图 14 张', '占位候选 8 张'] },
  ],
  automation: [
    { desc: '每天 08:30 收集新资料、摘要并归档。', last: { step: 4, total: 6, label: '人工确认摘要', when: '今天 08:31', where: 'WF-01 · 第 812 次运行' }, recent: ['近 20 次运行 19 次成功', '1 次失败：RSS 超时', '待审：3 条摘要'] },
    { desc: '每周汇总研究进展，生成周报草稿。', last: { step: 6, total: 6, label: '已发送', when: '周一 09:00', where: 'WF-03 · 第 41 次运行' }, recent: ['周报已生成', '附图 4 张'] },
    { desc: '作品定稿后自动归档到档案库。', last: { step: 2, total: 5, label: '等待触发', when: '3 天前', where: 'WF-05 · 事件触发' }, recent: ['最近归档：工作台视觉系统'] },
    { desc: '把中断的任务重新排队，从断点接续。', last: { step: 3, total: 4, label: '维护 Agent 诊断中', when: '昨天', where: 'WF-08 · 失败重试' }, recent: ['修复 diff 已生成', '等待沙盒试跑'] },
  ],
  exploration: [
    { desc: '京都东山一天的人像外拍计划：6 个机位、光线、天气、引导词与服饰。', last: { step: 3, total: 6, label: '南禅寺 · 水路阁', when: '今天 10:25', where: '现场 · 3 号机位' }, recent: ['计划书已生成', '14:00 阵雨 · 备选疏水纪念馆', '服饰 3 套'] },
    { desc: '岚山竹林与渡月桥的晨雾风光，等日出前后的雾。', last: { step: 1, total: 4, label: '选机位', when: '2 天前', where: '草稿' }, recent: ['3 个候选机位'] },
    { desc: '伏见稻荷千本鸟居的夜拍，避开人流的路线。', last: { step: 1, total: 4, label: '查开放与照明', when: '上周', where: '草稿' }, recent: ['夜间照明时段待核实'] },
    { desc: '城市漫步街拍：半天，随走随拍。', last: { step: 0, total: 4, label: '未开始', when: '—', where: '草稿' }, recent: ['还没有机位'] },
  ],
  data: [
    { desc: '训练实验的运行记录，比较不同优化器的效果。', last: { step: 2, total: 4, label: '各优化器的平均 val_bpb', when: '今天 15:30', where: '数据线程 · T1' }, recent: ['连接 runs 表，72 条记录', '生成柱状图', '分支：按架构拆开'] },
    { desc: '各工作台的使用时长与功能分布。', last: { step: 1, total: 3, label: '清洗会话数据', when: '3 天前', where: '数据线程 · T0' }, recent: ['workbench_sessions 136 条'] },
    { desc: '京都秋季的天气与日照，供拍摄规划参考。', last: { step: 3, total: 3, label: '日照时长分布', when: '上周', where: '数据线程 · T3' }, recent: ['导出给探索台'] },
    { desc: '课程学习进度与停留时长。', last: { step: 2, total: 4, label: '各章节完成率', when: '昨天', where: '数据线程 · T2' }, recent: ['course_progress 24 条'] },
  ],
};
