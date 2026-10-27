import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, ArrowUpRight, Pause, Play, RotateCcw, X } from 'lucide-react';
import Logo from '../cinematic/WorkbenchLogo';
import { entryWorkbenches } from '../cinematic/entryWorkbenches';
import './workbench-overviews.css';

type Studio = 'engineering' | 'creative' | 'automation' | 'exploration';
type File = { id: string; title: string; brief: string; status: string };
type Detail = { code: string; title: string; description: string; fields: [string, string][]; file?: number };
type Inspect = (detail: Detail) => void;
const colors = ['#87976e', '#b6a06b', '#a292af'];
const info: Record<Studio, { title: string; english: string; code: string; purpose: string; archive: string; steps: string[] }> = {
  engineering: { title: '工程总览', english: 'ENGINEERING ASSEMBLY', code: '03', purpose: '从需求到交付，观察各部分如何组成一个可运行的原型。', archive: '工程项目', steps: ['阅读项目约定', '装配档案索引', '连接项目视图', '形成交互预览', '核对页面排布', '核对入口关系', '汇成交付草案'] },
  creative: { title: '创作总览', english: 'CREATIVE ATELIER', code: '04', purpose: '从素材与构思出发，让作品、版本和表达逐渐成形。', archive: '作品档案', steps: ['整理表达线索', '建立初始构图', '调整留白比例', '比较三个版本', '编排叙事片段', '归拢作品与说明'] },
  automation: { title: '调度总览', english: 'WORKFLOW OBSERVATORY', code: '05', purpose: '三条流程汇入档案，沿着输入、处理与归档观察每一步。', archive: '流程档案', steps: ['提取新资料重点', '整理带来源的摘要', '研究摘要进入示例档案', '整理作品版本', '准备作品说明', '作品与说明进入示例档案', '汇总探索记录', '关联地点与问题', '现场札记进入示例档案'] },
  exploration: { title: '探索总览', english: 'FIELD EXPLORATION', code: '06', purpose: '把计划放在地图上，让路线、观察与现场记录彼此相连。', archive: '探索计划', steps: ['整理观察路线', '预演河岸记录', '预演街区观察', '预演建筑考察', '预演资料整理'] },
};

function Hit({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <g className="wo-hit" role="button" tabIndex={0} aria-label={label} onClick={onClick} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }}>{children}</g>;
}
function CornerField({ x = 290, y = 45, width = 870, height = 445 }: { x?: number; y?: number; width?: number; height?: number }) {
  return <g aria-hidden="true"><defs><pattern id="wo-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#d5dcc8" strokeWidth=".5"/></pattern></defs><rect x={x} y={y} width={width} height={height} fill="url(#wo-grid)" opacity=".38"/><path d={`M${x} ${y+15}V${y}H${x+15}M${x+width-15} ${y}H${x+width}V${y+15}M${x} ${y+height-15}V${y+height}H${x+15}M${x+width-15} ${y+height}H${x+width}V${y+height-15}`} className="wo-corner"/></g>;
}
function PaperMark({ x, y, color = '#f4f2e7' }: { x: number; y: number; color?: string }) {
  return <g transform={`translate(${x} ${y})`} aria-hidden="true"><rect x="3" y="4" width="31" height="23" fill="#e0e6d5"/><rect width="31" height="23" fill={color} stroke="#bcc6ad" strokeWidth=".8"/><path d="M6 7H25M6 12H25M6 17H18" stroke="#b3bea2" strokeWidth=".8"/></g>;
}

function EngineeringScene({ phase, inspect, file, open }: { phase: number; inspect: Inspect; file: File; open: () => void }) {
  const modules = ['档案索引', '项目视图', '预览界面'];
  const checks = ['排布与层次', '档案与入口', '成果与说明'];
  const worker = [{ x: 283, y: 255 }, { x: 415, y: 368 }, { x: 600, y: 368 }, { x: 785, y: 368 }, { x: 940, y: 132 }, { x: 940, y: 204 }, { x: 940, y: 276 }][Math.min(phase, 6)];
  return <svg className="wo-scene" viewBox="0 0 1200 510" role="group" aria-label="工程装配总览：项目约定、组件装配、界面预览与交付核对">
    <CornerField/><text x="45" y="45" className="wo-label">PROJECT / SPECIFICATION</text>
    <Hit label="查看项目约定" onClick={() => inspect({ code: 'SPEC / E—021', title: file.title, description: file.brief, fields: [['目标', '让档案、项目与成果形成清楚的入口关系。'], ['约束', '沿用 ReinLab 的纸白材质、细线与编号。'], ['完成条件', '形成可浏览的原型与交付说明。']], file: 0 })}>
      <rect x="35" y="65" width="215" height="390" className="wo-paper"/><text x="55" y="98" className="wo-micro">E—021 / BRIEF</text><text x="55" y="143" className="wo-heading">档案浏览器</text><text x="55" y="169" className="wo-copy">把工作组织成可调阅的档案。</text>
      {['项目有独立编号', '入口与内容关联', '成果能回到档案'].map((label, index) => <g key={label}><path d={`M55 ${215+index*39}h140`} className="wo-rule"/><text x="55" y={237+index*39} className="wo-copy">0{index+1}　{label}</text></g>)}<text x="55" y="415" className="wo-link">查看约定与交付范围 ↗</text>
    </Hit>
    <path d="M250 255H285V174H335M415 388V348M600 388V348M785 388V348M895 220H938V132H964M938 204H964M938 276H964M938 204V276" className="wo-connection"/>
    <text x="335" y="68" className="wo-label">ASSEMBLY / LIVE PREVIEW</text>
    <Hit label="打开档案浏览器的实现与预览" onClick={open}>
      <rect x="335" y="87" width="560" height="261" className="wo-paper wo-window"/><rect x="335" y="87" width="560" height="30" fill="#ecefe2"/><path d="M335 117H895" className="wo-rule"/><circle cx="351" cy="102" r="2" fill="#acb79a"/><circle cx="360" cy="102" r="2" fill="#acb79a"/><circle cx="369" cy="102" r="2" fill="#acb79a"/><text x="382" y="105" className="wo-micro">REINLAB / WORKSPACE</text>
      <text x="361" y="157" className="wo-heading">每一次工作，都有一个去处。</text><text x="361" y="181" className="wo-copy">档案索引　/　项目视图　/　成果预览</text>
      {[0, 1, 2].map(index => <motion.g key={index} initial={false} animate={{ opacity: phase > index+1 ? 1 : .3 }} transition={{ duration: .5 }}><rect x={361+index*168} y="207" width="147" height="91" fill={index===1?'#f4f0e2':'#f1f4e9'} stroke="#ccd5ba" strokeWidth=".8"/><text x={374+index*168} y="230" className="wo-micro">FILE / 0{index+1}</text><text x={374+index*168} y="260" className="wo-copy">{['研究记录','工作草案','已完成的成果'][index]}</text><text x={482+index*168} y="283" className="wo-link">↗</text></motion.g>)}
      <text x="361" y="327" className="wo-micro">{phase>=4?'原型已装配 · 查看示例实现':'组件正在进入原型 · 本地装配示意'}</text><text x="863" y="327" className="wo-link">↗</text>
    </Hit>
    {modules.map((name,index) => <Hit key={name} label={`查看组件 ${name}`} onClick={()=>inspect({code:`COMPONENT / 0${index+1}`,title:name,description:['组织档案编号与目录。','把当前项目与它的资料关联起来。','呈现当前实现与成果的关系。'][index],fields:[['输入',['档案清单','项目资料','组件与排布'][index]],['输出',['可浏览的目录','项目工作区','页面原型'][index]],['当前状态',phase>index+1?'已进入装配示意':'等待装配示意']],file:0})}><rect x={335+index*185} y="388" width="160" height="67" className={`wo-paper ${phase>index+1?'wo-ready':''}`}/><text x={350+index*185} y="411" className="wo-micro">COMPONENT / 0{index+1}</text><text x={350+index*185} y="437" className="wo-copy">{name}</text><text x={475+index*185} y="439" className="wo-link">↗</text></Hit>)}
    <text x="966" y="68" className="wo-label">VERIFY / DELIVER</text>
    {checks.map((name,index)=><Hit key={name} label={`查看核对项 ${name}`} onClick={()=>inspect({code:`CHECK / 0${index+1}`,title:name,description:'核对项展示交付前需要确认的关系；本轮只演示状态变化。',fields:[['核对目的',['阅读顺序与视觉层级是否清楚。','目录能否明确指向对应内容。','作品、版本与说明是否成套保存。'][index]],['示例状态',phase>=index+5?'模拟核对已完成':'尚未到达本项'],['核对方式','人工阅读与界面操作']],file:0})}><rect x="964" y={103+index*72} width="193" height="58" className="wo-paper"/><text x="979" y={125+index*72} className="wo-micro">0{index+1} / CHECK</text><text x="979" y={145+index*72} className="wo-copy">{name}</text>{phase>=index+5?<path d={`M1123 ${133+index*72}l5 5 9-10`} className="wo-check"/>:<circle cx="1134" cy={133+index*72} r="4" className="wo-idle"/>}</Hit>)}
    <Hit label="查看交付草案" onClick={()=>inspect({code:'DELIVERY / DRAFT',title:'原型与交付说明',description:'把实现、预览和核对记录放回同一份项目档案。',fields:[['交付对象','ReinLab · 档案浏览器'],['示例状态',phase>=7?'本轮装配示意已结束':'正在装配与核对'],['保留内容','组件、预览与核对说明']],file:0})}><PaperMark x={976} y={385}/><text x="1023" y="404" className="wo-copy">交付草案</text><text x="1023" y="425" className="wo-micro">{phase>=7?'READY / 示例':'ASSEMBLY / 示意'}</text></Hit>
    {phase<7&&<motion.g className="wo-moving-marker" initial={false} animate={worker} transition={{duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:1.1,ease:[.22,1,.36,1]}} aria-hidden="true"><circle r="18" fill="#eff2e4" stroke="#acbb91" strokeWidth=".7"/><circle r="4" fill="#83966a"/></motion.g>}
    <text x="335" y="490" className="wo-coordinate">BUILD / 03 COMPONENTS → 03 CHECKS → 01 DELIVERY</text>
  </svg>;
}

function MiniArtwork({ x, y, scale = 1, version = 2 }: { x: number; y: number; scale?: number; version?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`} aria-hidden="true"><path d="M0 106L100 43L194 76L99 145Z" fill="#d4cdb94d"/>{[0,1,2,3].map(index=><motion.g key={index} initial={false} animate={{x:index*(version===0?31:version===1?19:24),y:-index*12}} transition={{duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:.8}}><path d="M12 38L59 11V106L12 133Z" fill="#e9e2d0"/><path d="M59 11L72 19V114L59 106Z" fill="#c7bda2"/><path d="M12 38L25 46L72 19L59 11Z" fill="#faf6e9"/></motion.g>)}<path d="M-6 125v13m-6-6H0" stroke="#b6a06b" strokeWidth=".8"/></g>;
}
function CreativeScene({ phase, inspect, open }: { phase: number; inspect: Inspect; open: () => void }) {
  const version=Math.min(2, Math.max(0,phase-2));
  return <svg className="wo-scene" viewBox="0 0 1200 510" role="group" aria-label="创作画布总览：素材、中央作品、版本与叙事片段">
    <CornerField x={320} y={35} width={840} height={445}/><path d="M260 188C345 188 349 150 423 150M714 150C780 150 769 105 840 105M580 407C580 450 299 455 299 427" className="wo-connection"/>
    <text x="38" y="50" className="wo-label">MATERIAL / DIRECTION</text>
    <Hit label="查看创作素材与表达方向" onClick={()=>inspect({code:'MATERIAL / 01',title:'建筑、光线与留白',description:'先确定观察的主题和表达的尺度，再组织素材。',fields:[['主题','记录建筑之间的空间。'],['素材','建筑轮廓、光线、空间观察札记。'],['色彩','纸白、石灰与少量墨绿。']],file:0})}>
      <rect x="35" y="72" width="230" height="215" className="wo-paper"/><text x="56" y="101" className="wo-micro">CREATIVE DIRECTION / 001</text><text x="56" y="144" className="wo-heading">少一些填满，</text><text x="56" y="174" className="wo-heading">多一些停留。</text><text x="56" y="206" className="wo-copy">建筑　·　光线　·　留白</text>{['#f3eee0','#cabfa4','#505b42'].map((color,index)=><rect key={color} x={56+index*31} y="229" width="24" height="24" fill={color} stroke="#c4c7b5" strokeWidth=".6"/>)}<text x="212" y="255" className="wo-link">↗</text>
    </Hit>
    <text x="425" y="38" className="wo-label">WORK / IN PROGRESS</text>
    <Hit label="打开城市留白作品画布" onClick={open}>
      <rect x="431" y="61" width="293" height="355" fill="#dce2cf" opacity=".35"/><rect x="423" y="54" width="293" height="355" className="wo-poster"/>
      <text x="446" y="82" className="wo-micro">REINLAB / FIELD NOTES</text><path d="M446 93H693" className="wo-rule"/><text x="446" y="128" className="wo-micro">OBSERVATION 001</text><text x="446" y="169" className="wo-poster-title">城市</text><text x="446" y="211" className="wo-poster-title">之间。</text><text x="446" y="239" className="wo-micro">THE SPACE</text><text x="446" y="253" className="wo-micro">BETWEEN THINGS</text>
      <MiniArtwork x={505} y={247} scale={.9} version={version}/><path d="M446 380H693" className="wo-rule"/><text x="446" y="395" className="wo-micro">建筑 / 光线 / 留白</text><text x="690" y="395" textAnchor="end" className="wo-micro">V.0{version+1} ↗</text>
    </Hit>
    <text x="837" y="50" className="wo-label">VERSION / COMPARISON</text>
    {['初始构思','调整留白','当前构图'].map((name,index)=><Hit key={name} label={`查看创作版本 V.0${index+1} ${name}`} onClick={()=>inspect({code:`VERSION / V.0${index+1}`,title:name,description:['先把主题和视觉主体放在一起，确定表达的出发点。','缩小主体、扩大留白，让阅读在画面中停留。','重新安排主体间距，形成当前构图。'][index],fields:[['保留内容','构图、视觉主体与调整理由。'],['取舍记录',['展开建筑轮廓','调整主体尺度','明确视觉重心'][index]],['状态',version===index?'总览当前展示此版本':'可在作品画布中比较']],file:0})}>
      <rect x={844+index*6} y={82+index*95} width="239" height="78" className={`wo-paper ${version===index?'wo-ready':''}`}/><MiniArtwork x={862+index*6} y={93+index*95} scale={.37} version={index}/><text x={968+index*6} y={110+index*95} className="wo-micro">V.0{index+1}</text><text x={968+index*6} y={137+index*95} className="wo-copy">{name}</text><text x={1064+index*6} y={138+index*95} className="wo-link">↗</text>
    </Hit>)}
    <text x="38" y="343" className="wo-label">STORY / SEQUENCE</text>
    {['观察','展开','停留'].map((name,index)=><Hit key={name} label={`查看叙事片段 ${name}`} onClick={()=>inspect({code:`STORY / 0${index+1}`,title:name,description:['先让观察的问题出现。','展开建筑、光线与空间的关系。','为阅读与思考保留空隙。'][index],fields:[['片段作用','连接视觉主题与阅读顺序。'],['作品关联','ReinLab · 开场分镜'],['输出','画面与分镜说明']],file:1})}><rect x={35+index*92} y="363" width="80" height="95" className="wo-paper"/><path d={`M${50+index*92} 426v-37l18-10v38Z`} fill={index===1?'#d0c5a5':'#dce2cf'}/><path d={`M${73+index*92} 412v-28l12-7v30Z`} fill="#e9e4d4"/><text x={48+index*92} y="447" className="wo-micro">0{index+1} / {name}</text></Hit>)}
    <Hit label="查看作品与说明的归档关系" onClick={()=>inspect({code:'OUTPUT / CREATIVE FILE',title:'作品与取舍一起保存',description:'将作品、表达设定、版本与说明归入同一份创作档案。',fields:[['作品','城市留白 · 视觉札记'],['过程','素材、构图与版本比较'],['示例进度',phase>=6?'本轮创作示意已归拢':'正在组织表达与版本']],file:0})}><PaperMark x={846} y={395}/><text x="893" y="414" className="wo-copy">作品 · 版本 · 说明</text><text x="893" y="437" className="wo-micro">{phase>=6?'ARCHIVED / 示例':'OUTPUT / DRAFT'}</text></Hit>
    <text x="424" y="477" className="wo-coordinate">COMPOSITION / OPEN SPACE / VERSION {version+1}</text>
  </svg>;
}

const flowNames=[['提取重点','生成摘要','研究归档'],['整理版本','准备说明','作品归档'],['汇总记录','关联地点','探索归档']];
const flowTriggers=['新资料进入','作品完成','结束探索'];
function nodeStage(row:number,column:number){ return row*3+column+1; }
function AutomationScene({phase,inspect,files}:{phase:number;inspect:Inspect;files:File[]}){
  const completed=[phase>=3,phase>=6,phase>=9];
  return <svg className="wo-scene" viewBox="0 0 1200 510" role="group" aria-label="自动化调度总览：研究、创作与探索三条流程的输入、处理和归档">
    <CornerField x={225} y={52} width={935} height={410}/><text x="35" y="38" className="wo-label">INPUT / TRIGGER</text><text x="266" y="38" className="wo-label">WORKFLOWS / EXECUTION FIELD</text><text x="980" y="38" className="wo-label">OUTPUT / ARCHIVE</text>
    {[0,1,2].map(row=><g key={row} className={`wo-flow-lane wo-flow-lane-${row}`}>
      <text x="263" y={89+row*139} className="wo-coordinate">0{row+1} / {files[row].title}</text>
      <Hit label={`查看触发条件 ${flowTriggers[row]}`} onClick={()=>inspect({code:`TRIGGER / 0${row+1}`,title:flowTriggers[row],description:files[row].brief,fields:[['触发时机',['资料进入或约定时间','作品完成后','一次探索结束后'][row]],['传入内容',['新增资料与来源','作品与修改记录','照片、地点与笔记'][row]],['本次状态','本地流程示意，不建立实际定时任务。']],file:row})}><rect x="35" y={114+row*139} width="173" height="69" className="wo-paper"/><circle cx="56" cy={137+row*139} r="3" fill={colors[row]}/><text x="70" y={141+row*139} className="wo-micro">TRIGGER / 0{row+1}</text><text x="54" y={165+row*139} className="wo-copy">{flowTriggers[row]}</text></Hit>
      <path d={`M208 ${149+row*139}H904Q941 ${149+row*139} 955 240H980`} className="wo-connection"/>
      {phase>=row*3&&phase<row*3+3&&<path d={`M208 ${149+row*139}H904`} className="wo-flowing" style={{stroke:colors[row]}}/>}
      {flowNames[row].map((name,column)=><Hit key={name} label={`查看流程节点 ${name}`} onClick={()=>inspect({code:`STEP / 0${row+1}.0${column+1}`,title:name,description:files[row].brief,fields:[['所属流程',files[row].title],['输入',['资料与记录','整理后的内容','成果与来源'][column]],['输出',name],['示例状态',phase>=nodeStage(row,column)?'本节点已演示':phase===nodeStage(row,column)-1?'当前演示此节点':'等待本轮演示']],file:row})}><rect x={262+column*218} y={114+row*139} width="163" height="69" className={`wo-paper ${phase>=nodeStage(row,column)?'wo-ready':''}`} style={{stroke:phase===nodeStage(row,column)-1?colors[row]:undefined}}/><text x={279+column*218} y={137+row*139} className="wo-micro">0{row+1}.0{column+1} / STEP</text><text x={279+column*218} y={163+row*139} className="wo-copy">{name}</text>{phase>=nodeStage(row,column)&&<path d={`M${400+column*218} ${158+row*139}l4 4 7-8`} className="wo-check"/>}</Hit>)}
    </g>)}
    <Hit label="查看归档输出与运行记录" onClick={()=>inspect({code:'OUTPUT / RUN LEDGER',title:'每一次执行，都有去处',description:'流程的结果和过程一起进入档案；失败或等待需要单独保留。',fields:[['示例已归档',`${completed.filter(Boolean).length} / 3 条流程`],['保留内容','成果、来源与步骤记录。'],['实际执行','本页只演示流转，不调用服务或建立任务。']]})}><rect x="980" y="92" width="180" height="348" className="wo-paper"/><text x="999" y="122" className="wo-micro">RUN / LEDGER</text><text x="999" y="158" className="wo-heading">归档现场</text>{['研究摘要','作品说明','现场札记'].map((name,index)=><g key={name}><path d={`M997 ${199+index*72}h146`} className="wo-rule"/><PaperMark x={1000} y={215+index*72}/><text x="1049" y={231+index*72} className="wo-copy">{name}</text><text x="1049" y={253+index*72} className="wo-micro">{completed[index]?'已演示归档':'等待流转'}</text></g>)}</Hit>
    <text x="35" y="487" className="wo-coordinate">03 WORKFLOWS / 09 STEPS / SHARED ARCHIVE</text>
  </svg>;
}

const fieldStops=[{name:'河岸记录',time:'09:00',x:362,y:361,note:'观察光线、开阔空间与人的停留。'},{name:'街区观察',time:'10:30',x:529,y:268,note:'记录街道界面与建筑之间的间隙。'},{name:'建筑考察',time:'13:00',x:785,y:183,note:'从材料、尺度与细节理解空间。'},{name:'资料整理',time:'15:30',x:983,y:326,note:'把照片、笔记与问题关联归档。'}];
function ExplorationScene({phase,inspect,open}:{phase:number;inspect:Inspect;open:()=>void}){
  const visited=Math.max(0,Math.min(4,phase-1));
  const current=fieldStops[Math.max(0,visited-1)];
  return <svg className="wo-scene" viewBox="0 0 1200 510" role="group" aria-label="规划探索总览：京都观察路线示意、四个站点与现场记录">
    <defs><pattern id="wo-streets" width="72" height="61" patternUnits="userSpaceOnUse"><rect x="8" y="8" width="47" height="37" fill="#e5e7da"/><path d="M0 54H72M63 0V61" stroke="#f8f8ef" strokeWidth="9"/></pattern></defs>
    <CornerField x={285} y={35} width={875} height={423}/><rect x="300" y="49" width="841" height="394" fill="url(#wo-streets)" opacity=".75"/><path d="M640 28C568 126 545 150 565 229S646 349 602 458" fill="none" stroke="#d6dfcc" strokeWidth="42"/><path d="M640 28C568 126 545 150 565 229S646 349 602 458" fill="none" stroke="#eef2e5" strokeWidth="1.5"/><path d="M289 323L1150 76M293 410L1160 256" stroke="#fcfcf4" strokeWidth="13" fill="none"/>
    <text x="35" y="42" className="wo-label">PLAN / FIELD NOTES</text>
    <Hit label="打开京都城市观察计划" onClick={open}><rect x="35" y="65" width="216" height="275" className="wo-paper"/><text x="55" y="97" className="wo-micro">P—013 / ONE DAY</text><text x="55" y="143" className="wo-heading">京都</text><text x="55" y="174" className="wo-heading">城市留白观察</text><text x="55" y="208" className="wo-copy">河岸　/　街区　/　建筑</text><path d="M55 228H230" className="wo-rule"/><text x="55" y="255" className="wo-copy">带着问题出发。</text><text x="55" y="282" className="wo-micro">01 DAY / 04 STOPS</text><text x="55" y="318" className="wo-link">查看计划与时间表 ↗</text></Hit>
    <Hit label="查看探索前的准备" onClick={()=>inspect({code:'FIELD KIT / PREPARATION',title:'为发现留出位置',description:'提前准备问题与记录方式，返回后再整理发现。',fields:[['观察问题','哪些空间使人愿意停留？'],['记录方式','照片、位置与现场札记。'],['收尾安排','保留整理资料的时间。']],file:0})}><PaperMark x={49} y={377}/><text x="96" y="393" className="wo-copy">观察问题 · 记录方式</text><text x="96" y="416" className="wo-micro">FIELD KIT / DRAFT</text></Hit>
    <path d="M362 361L430 319L529 268L649 227L785 183L888 230L983 326" className="wo-route"/>
    {fieldStops.map((stop,index)=><Hit key={stop.name} label={`查看观察站点 ${stop.name}`} onClick={()=>inspect({code:`STOP / 0${index+1}`,title:stop.name,description:stop.note,fields:[['计划时段',stop.time],['计划目的',stop.note],['示例状态',visited>index?'路线预演已经过此点':'等待路线预演'],['记录位置','归入京都城市留白观察档案。']],file:0})}><circle cx={stop.x} cy={stop.y} r="20" fill={visited>index?'#82966b':'#fafbf1'} stroke="#99ae7d" strokeWidth="1"/><text x={stop.x} y={stop.y+4} textAnchor="middle" className={`wo-pin-number ${visited>index?'passed':''}`}>0{index+1}</text><rect x={stop.x-44} y={stop.y+29} width="88" height="24" fill="#f9faeef0"/><text x={stop.x} y={stop.y+45} textAnchor="middle" className="wo-copy">{stop.name}</text></Hit>)}
    {visited>0&&<motion.g initial={false} animate={{x:current.x,y:current.y}} transition={{duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:1.7,ease:[.22,1,.36,1]}} aria-hidden="true"><circle r="29" fill="none" stroke="#9cab7b" strokeWidth="1" strokeDasharray="2 4"/></motion.g>}
    <Hit label="查看现场记录的归档关系" onClick={()=>inspect({code:'FIELD NOTES / ARCHIVE',title:'发现回到工作室',description:'计划、路线和记录共用一份档案，保留现场观察与后续判断的连接。',fields:[['示例记录点',`${visited} / 4`],['整理内容','地点、照片位置与观察笔记。'],['地图说明','本页为路线示意，不代表真实街道或导航。']],file:0})}><rect x="955" y="65" width="181" height="90" className="wo-paper"/><text x="972" y="88" className="wo-micro">FIELD NOTES / 0{visited}</text><text x="972" y="116" className="wo-copy">把发现带回工作室。</text><text x="972" y="139" className="wo-link">查看记录位置 ↗</text></Hit>
    <text x="320" y="72" className="wo-coordinate">KYOTO / SCHEMATIC ROUTE</text><path d="M1107 380v-38m-6 9 6-9 6 9" className="wo-corner"/><text x="1107" y="397" textAnchor="middle" className="wo-micro">N</text>
    {fieldStops.map((stop,index)=><text key={stop.name} x={302+index*220} y="483" className="wo-copy"><tspan className="wo-micro">{stop.time}　</tspan>{stop.name}</text>)}
  </svg>;
}

export default function WorkbenchOverviews({ studio, files, suspended, onOpenFiles, onOpenProject }: { studio: Studio; files: File[]; suspended: boolean; onOpenFiles: () => void; onOpenProject: (index: number) => void }) {
  const settings=info[studio];
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [phase,setPhase]=useState(0);
  const [playing,setPlaying]=useState(!reduced);
  const [detail,setDetail]=useState<Detail|null>(null);
  const [zoomed,setZoomed]=useState(false);
  const origin=useRef<Element|null>(null);
  const inspector=useRef<HTMLElement>(null);
  const finished=phase===settings.steps.length;
  useEffect(()=>{if(!playing||detail||suspended||finished)return;const timer=setTimeout(()=>{if(document.hidden){setPlaying(false);return;}setPhase(value=>Math.min(settings.steps.length,value+1));},2600);return()=>clearTimeout(timer);},[phase,playing,detail,suspended,finished,settings.steps.length]);
  useEffect(()=>{if(detail)inspector.current?.focus({preventScroll:true});},[detail]);
  function inspect(value:Detail){origin.current=document.activeElement;setDetail(value);}
  function close(){setDetail(null);const element=origin.current;if(element instanceof HTMLElement||element instanceof SVGElement)element.focus({preventScroll:true});}
  function open(index=0){setDetail(null);onOpenProject(index);}
  const logo=entryWorkbenches.find(item=>item.id===studio)!;
  return <div className={`wo-overview wo-${studio}${zoomed?' wo-zoomed':''}${!playing||detail||suspended?' wo-paused':''}`} aria-label={`${settings.title} · 本地动态演示`}>
    <header className="wo-header"><div><span>DEPARTMENT / {settings.code}</span><h1>{settings.title}<small>{settings.english}</small></h1></div><div className="wo-actions"><button onClick={onOpenFiles}>{settings.archive}<span>{String(files.length).padStart(2,'0')}</span><ArrowRight size={12}/></button><button onClick={()=>open()}>打开当前档案<ArrowUpRight size={12}/></button><Logo workbench={logo} still={reduced}/></div></header>
    <div className="wo-mission"><span>{studio==='exploration'?'FIELD QUESTION':'CURRENT FOCUS'}</span><p>{settings.purpose}</p><button onClick={()=>open()}>{files[0].id}<ArrowUpRight size={12}/></button></div>
    <div className="wo-scene-tools"><span>全景 · 点击对象查看细节</span><button aria-pressed={zoomed} onClick={()=>setZoomed(value=>!value)}>{zoomed?'返回全景':'展开观测图'}<ArrowUpRight size={11}/></button></div>
    <div className="wo-canvas">
      {studio==='engineering'?<EngineeringScene phase={phase} inspect={inspect} file={files[0]} open={()=>open()}/>:studio==='creative'?<CreativeScene phase={phase} inspect={inspect} open={()=>open()}/>:studio==='automation'?<AutomationScene phase={phase} inspect={inspect} files={files}/>:<ExplorationScene phase={phase} inspect={inspect} open={()=>open()}/>}
    </div>
    <nav className="wo-mobile-files" aria-label="工作台档案快捷入口">{files.slice(0,3).map((file,index)=><button key={file.id} onClick={()=>open(index)}><span>{file.id}</span><b>{file.title}</b><small>{file.status}</small><ArrowUpRight size={12}/></button>)}</nav>
    {detail&&<aside ref={inspector} tabIndex={-1} className="wo-inspector" role="dialog" aria-label="工作对象详情" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}}}><button className="wo-close" aria-label="关闭工作对象详情" onClick={close}><X size={15}/></button><span>{detail.code}</span><h2>{detail.title}</h2><p>{detail.description}</p><dl>{detail.fields.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{detail.file!==undefined&&<button className="wo-detail-link" onClick={()=>open(detail.file)}>打开关联档案<ArrowRight size={13}/></button>}<small>本地示意记录 · 展示对象关系与工作过程。</small></aside>}
    <div className="wo-event" role="status"><span><i/>{detail||suspended?'查看细节':finished?'本轮示意结束':playing?'工作现场 · 动态示意':'已暂停演示'}</span><p>{phase===0?settings.steps[0]:settings.steps[Math.min(settings.steps.length-1,phase-1)]}</p><span>{finished?'成果与过程已在图中汇合':detail||suspended?'关闭后接续当前进度':'点击图中对象，查看工作细节'}</span></div>
    <footer className="wo-transport"><div><button aria-label={playing?'暂停工作台演示':'继续工作台演示'} disabled={finished} onClick={()=>setPlaying(value=>!value)}>{playing?<Pause size={14}/>:<Play size={14}/>}</button><button aria-label="推进一个工作台步骤" disabled={finished} onClick={()=>{setPlaying(false);setPhase(value=>Math.min(settings.steps.length,value+1));}}><ArrowRight size={14}/></button><button aria-label="重播工作台演示" onClick={()=>{setPhase(0);setPlaying(!reduced);setDetail(null);}}><RotateCcw size={14}/></button><span>{String(phase).padStart(2,'0')} / {String(settings.steps.length).padStart(2,'0')}</span></div><span className="wo-transport-hint">总览 → 对象 → 档案</span><span>本地动态演示 · {studio==='exploration'?'路线示意':'刷新重置'} · 保留原有工作台入口</span></footer>
  </div>;
}
