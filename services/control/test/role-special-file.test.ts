import {it,expect} from 'vitest';
import {mkdtemp,realpath,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';
import {prepareRoleProject,assertRoleProject} from '../src/bridge/openscience/role-project';
import {ReinLabPlugin} from '../../../plugins/reinlab-os-plugin/index.js';
it('FIFO数据和管理文件均失败关闭，不能在open上永久阻塞',async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'reinlab-role-fifo-')));
 let fifo='';
 try{
  const project=await prepareRoleProject({root,dossierId:randomUUID(),role:{id:'fifo-reader',prompt:'测试角色',toolGrants:{read:{risk:'read',permission:'allow'}},writeTargets:[],steps:4},model:'account/medium',memory:'受控说明',pluginUrl:pathToFileURL(path.resolve('plugins/reinlab-os-plugin/index.js')).href});
  const hooks=await ReinLabPlugin({directory:project.directory});for(const tool of ['constructor','toString','valueOf'])await expect(hooks['tool.execute.before']!({tool},{args:{}})).rejects.toThrow('SCOPE_DENIED');fifo=path.join(project.dossierDirectory,'pipe');await promisify(execFile)('mkfifo',[fifo]);
  const request=hooks['tool.execute.before']!({tool:'read'},{args:{filePath:fifo}}).then(()=>false,()=>true);
  const result=await Promise.race([request,new Promise(resolve=>setTimeout(()=>resolve('blocked'),600))]);
  if(result==='blocked'){const writer=await open(fifo,constants.O_WRONLY|constants.O_NONBLOCK);await writer.close();}
  expect(result).toBe(true);
  fifo=path.join(project.directory,'AGENTS.md');await rm(fifo);await promisify(execFile)('mkfifo',[fifo]);
  const checked=assertRoleProject(project).then(()=>false,()=>true);
  const check=await Promise.race([checked,new Promise(resolve=>setTimeout(()=>resolve('blocked'),600))]);
  if(check==='blocked'){const writer=await open(fifo,constants.O_WRONLY|constants.O_NONBLOCK);await writer.close();}
  expect(check).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
},5000);
