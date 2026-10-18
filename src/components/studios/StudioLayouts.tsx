import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, FileText, Plus, Search, X } from 'lucide-react';
import Logo from '../cinematic/WorkbenchLogo';
import ResearchLab from '../research/ResearchLab';
import WorkbenchOverviews from './WorkbenchOverviews';
import ArtifactWorkspace from './ArtifactWorkspace';
import { entryWorkbenches } from '../cinematic/entryWorkbenches';
import { studioConfig } from './studioCatalog';
import type { StudioFile, StudioId } from './worksiteModel';
import './studio-layouts.css';
import './research-home.css';
import './artifact-workspace.css';

const studios:StudioId[]=['research','engineering','creative','automation','exploration'];
const names=['研究','工程','创作','自动化','规划探索'];
type View='overview'|'workspace'|'files';
function initialStudio():StudioId{const value=new URLSearchParams(window.location.search).get('studio');return studios.includes(value as StudioId)?value as StudioId:'research';}
function initialView():View{const value=new URLSearchParams(window.location.search).get('view');return ['overview','workspace','files'].includes(value??'')?value as View:initialStudio()==='research'?'overview':'workspace';}
export default function StudioLayouts(){
  const [studio,setStudio]=useState<StudioId>(initialStudio);const [view,setView]=useState<View>(initialView);
  const [files,setFiles]=useState<Record<StudioId,StudioFile[]>>(()=>Object.fromEntries(studios.map(id=>[id,studioConfig[id].files])) as Record<StudioId,StudioFile[]>);
  const [selected,setSelected]=useState(initialStudio()==='research'?1:0);const [search,setSearch]=useState('');
  const [creating,setCreating]=useState(false);const [name,setName]=useState('');const [brief,setBrief]=useState('');
  const active=entryWorkbenches.find(item=>item.id===studio)!;const file=files[studio][selected]??files[studio][0];
  useEffect(()=>{document.title=`${active.title} · ${view==='workspace'?'工作现场':view==='overview'?'动态总览':'档案'} — ReinLab`;const url=new URL(window.location.href);url.searchParams.set('studio',studio);url.searchParams.set('view',view);window.history.replaceState(null,'',url.pathname+url.search);},[studio,view,active.title]);
  useEffect(()=>{if(!creating)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setCreating(false);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[creating]);
  function switchStudio(next:StudioId){setStudio(next);setSelected(next==='research'?1:0);setView(next==='research'?'overview':'workspace');setSearch('');}
  function open(index:number){setSelected(index);setView('workspace');}
  function create(event:FormEvent){event.preventDefault();if(!name.trim())return;const item:StudioFile={id:`${active.code}—DRAFT-${files[studio].length+1}`,title:name.trim(),brief:brief.trim()||'从一个明确的目的开始。',status:'新建草案',fresh:true};setFiles(value=>({...value,[studio]:[...value[studio],item]}));setSelected(files[studio].length);setCreating(false);setName('');setBrief('');setView('workspace');}
  return <main className={`studio-layouts studio-layouts-${studio} studio-artifacts`}>
    <header className="sl-header"><a className="sl-brand" href="/?preview=entry-compare&variant=workbenches&design=glass"><strong>RHINE LAB</strong><small>PERSONAL AI STUDIO</small></a><nav aria-label="工作台页面">{studios.map((id,index)=><button key={id} aria-pressed={studio===id} onClick={()=>switchStudio(id)}><span>0{index+2}</span>{names[index]}</button>)}</nav><a className="sl-back" href="/?preview=entry-compare&variant=workbenches&design=glass"><ArrowLeft size={13}/>返回入口</a></header>
    <section className="aw-studio-heading"><div><span>DEPARTMENT / {active.code} — {active.english}</span><h1>{active.title}</h1></div><div className="aw-view-switch" aria-label="工作台视角">{[['overview','动态总览'],['workspace','工作现场'],['files','档案']].map(([id,label])=><button key={id} aria-pressed={view===id} onClick={()=>setView(id as View)}>{label}{id==='files'&&<small>{String(files[studio].length).padStart(2,'0')}</small>}</button>)}</div><Logo key={studio} workbench={active} still={window.matchMedia('(prefers-reduced-motion: reduce)').matches}/></section>
    {view==='workspace'&&<><div className="aw-current-file"><div><span>FILE / {file.id}</span><button onClick={()=>setView('files')}>{file.title}<ChevronDown size={11}/></button><small><i/>{file.status}</small></div><button onClick={()=>{setCreating(true);setName('');setBrief('');}}><Plus size={12}/>新建档案</button></div><ArtifactWorkspace key={`${studio}:${file.id}`} studio={studio} file={file}/></>}
    {<section className="aw-overview-surface" style={{display:view==='overview'?undefined:'none'}}>{studio==='research'?<ResearchLab archiveName="模型结构对照" overview archiveCount={files.research.length} suspended={creating||view!=='overview'} reduced={window.matchMedia('(prefers-reduced-motion: reduce)').matches} onBack={()=>setView('files')} onOpenNotes={()=>open(1)}/>:<WorkbenchOverviews key={studio} studio={studio} files={files[studio]} suspended={creating||view!=='overview'} onOpenFiles={()=>setView('files')} onOpenProject={open}/>}</section>}
    {view==='files'&&<section className="aw-files-page"><header><div><span>WORKBENCH / ARCHIVES</span><h2>{studioConfig[studio].label}</h2><p>每份档案保留输入、过程与成果。从这里接续下一次工作。</p></div><button className="aw-primary" onClick={()=>{setCreating(true);setName('');setBrief('');}}><Plus size={13}/>新建档案</button></header><label className="aw-files-search"><Search size={13}/><input aria-label="筛选工作台档案" placeholder="查找档案" value={search} onChange={event=>setSearch(event.target.value)}/></label><div className="aw-file-table"><div><span>FILE / INDEX</span><span>档案与目的</span><span>当前阶段</span><span/></div>{files[studio].map((item,index)=>item.title.includes(search)&&<button key={item.id} onClick={()=>open(index)}><span><FileText size={13}/>{item.id}</span><div><h3>{item.title}</h3><p>{item.brief}</p></div><span>{item.status}</span><ArrowUpRight size={16}/></button>)}{!files[studio].some(item=>item.title.includes(search))&&<p className="aw-no-files">没有匹配的档案。</p>}</div><footer><span>DEPARTMENT / {active.code}</span><span>{files[studio].length} FILES / LOCAL WORKING ARCHIVE</span></footer></section>}
    {creating&&<div className="sl-modal-backdrop" onClick={event=>{if(event.target===event.currentTarget)setCreating(false);}}><form className="sl-modal" onSubmit={create} role="dialog" aria-modal="true" aria-label="新建工作台档案"><button type="button" className="sl-close" aria-label="关闭新建档案" onClick={()=>setCreating(false)}><X size={17}/></button><span className="sl-kicker">NEW ARCHIVE / {active.code}</span><h2>从一份新档案开始。</h2><label>档案名称<input autoFocus required value={name} onChange={event=>setName(event.target.value)} placeholder="为这次工作命名"/></label><label>目的与问题<textarea value={brief} onChange={event=>setBrief(event.target.value)} placeholder="这次希望完成什么？"/></label><p>新档案仅在本次预览内保存。</p><div><button type="button" onClick={()=>setCreating(false)}>取消</button><button type="submit">建立档案<ArrowRight size={14}/></button></div></form></div>}
  </main>;
}
