import curriculum from '../../assets/workbench-logos/curriculum.svg?raw';
import research from '../../assets/workbench-logos/research.svg?raw';
import engineering from '../../assets/workbench-logos/engineering.svg?raw';
import creative from '../../assets/workbench-logos/creative.svg?raw';
import automation from '../../assets/workbench-logos/automation.svg?raw';
import exploration from '../../assets/workbench-logos/exploration.svg?raw';
import data from '../../assets/workbench-logos/data.svg?raw';

export interface EntryWorkbench {
  id: string; code: string; title: string; english: string; description: string; logo: string;
  files: [string, string, string, string]; fileKind: string;
}

export const entryWorkbenches: EntryWorkbench[] = [
  { id: 'curriculum', code: '01', title: '学科课程工作室', english: 'CURRICULUM STUDIO', description: '从知识出发，让理解发生。', logo: curriculum, files: ['群论 · 对称与群', '线性代数 · 特征方向', '物理 · 振动与波', 'CSAPP · 程序与系统'], fileKind: 'COURSE' },
  { id: 'research', code: '02', title: '实验研究工作台', english: 'RESEARCH WORKBENCH', description: '让问题接受证据的检验。', logo: research, files: ['文献与实验', '方法与证据', '模型结构对照', '研究笔记'], fileKind: 'RESEARCH' },
  { id: 'engineering', code: '03', title: '工程开发工作台', english: 'ENGINEERING STUDIO', description: '把想法，变成可以运行的事物。', logo: engineering, files: ['ReinLab · 交互原型', '组件与规范', '模型工具接入', '验证与交付'], fileKind: 'PROJECT' },
  { id: 'creative', code: '04', title: '创作工作台', english: 'CREATIVE STUDIO', description: '从一个念头，到一件作品。', logo: creative, files: ['红皮书的最后一页', '灰港 · 分镜预演', '夏尔四季 · 短篇', '中洲风物 · 视觉设定'], fileKind: 'CREATIVE' },
  { id: 'automation', code: '05', title: '自动化工作台', english: 'AUTOMATION STUDIO', description: '让重复的工作，持续向前。', logo: automation, files: ['每日资料整理', '研究进展汇总', '作品归档流程', '任务编排与接续'], fileKind: 'WORKFLOW' },
  { id: 'exploration', code: '06', title: '规划探索工作台', english: 'EXPLORATION STUDIO', description: '连接地点、计划与新的发现。', logo: exploration, files: ['东山 · 秋日人像', '岚山 · 晨雾风光', '伏见稻荷 · 夜拍', '城市漫步 · 街拍'], fileKind: 'EXPLORATION' },
  { id: 'data', code: '07', title: '数据工程实验台', english: 'DATA ENGINEERING LAB', description: '让数据自己回答问题。', logo: data, files: ['实验运行记录', '工作台使用分析', '京都秋季天气', '课程学习进度'], fileKind: 'DATASET' },
];

/** How many workbenches the entry and Files show. */
export const WORKBENCH_COUNT = entryWorkbenches.length;
export const countLabel = String(entryWorkbenches.length).padStart(2, '0');

export const modulo = (value: number, length: number) => ((value % length) + length) % length;
