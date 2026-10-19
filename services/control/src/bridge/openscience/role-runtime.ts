import {createOpenScienceClient} from '@synsci/sdk/v2';
import {z} from 'zod';
import {assertRoleProject,roleFilesystemGrants,requiredRolePlugin,scopeDenied,type RoleProject} from './role-project';
const Input=z.object({sessionID:z.string().min(1),requestID:z.string().min(1).max(200).refine(v=>v===v.trim()),message:z.string().min(1).max(1000000).refine(v=>v.trim().length>0)}).strict();
type Reply<T>={data?:T;error?:unknown;response?:Response};
const unavailable=()=>Object.assign(new Error('账户执行内核暂时不可用；请按原请求编号检查收据。'),{code:'OS_UNAVAILABLE',status:503});
export class RoleRuntime {
 private readonly client;private readonly sessions=new Set<string>();private readonly timeoutMs:number;private readonly delegation:boolean;
 constructor(private readonly options:{baseUrl:string;token:string;project:RoleProject;timeoutMs?:number;testOnlyDelegation?:boolean}) {
  this.options=Object.freeze({...options});
  this.delegation=options.testOnlyDelegation===true;if(this.delegation&&process.env.NODE_ENV!=='test')throw scopeDenied();
  const url=new URL(options.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||options.token.length<32)throw scopeDenied();
  this.timeoutMs=options.timeoutMs??10000;if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<100||this.timeoutMs>30000)throw scopeDenied();
  this.client=createOpenScienceClient({baseUrl:url.origin,directory:options.project.directory,headers:{Authorization:'Bearer '+options.token}});
 }
 private async bound(sessionID?:string){await assertRoleProject(this.options.project);if(sessionID&&!this.sessions.has(sessionID))throw scopeDenied();}
 private async call<T>(work:(options:{signal:AbortSignal})=>Promise<Reply<T>>):Promise<T>{
  try {const result=await work({signal:AbortSignal.timeout(this.timeoutMs)});if(result.error||!result.data){if(result.response?.status===409)throw Object.assign(new Error('同一请求编号存在冲突。'),{code:'IDEMPOTENCY_CONFLICT',status:409});throw unavailable();}return result.data;}
  catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='IDEMPOTENCY_CONFLICT')throw error;throw unavailable();}
 }
 private async requirePlugin(){const required=await requiredRolePlugin(this.options.project);const config=await this.call(options=>this.client.global.config.get(options));if(!config.plugin?.includes(required))throw scopeDenied();}
 async createSession(title='研究角色会话') {
  await this.bound();await this.requirePlugin();const session=await this.call(options=>this.client.session.create({directory:this.options.project.directory,title,workspace:'project'},options));
  for(const grant of await roleFilesystemGrants(this.options.project))await this.call(options=>this.client.session.filesystem.grant({directory:this.options.project.directory,sessionID:session.id,...grant,scope:'session'},options));
  this.sessions.add(session.id);return {sessionID:session.id};
 }
 async prompt(raw:unknown) {const parsed=Input.safeParse(raw);if(!parsed.success)throw scopeDenied();const input=parsed.data;await this.bound(input.sessionID);await this.requirePlugin();return this.call(options=>this.client.runtime.prompt({...input,directory:this.options.project.directory,effort:'normal',delegation:this.delegation},options));}
 async snapshot(sessionID:string){await this.bound(sessionID);return this.call(options=>this.client.runtime.snapshot({directory:this.options.project.directory,sessionID},options));}
 async messages(sessionID:string){await this.bound(sessionID);return this.call(options=>this.client.session.messages({directory:this.options.project.directory,sessionID},options));}
 async children(sessionID:string){await this.bound(sessionID);return this.call(options=>this.client.session.children({directory:this.options.project.directory,sessionID},options));}
}
