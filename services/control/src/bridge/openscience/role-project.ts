import {z} from 'zod';
import path from 'node:path';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const Action=z.enum(['allow','ask','deny']);
const Role=z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),prompt:z.string().min(1).max(32768),toolGrants:z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),z.object({risk:z.enum(['read','write','danger']),permission:Action}).strict()),writeTargets:z.array(z.string()).max(64),steps:z.number().int().min(1).max(512)}).strict();
const Options=z.object({root:z.string(),dossierId:z.string().uuid(),role:Role,model:z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+$/),memory:z.string().max(131072),pluginUrl:z.string().url()}).strict();
export type RoleProject=Readonly<{directory:string;dossierDirectory:string;roleId:string}>;
const issued=new WeakMap<RoleProject,{files:Record<string,string>;root:string;pluginUrl:string;grants:Array<{path:string;access:'read'|'write'}>}>();
const digest=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
export const scopeDenied=()=>Object.assign(new Error('角色工作区或请求超出已授权范围。'),{code:'SCOPE_DENIED',status:403});
async function onlyManaged(dir:string){if((await readdir(dir)).some(name=>!['openscience.json','AGENTS.md','.role-policy.json'].includes(name)))throw scopeDenied();}
async function plainDirectory(dir:string){const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink())throw scopeDenied();}
async function directory(parent:string,name:string){const dir=path.join(parent,name);await plainDirectory(parent);try{await mkdir(dir,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}await plainDirectory(dir);return dir;}
async function noGit(dir:string){for(let p=dir;;p=path.dirname(p)){try{await lstat(path.join(p,'.git'));throw scopeDenied();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(p===path.dirname(p))break;}}
async function bytes(file:string){const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.size>262144)throw scopeDenied();return await h.readFile();}finally{await h.close();}}
async function managed(file:string,text:string){try{const h=await open(file,'wx',0o600);try{await h.writeFile(text);}finally{await h.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}if(digest(await bytes(file))!==digest(text))throw scopeDenied();}
async function grantPath(root:string,target:string){for(let current=root,parts=path.relative(root,target).split(path.sep),i=0;i<parts.length;i++){current=path.join(current,parts[i]);try{const s=await lstat(current);if(s.isSymbolicLink()||(i<parts.length-1&&!s.isDirectory()))throw scopeDenied();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}}}
export async function requiredRolePlugin(project:RoleProject){await assertRoleProject(project);return issued.get(project)!.pluginUrl;}
export async function roleFilesystemGrants(project:RoleProject){await assertRoleProject(project);return issued.get(project)!.grants.map(grant=>({...grant}));}
export async function assertRoleProject(project:RoleProject):Promise<void>{
 const state=issued.get(project);if(!state)throw scopeDenied();
 try{await onlyManaged(project.directory);await noGit(project.directory);for(let dir=project.directory;;dir=path.dirname(dir)){await plainDirectory(dir);if(dir===state.root)break;if(!dir.startsWith(state.root+path.sep))throw scopeDenied();}await plainDirectory(project.dossierDirectory);if(await realpath(project.dossierDirectory)!==project.dossierDirectory)throw scopeDenied();for(const grant of state.grants)await grantPath(project.dossierDirectory,grant.path);for(const [name,hash]of Object.entries(state.files))if(digest(await bytes(path.join(project.directory,name)))!==hash)throw scopeDenied();}
 catch{throw scopeDenied();}
}
export async function prepareRoleProject(raw:unknown):Promise<RoleProject>{
 try{
  const input=Options.parse(raw);if(!path.isAbsolute(input.root))throw scopeDenied();await plainDirectory(input.root);const root=await realpath(input.root);await noGit(root);
  const plugin=new URL(input.pluginUrl);if(plugin.protocol!=='file:'||plugin.search||plugin.hash)throw scopeDenied();
  for(const target of input.role.writeTargets){const clean=target.replace(/\/$/,'');if(!/^[a-zA-Z0-9_./-]+$/.test(clean)||path.isAbsolute(clean)||clean.split('/').some(p=>!p||p==='.'||p==='..'||['.git','AGENTS.md','CLAUDE.md','CONTEXT.md','openscience.json'].includes(p)))throw scopeDenied();}
  const dossiers=await directory(root,'dossiers'),dossierDirectory=await directory(dossiers,input.dossierId);
  const roles=await directory(root,'roles'),roleDossier=await directory(roles,input.dossierId),dir=await directory(roleDossier,input.role.id);await noGit(dir);await onlyManaged(dir);
  const permission:Record<string,string|Record<string,string>>={'*':'deny'};
  const tools:Record<string,{risk:string;permission:string}>={};
  const editors=['edit','write','patch','apply_patch','multiedit'];let editAction='deny';
  for(const [name,grant]of Object.entries(input.role.toolGrants)){
   const action=grant.risk==='danger'||name==='task'?'deny':grant.permission;tools[name]={...grant,permission:action};
   if(editors.includes(name)){if(action==='allow'||action==='ask'&&editAction==='deny')editAction=action;continue;}
   permission[name]=action;
  }
  if(input.role.toolGrants.read&&tools.read.permission!=='deny')permission.read={'*':'deny',[path.join(dir,'AGENTS.md')]:tools.read.permission,[dossierDirectory+'/*']:tools.read.permission};
  permission.edit={'*':'deny',...Object.fromEntries(input.role.writeTargets.map(t=>[path.relative(dir,path.join(dossierDirectory,t))+(t.endsWith('/')?'/*':''),editAction]))};
  permission.external_directory={'*':'deny',[dossierDirectory+'/*']:'allow'};
  permission.task='deny';
  const config=JSON.stringify({default_agent:'research',agent:{research:{description:'ReinLab '+input.role.id,mode:'primary',prompt:input.role.prompt,model:input.model,steps:input.role.steps,permission}}},null,2)+'\n';
  if(/\{(?:file|env):/i.test(config))throw scopeDenied();
  const memory='# ReinLab / '+input.role.id+'\n\n'+input.memory+'\n';
  const policy=JSON.stringify({schemaVersion:1,requiredPluginUrl:input.pluginUrl,roleId:input.role.id,directory:dir,dossierDirectory,tools,writeTargets:input.role.writeTargets,configSha256:digest(config),memorySha256:digest(memory)},null,2)+'\n';
  const content={'openscience.json':config,'AGENTS.md':memory,'.role-policy.json':policy};
  for(const [name,text]of Object.entries(content))await managed(path.join(dir,name),text);
  const project=Object.freeze({directory:dir,dossierDirectory,roleId:input.role.id});issued.set(project,{root,pluginUrl:input.pluginUrl,grants:[{path:dossierDirectory,access:'read'},...(editAction==='deny'?[]:input.role.writeTargets.map(t=>({path:path.resolve(dossierDirectory,t),access:'write' as const})))],files:Object.fromEntries(Object.entries(content).map(([name,text])=>[name,digest(text)]))});await assertRoleProject(project);return project;
 }catch{throw scopeDenied();}
}
