import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import Logo from './WorkbenchLogo';
import { countLabel, entryWorkbenches, modulo, WORKBENCH_COUNT as N, type EntryWorkbench } from './entryWorkbenches';
import './architectural-workbenches.css';

export type ArchitecturalDesign = 'matrix' | 'glass' | 'axis';
type Props = { design: ArchitecturalDesign; selected: number; reduced: boolean; locked: boolean;
  onSelect: (index:number)=>void; onEnter:(workbench:EntryWorkbench,source?:HTMLElement)=>void };
const labels = { matrix:'RELIEF / FIELD', glass:'OPTICAL / SECTION', axis:'AXIAL / STUDIO' };
const shortNames = ['课程','研究','工程','创作','自动化','规划探索','数据'];
const tiles = Array.from({length:99},(_,index)=>({column:index%11-5,row:Math.floor(index/11)-4,index}));

export default function ArchitecturalWorkbenchChooser({design,selected,reduced,locked,onSelect,onEnter}:Props) {
  const root = useRef<HTMLElement>(null);
  const camera = useRef<HTMLDivElement>(null);
  const [running,setRunning] = useState(!reduced);
  const [size,setSize] = useState({width:1280,height:800});
  const active = entryWorkbenches[selected];
  const moving = running && !locked && !reduced;
  const images = useMemo(()=>entryWorkbenches.map(workbench=>{
    const held=workbench.logo.replace('</style>','.rhine-mark .motion{display:none}.rhine-mark .still{display:inline}</style>');
    const relief=held.replace(/--ink:[^;]+;/,'--ink:#b9b3a5;').replace(/--accent:[^;]+;/,'--accent:#b5a989;').replace(/--muted:[^;]+;/,'--muted:#c3beb1;');
    return { held:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(held)}`,relief:`data:image/svg+xml;charset=utf-8,${encodeURIComponent(relief)}` };
  }),[]);
  useEffect(()=>{
    const element=root.current;if(!element)return;
    const resize=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));
    resize.observe(element);return()=>resize.disconnect();
  },[]);
  useEffect(()=>{
    if(!moving)return;
    const timer=setInterval(()=>onSelect(modulo(selected+1,N)),6800);
    return()=>clearInterval(timer);
  },[moving,selected,onSelect]);
  const scale=Math.max(size.width/1920,size.height/1080);
  function select(index:number) { setRunning(false);onSelect(modulo(index,N)); }
  function enter() { onEnter(active,root.current?.querySelector<HTMLElement>('[data-current="true"]')??undefined); }
  function emblem(workbench:EntryWorkbench,index:number,current:boolean) {
    return <button key={workbench.id} className="architect-emblem" data-current={current} data-workbench={workbench.id} aria-label={`${workbench.code} / ${workbench.title}${current?'，进入工作台':'，选择工作台'}`} aria-pressed={current} onClick={event=>{
      setRunning(false);if(current)onEnter(workbench,event.currentTarget);else onSelect(index);
    }}><Logo key={`${workbench.id}:${current}`} workbench={workbench} still={reduced||!current} startAt={.4}/></button>;
  }
  return <section ref={root} className={`architect-chooser architect-${design}`} data-moving={moving} data-reduced={reduced} inert={locked} aria-label={`${labels[design]} 工作台选择`} onKeyDown={event=>{
    if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopPropagation();select(selected+(event.key==='ArrowLeft'?-1:1));}
  }} onPointerMove={event=>{
    if(reduced||!camera.current)return;
    const r=event.currentTarget.getBoundingClientRect();const x=(event.clientX-r.left)/r.width-.5;const y=(event.clientY-r.top)/r.height-.5;
    camera.current.style.setProperty('--look-x',`${x*4}deg`);camera.current.style.setProperty('--look-y',`${-y*3}deg`);
  }} onPointerLeave={()=>{camera.current?.style.setProperty('--look-x','0deg');camera.current?.style.setProperty('--look-y','0deg');}}>
    <div className="architect-scene" aria-hidden={locked}>
      <div className="architect-canvas" style={{transform:`translate(-50%,-50%) scale(${scale})`}}>
        <div ref={camera} className="architect-camera"><div className="architect-drift">
          {design==='matrix'&&<div className="architect-matrix-world" style={{'--focus-x':`${-(selected-3)*408}px`} as CSSProperties}>{tiles.map(({column,row,index})=>{
            const current=column===selected-3&&row===0;const workbench=entryWorkbenches[modulo(column+row+3,N)];
            return <div className="architect-matrix-site" key={index} style={{'--tile-x':`${column*408}px`,'--tile-y':`${row*408}px`} as CSSProperties}>
              <div className="architect-slab" data-lifted={current}><div className="architect-slab-face">
                {current?emblem(active,selected,true):<img src={images[entryWorkbenches.indexOf(workbench)].relief} alt="" draggable={false}/>}
              </div><div className="architect-slab-edge"/><div className="architect-slab-side"/></div>
            </div>;
          })}</div>}
          {design==='glass'&&<div className="architect-glass-world">{entryWorkbenches.map((workbench,index)=>{
            const distance=modulo(index-selected+3,N)-3;const far=Math.abs(distance);
            const style={'--glass-x':`${distance*475}px`,'--glass-z':`${-far*180}px`,'--glass-y':`${far*15}px`,'--glass-angle':`${distance===0?-9:distance<0?25:-25}deg`,'--glass-opacity':`${distance===0?1:.62-far*.12}`} as CSSProperties;
            return <div className="architect-glass-pane" style={style} data-current-pane={distance===0} key={workbench.id}><div className="architect-glass-sheen"/>{emblem(workbench,index,distance===0)}<span className="architect-glass-etch" aria-hidden="true">{workbench.code} / {workbench.english}</span><i/></div>;
          })}</div>}
          {design==='axis'&&<div className="architect-axis-world">{entryWorkbenches.map((workbench,index)=>{
            const distance=modulo(index-selected+3,N)-3;const far=Math.abs(distance);
            const style={'--axis-x':`${distance===0?-240:distance*630-100}px`,'--axis-y':`${distance===0?0:-far*30}px`,'--axis-z':`${-far*520}px`,'--axis-angle':`${-distance*12}deg`,'--axis-opacity':`${distance===0?1:.55-far*.1}`} as CSSProperties;
            return <div className="architect-axis-station" key={workbench.id} style={style}>{emblem(workbench,index,distance===0)}<img className="architect-axis-reflection" src={images[index].held} alt="" draggable={false}/><span aria-hidden="true">{workbench.code}</span></div>;
          })}<div className="architect-axis-floor"/></div>}
        </div></div>
      </div>
      <div className="architect-atmosphere"/>
    </div>
    <header className="architect-brand"><strong>RHINE LAB</strong><span>SYNTHESIZE INFORMATION</span><div>WORKBENCH <b>OS</b></div></header>
    <div className="architect-series">{labels[design]}<span>PERSONAL AI STUDIO / {countLabel}</span></div>
    <div className="architect-caption" key={active.id}><span>{active.english} / {active.code}</span><h1>{active.title}</h1><p>{active.description}</p><button onClick={enter}>ACCESS STUDIO<ArrowRight size={19}/><small>进入工作台</small></button></div>
    <nav className="architect-register" aria-label="快速选择工作台">{entryWorkbenches.map((workbench,index)=><button key={workbench.id} aria-pressed={index===selected} onClick={()=>select(index)}><span>{workbench.code}</span><b>{shortNames[index]}</b><i/></button>)}</nav>
    <div className="architect-position"><span>DEPARTMENT SELECT</span><b>{active.code}</b><i>/</i><small>{countLabel}</small><button aria-label="上一个工作台" onClick={()=>select(selected-1)}><ChevronLeft size={17}/></button><button aria-label="下一个工作台" onClick={()=>select(selected+1)}><ChevronRight size={17}/></button></div>
    <button className="architect-motion" disabled={reduced} aria-pressed={running} onClick={()=>setRunning(value=>!value)}>{running&&!reduced?<Pause size={11}/>:<Play size={11}/>}<span>{reduced?'静态浏览':running?'暂停巡览':'播放巡览'}</span></button>
  </section>;
}
