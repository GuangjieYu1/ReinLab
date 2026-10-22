// Disposable network-isolated Linux probe; fixture credentials are created only in container memory.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const image = process.argv[2] ?? "reinlab-account:p1-08";
const source = String.raw`
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,symlink,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {bootstrapMcp,removeMcp,accountFiles} from '/services/account-runtime/mcp/store.mjs';
const checks=[];
let server;
try {
 const root='/data', dossier=randomUUID(), runId=randomUUID(), dir=root+'/dossiers/'+dossier;
 await mkdir(dir+'/findings',{recursive:true});
 await writeFile(dir+'/findings/a.md','旧版本');
 const call=(operation,args)=>accountFiles(root,{dossier,operation,args,writeTargets:['findings/']});
 const written=await call('patch',{changes:[{path:'findings/a.md',content:'新版本🙂'},{path:'findings/b.md',content:'第二文件'}]});
 assert.equal(await readFile(dir+'/findings/a.md','utf8'),'新版本🙂');
 assert.equal(await readFile(dir+'/findings/b.md','utf8'),'第二文件');
 await call('undo',{versionId:written.versionId});
 assert.equal(await readFile(dir+'/findings/a.md','utf8'),'旧版本');
 await assert.rejects(stat(dir+'/findings/b.md'));
 checks.push('linux-atomic-patch-unicode-and-undo');
 await assert.rejects(call('patch',{changes:[{path:'findings/a.md',content:'partial'},{path:'outside.md',content:'no'}]}));
 assert.equal(await readFile(dir+'/findings/a.md','utf8'),'旧版本');
 await symlink('/etc',dir+'/findings/link');
 await assert.rejects(call('read',{path:'findings/link/passwd'}));
 await rm(dir+'/findings/link');
 checks.push('linux-scope-and-symlink-denials-no-partial-write');
 // This unregistered fixture token is never capable of authorizing a real run.
 const token='fixture.'+Buffer.from(JSON.stringify({run:runId,exp:Math.floor(Date.now()/1000)+60})).toString('base64url')+'.'+randomBytes(32).toString('base64url');
 server=createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);assert.equal(req.url,'/mcp/memory');let text='';req.on('data',b=>text+=b);req.on('end',()=>{const input=JSON.parse(text);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{tools:[]}}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const controlUrl='http://127.0.0.1:'+server.address().port+'/';
 await bootstrapMcp(root,{runId,token,controlUrl},controlUrl);
 const file=root+'/mcp-clients/'+runId+'.json';
 assert.equal((await stat(file)).mode&0o077,0);assert.equal((await stat(root+'/mcp-clients')).mode&0o077,0);
 assert.equal(Object.values(process.env).some(v=>v.includes(token)),false);
 const child=spawn('node',['/services/account-runtime/mcp/client.mjs',file,'memory'],{env:{PATH:'/usr/local/bin:/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('stdio')));});
 child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n');
 await done;assert.equal(err,'');assert.equal(out.includes(token),false);assert.deepEqual(JSON.parse(out).result,{tools:[]});
 await removeMcp(root,runId);await assert.rejects(stat(file));
 checks.push('linux-private-config-stdio-proxy-and-terminal-cleanup');
 await import('/opt/reinlab/plugin/index.js');await import('/opt/reinlab/plugin/mcp-tools.js');
 checks.push('locked-plugin-runtime-imports');
 console.log(JSON.stringify({status:'passed',passed:checks.length,failed:0,checks,modelCalls:0,network:'none; container loopback fixture only'}));
} catch { console.log(JSON.stringify({status:'failed',passed:checks.length,failed:1,checks,code:'MCP_CONTAINER_VERIFY_FAILED',modelCalls:0}));process.exitCode=1; }
finally {if(server)await new Promise(resolve=>server.close(resolve));}
`;
try {
  const child = spawn("docker", ["run", "--rm", "-i", "--network", "none", "--user", "1000:1000", "--tmpfs", "/data:rw,uid=1000,gid=1000,mode=0700", "--entrypoint", "node", image, "--input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", b => { stdout += b; });
  child.stderr.resume(); // Never forward runtime exceptions containing request/config data.
  const timer = setTimeout(() => child.kill(), 90000);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject); child.on("close", resolve); child.stdin.on("error", () => {}); child.stdin.end(source);
  }).finally(() => clearTimeout(timer));
  const report = JSON.parse(stdout);
  if (code !== 0 || report.status !== "passed") throw Error();
  await writeFile("mcp-container-test-report.json", JSON.stringify({ ...report, image }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, failed: 0 }));
} catch {
  await writeFile("mcp-container-test-report.json", JSON.stringify({ status: "failed", code: "MCP_CONTAINER_VERIFY_FAILED", failed: 1, modelCalls: 0 }) + "\n");
  console.error("MCP_CONTAINER_VERIFY_FAILED"); process.exitCode = 1;
}
