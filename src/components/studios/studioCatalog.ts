import type { StudioId, StudioFile } from './worksiteModel';
export const studioConfig:Record<StudioId,{english:string;subtitle:string;label:string;outputs:string;files:StudioFile[]}>={
  research:{english:'RESEARCH / EVIDENCE',subtitle:'让问题、证据与结论，在同一个现场相遇。',label:'研究档案',outputs:'研究草案 · 证据索引',files:[
    {id:'R—014',title:'AI 参与创作的边界',brief:'AI 参与创作时，怎样保留人的判断？',status:'证据整理'},
    {id:'R—015',title:'模型结构对照',brief:'不同结构的模型，如何在同一组任务中比较？',status:'问题定义'},
    {id:'R—016',title:'城市中的留白',brief:'空间的留白，怎样影响人的观察与停留？',status:'研究笔记'},
  ]},
  engineering:{english:'ENGINEERING / BUILD',subtitle:'从一个明确的需求，到一个可以运行的事物。',label:'工程项目',outputs:'交互原型 · 交付说明',files:[
    {id:'E—021',title:'ReinLab · 档案浏览器',brief:'用一个清楚的界面组织工作台档案与成果。',status:'原型迭代'},
    {id:'E—022',title:'研究资料整理器',brief:'把资料来源、摘录与问题关联起来。',status:'需求整理'},
    {id:'E—023',title:'城市观察记录工具',brief:'记录一次观察中的地点、图像和笔记。',status:'交互设计'},
  ]},
  creative:{english:'CREATIVE / COMPOSITION',subtitle:'让一个念头，逐渐成为一件作品。',label:'作品档案',outputs:'作品画布 · 风格与版本',files:[
    {id:'C—008',title:'城市留白 · 视觉札记',brief:'以建筑、光线和留白，组织一篇视觉叙事。',status:'构图调整'},
    {id:'C—009',title:'ReinLab · 开场分镜',brief:'用六个镜头讲述工作室的进入过程。',status:'分镜草案'},
    {id:'C—010',title:'观察者手册',brief:'为一次新的探索，准备一份可携带的手册。',status:'文本编辑'},
  ]},
  automation:{english:'AUTOMATION / CONTINUITY',subtitle:'让每一步有去处，让每一次执行有记录。',label:'流程档案',outputs:'执行流程 · 运行记录',files:[
    {id:'A—003',title:'每日研究资料整理',brief:'把新资料整理成摘要，并归入对应研究档案。',status:'流程草案'},
    {id:'A—004',title:'创作成果归档',brief:'为每次完成的作品整理封面、版本与说明。',status:'步骤配置'},
    {id:'A—005',title:'探索记录汇总',brief:'把一次探索的零散记录整理成完整档案。',status:'待预演'},
  ]},
  exploration:{english:'EXPLORATION / FIELDWORK',subtitle:'把目的、路线与现场的发现，连接起来。',label:'探索计划',outputs:'路线草案 · 现场记录',files:[
    {id:'P—013',title:'京都 · 城市留白观察',brief:'沿着河岸与街区，记录建筑之间的空隙。',status:'路线草案'},
    {id:'P—014',title:'建筑与街区观察',brief:'从建筑的细节，走向街区的整体。',status:'观察准备'},
    {id:'P—015',title:'展览与资料室',brief:'带着问题进入展览，把发现带回工作室。',status:'资料整理'},
  ]},
};
