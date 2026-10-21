import {afterEach,expect,it} from 'vitest';
import {createServer} from 'node:http';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {prepareRoleProject} from '../src/bridge/openscience/role-project';
import {RoleRuntime} from '../src/bridge/openscience/role-runtime';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const done of cleanup.splice(0).reverse())await done();});
it.each(['alias','output','reasoning','endpoint'] as const)('B1 post-configuration %s mismatch refuses readiness and cleans temporary state',async bad=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'reinlab-b1-independent-')));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const pluginUrl=pathToFileURL(resolve('plugins/reinlab-os-plugin/index.js')).href,project=await prepareRoleProject({root,dossierId:randomUUID(),role:{id:'b1-read',prompt:'fixture',toolGrants:{},writeTargets:[],steps:1},model:'deepseek/deepseek-v4-flash',memory:'',pluginUrl});
 const original=JSON.stringify({plugin:[pluginUrl]}),requests:Array<{path:string;method:string}>=[];let configured:any,raw=original,connected=false;
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):null,path=new URL(req.url!,'http://fixture').pathname;requests.push({path,method:req.method!});res.setHeader('content-type','application/json');
 if(path==='/global/config/raw'){if(req.method==='PUT'){raw=body.content;configured=undefined;}res.end(JSON.stringify(req.method==='GET'?{content:raw,path:'/fixture/config.json'}:{plugin:[pluginUrl]}));return;}
 if(path==='/global/config'){if(req.method==='PATCH'){configured=body;raw=JSON.stringify({...body,provider:{deepseek:{...body.provider.deepseek,options:{baseURL:bad==='endpoint'?'http://unexpected.invalid/v1':body.provider.deepseek.options.baseURL}}}});}res.end(JSON.stringify({plugin:[pluginUrl]}));return;}
 if(path==='/auth/deepseek'){connected=req.method==='PUT';res.end('true');return;}
 if(path==='/provider'){res.end(JSON.stringify({connected:connected?['deepseek']:[],all:configured?[{id:'deepseek',models:{'deepseek-v4-flash':{status:'active',api:{id:bad==='alias'?'deepseek-v4-pro':'deepseek-flash'},limit:{context:1048576,output:bad==='output'?4096:1024},capabilities:{reasoning:bad==='reasoning'}}}}]:[],default:{}}));return;}
 res.writeHead(404).end('{}');});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
 const runtime=new RoleRuntime({baseUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port,token:'x'.repeat(43),project}),token=randomBytes(32).toString('base64url');
 await expect(runtime.configureSmokeGateway({origin:'http://host.docker.internal:43210',token})).rejects.toMatchObject({code:'OS_UNAVAILABLE'});
 expect(requests.filter(r=>r.path==='/auth/deepseek'&&r.method==='DELETE')).toHaveLength(1);expect(requests.filter(r=>r.path==='/global/config/raw'&&r.method==='PUT')).toHaveLength(1);expect(raw).toBe(original);expect(connected).toBe(false);expect(runtime.reader()).not.toHaveProperty('configureSmokeGateway');
});
