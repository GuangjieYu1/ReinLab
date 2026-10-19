import {afterEach,expect,it,vi} from 'vitest';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareRoleProject} from '../src/bridge/openscience/role-project';
import {RoleRuntime} from '../src/bridge/openscience/role-runtime';

const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const close of cleanup.splice(0).reverse())await close();});

it.each([
 {environment:'production',initial:undefined,mutated:true,expected:false},
 {environment:'test',initial:undefined,mutated:true,expected:false},
 {environment:'test',initial:true,mutated:false,expected:true},
])('captures delegation=$expected at construction in $environment despite later options mutation',async({environment,initial,mutated,expected})=>{
 vi.stubEnv('NODE_ENV',environment);
 const root=await mkdtemp(join(tmpdir(),'reinlab-independent-d3-'));
 cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const pluginUrl=pathToFileURL(resolve('plugins/reinlab-os-plugin/index.js')).href;
 const project=await prepareRoleProject({root,dossierId:'33333333-3333-4333-8333-333333333333',role:{id:'independent-delegation',prompt:'Independent D-3 transport test',toolGrants:{},writeTargets:[],steps:8},memory:'',model:'role-fixture/fixture',pluginUrl});
 const submitted:Array<Record<string,unknown>>=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url?.startsWith('/global/config')){res.end(JSON.stringify({plugin:[pluginUrl]}));return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.url?.startsWith('/runtime/prompt')){submitted.push(JSON.parse(raw));res.end(JSON.stringify({runID:'independent_d3_run',acceptedAt:'2026-10-20T00:00:00Z'}));return;}
  res.end(JSON.stringify({id:'independent_d3_session'}));
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 cleanup.push(()=>new Promise<void>(done=>{server.closeAllConnections();server.close(()=>done());}));
 const address=server.address() as {port:number};
 const options={baseUrl:`http://127.0.0.1:${address.port}`,token:'independent-test-token-no-real-secret-1234',project,...(initial===undefined?{}:{testOnlyDelegation:initial})};
 const runtime=new RoleRuntime(options);options.testOnlyDelegation=mutated;
 const {sessionID}=await runtime.createSession();
 await runtime.prompt({sessionID,requestID:'independent-d3-stable-id',message:'capture payload'});
 expect(submitted).toHaveLength(1);expect(submitted[0].delegation).toBe(expected);expect(submitted[0].requestID).toBe('independent-d3-stable-id');
 // A request body cannot override the constructor's authority, including when false.
 for(const delegation of [true,false])await expect(runtime.prompt({sessionID,requestID:'injected-delegation',message:'injected field',delegation})).rejects.toMatchObject({code:'SCOPE_DENIED'});
 expect(submitted).toHaveLength(1);
});

it.each(['production','development','test ',undefined])('rejects explicit delegation enablement unless NODE_ENV is exactly test: %s',environment=>{
 vi.stubEnv('NODE_ENV',environment);
 expect(()=>new RoleRuntime({baseUrl:'http://127.0.0.1:1',token:'independent-test-token-no-real-secret-1234',project:{} as never,testOnlyDelegation:true})).toThrowError(expect.objectContaining({code:'SCOPE_DENIED'}));
});
