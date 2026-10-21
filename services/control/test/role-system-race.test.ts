import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,copyFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {testEvidenceDirectory} from './fixtures/test-evidence';

it('模型回合之间AGENTS换为另一角色链接时，实际全局hook在下一provider HTTP前拒绝',async()=>{
 // The child always writes this invocation's unique temporary report, even when
 // the parent was explicitly asked to archive evidence elsewhere.
 const reportDirectory=await testEvidenceDirectory('role-system-race-child',{});
 const reportPath=join(reportDirectory,'review-toctou.json');
 try {
  await promisify(execFile)(process.execPath,['--import','tsx','services/control/test/fixtures/review-toctou.ts'],{env:{...process.env,REINLAB_EVIDENCE_OUT:reportDirectory},timeout:30000,maxBuffer:65536});
  const report=JSON.parse(await readFile(reportPath,'utf8'));
  expect(report.changed).toBe(true);expect(report.leaked).toBe(false);expect(report.systemSummaries.some((v:{ownMemory:boolean})=>v.ownMemory)).toBe(true);expect(report.hookLog).toContain('rejected:experimental.chat.system.transform');
  if(process.env.REINLAB_EVIDENCE_OUT?.trim())await copyFile(reportPath,join(await testEvidenceDirectory('role-system-race'),'review-toctou.json'));
 }finally{await rm(reportDirectory,{recursive:true,force:true});}
},35000);
