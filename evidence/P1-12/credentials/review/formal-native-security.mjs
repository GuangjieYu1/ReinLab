import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request} from 'node:http';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=await realpath(await mkdtemp('/tmp/reinlab-formal-native-review-'));
const binary='/Users/guangjieyu/.codex/worktrees/research-foundation/ReinLab/dist/account-runtime/reinlab-openscience';
const auth=randomBytes(32).toString('base64url'),container=randomBytes(32).toString('base64url'),accountId=randomUUID();
let child,logs='',passed=false;
try{
 for(const name of ['home','config','data','cache','state','credentials'])await mkdir(root+'/'+name,{mode:0o700});
 const credentialFile=root+'/credentials/account.json';
 await writeFile(credentialFile,JSON.stringify({schema:'account_credentials@1',accountId,auth,container}),{mode:0o600});
 const plugin=root+'/probe.mjs',resultFile=root+'/plugin-result.json';
 await writeFile(plugin,`import{writeFile}from'node:fs/promises';export default async({client})=>{const r=await client._client.get({url:"/global/health"});await writeFile(${JSON.stringify(resultFile)},JSON.stringify({internalSdkHealth:r.response?.status===200&&r.data?.healthy===true,credentialNamedEnvAbsent:!Object.keys(process.env).some(k=>/(?:_TOKEN|_SECRET|_PASSWORD|_KEY)$|^DATABASE_URL/.test(k))}));return {}};`,{mode:0o600});
 await writeFile(root+'/config/openscience.json',JSON.stringify({autoupdate:false,plugin:[pathToFileURL(plugin).href],enabled_providers:[]}),{mode:0o600});
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const env={PATH:'/usr/bin:/bin',HOME:root+'/home',XDG_CONFIG_HOME:root+'/config',XDG_DATA_HOME:root+'/data',XDG_CACHE_HOME:root+'/cache',XDG_STATE_HOME:root+'/state',OPENSCIENCE_CONFIG_DIR:root+'/config',REINLAB_ACCOUNT_CREDENTIAL_FILE:credentialFile,REINLAB_ACCOUNT_ID:accountId};
 for(const flag of ['DEFAULT_PLUGINS','AUTOUPDATE','MODELS_FETCH','CLAUDE_CODE','BUNDLED_SKILLS','LSP_DOWNLOAD','AUTOCOMPACT'])env['OPENSCIENCE_DISABLE_'+flag]='1';
 env.OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER='1';
 child=spawn(binary,['serve','--port',String(port),'--format','json'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('FORMAL_START_TIMEOUT')),15000);child.on('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('FORMAL_EARLY_EXIT'));});child.stderr.on('data',b=>logs+=b);let stdout='';child.stdout.on('data',b=>{logs+=b;stdout+=b;for(const line of stdout.split('\n'))try{if(JSON.parse(line).type==='server.ready'){clearTimeout(timer);resolve();}}catch{}});});
 const query=(headers={},path='/global/health')=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,headers},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.setTimeout(8000,()=>req.destroy(Error('FORMAL_REQUEST_TIMEOUT')));req.end();});
 const first=await query(),bad=await query({authorization:'Bearer synthetic-wrong'}),forged=await query({'x-openscience-internal':'synthetic-forged'});
 const authorized={authorization:'Bearer '+auth};
 const health=await query(authorized),host=await query({...authorized,host:'synthetic.invalid'}),origin=await query({...authorized,origin:'https://synthetic.invalid'}),site=await query({...authorized,'sec-fetch-site':'cross-site'}),forgedHost=await query({...authorized,host:'synthetic.invalid','x-openscience-internal':'synthetic-forged'});
 const pluginRequest=await query({...authorized,'x-openscience-directory':root},'/session');
 let pluginResult={};try{pluginResult=JSON.parse(await readFile(resultFile,'utf8'));}catch{}
 const checks={firstRequest401:first.status===401,wrong401:bad.status===401,forged401:forged.status===401,originalHealth:health.status===200&&JSON.parse(health.body).version==='2.0.150',host403:host.status===403,origin403:origin.status===403,crossSite403:site.status===403,forgedInternalHost403:forgedHost.status===403,pluginRequestSucceeded:pluginRequest.status===200,pluginInternalSdkHealth:pluginResult.internalSdkHealth===true,pluginCredentialNamedEnvAbsent:pluginResult.credentialNamedEnvAbsent===true,parentEnvNoCredentials:Object.values(env).every(v=>!v.includes(auth)&&!v.includes(container)),logsNoCredentials:!logs.includes(auth)&&!logs.includes(container)};
 passed=Object.values(checks).every(Boolean);
 console.log(JSON.stringify({formalBinary:true,syntheticOnly:true,realModelCalls:0,checks,passed,fixtureDiagnosis:{pluginStatus:pluginRequest.status,knownMarkers:Object.fromEntries(['undefined','Bun','fetch','global','health','function','which','split','vfs','default','get','set','argv','text','writeFile','path','cwd','realpath'].map(k=>[k,pluginRequest.body.includes(k)]))}}));
 if(!passed)process.exitCode=1;
}catch{console.log(JSON.stringify({code:'FORMAL_NATIVE_REVIEW_FAILED',secretLogsPrinted:false}));process.exitCode=1;}
finally{if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);}await rm(root,{recursive:true,force:true});}
