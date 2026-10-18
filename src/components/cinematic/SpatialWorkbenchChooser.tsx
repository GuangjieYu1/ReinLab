import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import Logo from './WorkbenchLogo';
import { entryWorkbenches, modulo, type EntryWorkbench } from './entryWorkbenches';
import './spatial-workbenches.css';

export type SpatialDesign = 'fan' | 'carousel' | 'ribbon';
const names = ['课程','研究','工程','创作','自动化','规划探索'];
const designs = {
  fan: { english:'DEPARTMENT / FOLIO', title:'从一份档案，展开一个世界。', hint:'六份部门档案，在你面前展开。' },
  carousel: { english:'DEPARTMENT / ROTUNDA', title:'沿着轨道，找到你的方向。', hint:'六个工作现场，围绕一个研究中枢。' },
  ribbon: { english:'DEPARTMENT / CONTINUUM', title:'让灵感流动，让工作开始。', hint:'学习、研究、创造与探索，在此交汇。' },
};
type Props = { design: SpatialDesign; selected: number; reduced: boolean; locked: boolean;
  onSelect: (index:number)=>void; onEnter:(workbench:EntryWorkbench,source?:HTMLElement)=>void };

export default function SpatialWorkbenchChooser({design,selected,reduced,locked,onSelect,onEnter}:Props) {
  const root = useRef<HTMLElement>(null);
  const [running,setRunning] = useState(!reduced);
  const [hovering,setHovering] = useState(false);
  const [turn,setTurn] = useState(selected);
  const previous = useRef(selected);
  const pointer = useRef({x:0,y:0});
  const active = entryWorkbenches[selected];
  const moving = running && !hovering && !locked && !reduced;
  useEffect(()=>{
    const delta = modulo(selected - previous.current + 3,6)-3;
    setTurn(value=>value+delta); previous.current=selected;
  },[selected]);
  useEffect(()=>{
    if (!moving) return;
    const timer = setInterval(()=>onSelect(modulo(selected+1,6)),5600);
    return ()=>clearInterval(timer);
  },[moving,selected,onSelect]);
  function select(index:number) { setRunning(false); onSelect(modulo(index,6)); }
  function enter() {
    const candidates = root.current?.querySelectorAll<HTMLElement>(`[data-workbench="${active.id}"]`);
    const visible = Array.from(candidates??[]).find(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=window.innerWidth&&r.top>=0&&r.bottom<=window.innerHeight;});
    onEnter(active,visible);
  }
  function face(workbench:EntryWorkbench,index:number,back=false) {
    return <>
      <span className="spatial-file-tab" aria-hidden="true"/>
      <span className="spatial-file-code">RL / {workbench.code}<span>{back?'RHINE LAB':'DEPARTMENT FILE'}</span></span>
      <Logo key={`${workbench.id}:${index===selected}:${back}`} workbench={workbench} still={reduced||back||index!==selected} startAt={.45}/>
      <span className="spatial-file-title">{workbench.title}</span>
      <span className="spatial-file-english">{workbench.english}</span>
      <span className="spatial-file-bottom">REINLAB · {workbench.code}<ArrowUpRight size={12}/></span>
    </>;
  }
  function card(workbench:EntryWorkbench,index:number,copy=false) {
    const chosen=index===selected;
    const style = design==='fan' ? {'--x':`${(index-2.5)*132}px`,'--y':`${Math.pow(Math.abs(index-2.5),1.3)*15}px`,'--angle':`${(index-2.5)*8}deg`,'--depth':`${-Math.abs(index-2.5)*14}px`,'--i':index} : {'--angle':`${index*60}deg`,'--i':index};
    return <button key={`${workbench.id}:${copy}`} className="spatial-object" data-active={chosen} data-workbench={workbench.id} style={style as CSSProperties} tabIndex={copy?-1:0} aria-hidden={copy||undefined} aria-pressed={chosen} aria-label={`${workbench.code} / ${workbench.title}${chosen?'，进入工作台':'，选择工作台'}`} onClick={event=>{
      setRunning(false); if(chosen)onEnter(workbench,event.currentTarget);else onSelect(index);
    }}>
      <span className="spatial-file-face">{face(workbench,index)}</span>
      {design==='carousel'&&<span className="spatial-file-back" aria-hidden="true">{face(workbench,index,true)}</span>}
    </button>;
  }
  return <section ref={root} className={`spatial-chooser spatial-${design}`} data-moving={moving} data-reduced={reduced} inert={locked} aria-label={`${designs[design].title} 六个工作台`} onPointerMove={event=>{
    if(reduced)return;const r=event.currentTarget.getBoundingClientRect();pointer.current={x:(event.clientX-r.left)/r.width-.5,y:(event.clientY-r.top)/r.height-.5};
    event.currentTarget.style.setProperty('--pointer-x',`${pointer.current.x*5}deg`);event.currentTarget.style.setProperty('--pointer-y',`${-pointer.current.y*4}deg`);
  }} onPointerLeave={event=>{event.currentTarget.style.setProperty('--pointer-x','0deg');event.currentTarget.style.setProperty('--pointer-y','0deg');setHovering(false);}}>
    <header className="spatial-heading"><div><span>{designs[design].english}</span><h1>{designs[design].title}</h1><p>{designs[design].hint}</p></div><div className="spatial-counter"><b>{active.code}</b><span>/ 06</span></div></header>
    <div className="spatial-stage" onPointerEnter={()=>setHovering(true)} onPointerLeave={()=>setHovering(false)}>
      <div className="spatial-floor" aria-hidden="true"/>
      <div className="spatial-camera">
        {design==='ribbon'?<div className="spatial-ribbon-world">{[0,1].map(lane=><div className="spatial-ribbon-lane" key={lane}><div className="spatial-ribbon-track">{[false,true].map(copy=><div className="spatial-ribbon-group" key={String(copy)}>{entryWorkbenches.slice(lane*3,lane*3+3).map((workbench,i)=>card(workbench,lane*3+i,copy))}</div>)}</div></div>)}</div>:
        <div className="spatial-world" style={{'--turn':`${-turn*60}deg`} as CSSProperties}>{entryWorkbenches.map((workbench,index)=>card(workbench,index))}{design==='carousel'&&<div className="spatial-ring" aria-hidden="true"/>}</div>}
      </div>
      {design==='carousel'&&<><button className="spatial-step spatial-step-prev" aria-label="上一个工作台" onClick={()=>select(selected-1)}><ChevronLeft size={20}/></button><button className="spatial-step spatial-step-next" aria-label="下一个工作台" onClick={()=>select(selected+1)}><ChevronRight size={20}/></button></>}
    </div>
    <div className="spatial-caption"><div key={active.id}><span>{active.english}</span><h2>{active.title}</h2><p>{active.description}</p></div><button className="spatial-enter" onClick={enter}>进入工作台<ArrowUpRight size={17}/></button></div>
    <nav className="spatial-directory" aria-label="快速选择工作台">{entryWorkbenches.map((workbench,index)=><button key={workbench.id} aria-pressed={index===selected} onClick={()=>select(index)}><span>{workbench.code}</span>{names[index]}</button>)}</nav>
    <button className="spatial-motion-toggle" disabled={reduced} aria-pressed={running} onClick={()=>setRunning(value=>!value)}>{running&&!reduced?<Pause size={11}/>:<Play size={11}/>}<span>{reduced?'静态浏览':running?'暂停巡航':'恢复巡航'}</span></button>
  </section>;
}
