import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react';
import ArchiveField, { type ArchiveFieldHandle } from './ArchiveField';
import Logo from './WorkbenchLogo';
import { countLabel, entryWorkbenches, modulo, WORKBENCH_COUNT as N, type EntryWorkbench } from './entryWorkbenches';
import { FILM_END } from './timeline';
import './file-workbenches.css';

type Props={design:'glass'|'axis';selected:number;reduced:boolean;locked:boolean;onSelect:(index:number)=>void;onEnter:(workbench:EntryWorkbench,source?:HTMLElement)=>void};
const shortNames=['课程','研究','工程','创作','自动化','规划探索','数据'];

export default function FileWorkbenchChooser({design,selected,reduced,locked,onSelect,onEnter}:Props){
  const root=useRef<HTMLElement>(null);const field=useRef<ArchiveFieldHandle>(null);
  const [running,setRunning]=useState(!reduced);const [extracted,setExtracted]=useState(reduced);
  const [replay,setReplay]=useState(0);const [size,setSize]=useState({width:1280,height:800});
  const phase=useRef(extracted);phase.current=extracted;
  const active=entryWorkbenches[selected];
  const moving=running&&!locked&&!reduced;
  const portrait=size.width<700;
  const scale=portrait?Math.max(size.width/1920,size.height/1080)*.72:Math.min(size.width/1920,size.height/1080);
  const cell=useMemo(()=>({lane:1,row:12+selected}),[selected]);
  const content=useMemo(()=>({title:'莱茵生命工作台',english:active.english,nameFor:(cell:{row:number})=>entryWorkbenches[modulo(cell.row-12,N)].title}),[active]);
  useEffect(()=>{
    const element=root.current;if(!element)return;
    const observer=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(element);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    setReplay(0);setExtracted(reduced);if(reduced||design==='axis')return;
    const timer=setTimeout(()=>setExtracted(true),850);return()=>clearTimeout(timer);
  },[selected,design,reduced]);
  useEffect(()=>{
    if(!moving)return;
    const timer=setInterval(()=>onSelect(modulo(selected+1,N)),9200);return()=>clearInterval(timer);
  },[moving,selected,onSelect]);
  useEffect(()=>{
    let frame=0;let last:number|null=null;let elapsed=0;
    function draw(now:number){
      const delta=last===null?0:Math.min(.045,(now-last)/1000);last=now;
      if(!document.hidden){elapsed+=delta;field.current?.update({time:FILM_END,elapsed,delta,film:false,detail:design==='glass'&&phase.current,reduced,portrait,visible:true});}
      frame=requestAnimationFrame(draw);
    }
    frame=requestAnimationFrame(draw);return()=>cancelAnimationFrame(frame);
  },[design,reduced,portrait]);
  function select(index:number){setRunning(false);onSelect(modulo(index,N));}
  function enter(){onEnter(active,root.current?.querySelector<HTMLElement>(design==='axis'?'.file-workbench-mark':'.cine-cassette.selected')??undefined);}
  function replayLogo(){setReplay(value=>value+1);}
  const face=<div className="file-workbench-face" data-workbench={active.id}><span>RHINE LAB / {active.code}<small>DEPARTMENT ARCHIVE</small></span><Logo key={`${active.id}:${replay}`} workbench={active} still={reduced||design==='axis'} delay={reduced||replay>0?0:1650}/><b>{active.english}</b><i>X—{String(selected+13).padStart(3,'0')}</i></div>;
  return <section ref={root} className={`file-workbench file-workbench-${design}`} inert={locked} data-extracted={extracted} aria-label="档案空间中的动态工作台" onKeyDown={event=>{
    if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();event.stopPropagation();select(selected+(event.key==='ArrowLeft'?-1:1));}
  }}>
    <div className="file-workbench-scene"><div className="cine-fixed-stage cine-model-stage" style={{transform:`translate(-50%,-50%) scale(${scale})`}}>
      <ArchiveField ref={field} selected={cell} selectedFace={face} content={content} sharedElementSurface="both" onSelect={cell=>{
        const index=modulo(cell.row-12,N);if(index===selected)enter();else select(index);
      }}/>
    </div></div>
    <div className="file-workbench-haze"/>
    <header className="architect-brand"><strong>RHINE LAB</strong><span>SYNTHESIZE INFORMATION</span><div>WORKBENCH <b>OS</b></div></header>
    <div className="architect-series">{design==='glass'?'ARCHIVE / EXTRACTION':'ARCHIVE / TRAVERSAL'}<span>PERSONAL AI STUDIO / {countLabel}</span></div>
    {design==='axis'&&<button key={`${active.id}:${replay}`} className="file-workbench-mark" data-workbench={active.id} aria-label={`进入${active.title}`} onClick={enter}><Logo workbench={active} still={reduced} delay={reduced||replay>0?0:500}/></button>}
    <div className="file-workbench-caption" key={active.id}><span>{active.english} / {active.code}</span><h1>{active.title}</h1><p>{active.description}</p><button onClick={enter}>ACCESS STUDIO<ArrowRight size={19}/><small>进入工作台</small></button></div>
    <nav className="file-workbench-directory" aria-label="快速选择工作台">{entryWorkbenches.map((workbench,index)=><button key={workbench.id} aria-pressed={selected===index} onClick={()=>select(index)}><span>{workbench.code}</span>{shortNames[index]}<i/></button>)}</nav>
    <div className="architect-position"><span>DEPARTMENT SELECT</span><b>{active.code}</b><i>/</i><small>{countLabel}</small><button aria-label="上一个工作台" onClick={()=>select(selected-1)}><ChevronLeft size={17}/></button><button aria-label="下一个工作台" onClick={()=>select(selected+1)}><ChevronRight size={17}/></button></div>
    <div className="file-workbench-motion"><button disabled={reduced} onClick={replayLogo}><RotateCcw size={11}/>重播标识</button><button disabled={reduced} aria-pressed={running} onClick={()=>setRunning(value=>!value)}>{moving?<Pause size={11}/>:<Play size={11}/>}<span>{reduced?'静态浏览':running?'暂停巡览':'播放巡览'}</span></button></div>
  </section>;
}
