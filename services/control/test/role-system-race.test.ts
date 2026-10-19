import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
it('模型回合之间AGENTS换为另一角色链接时，实际全局hook在下一provider HTTP前拒绝',async()=>{
 await promisify(execFile)(process.execPath,['--import','tsx','services/control/test/fixtures/review-toctou.ts'],{timeout:30000,maxBuffer:65536});
 const report=JSON.parse(await readFile('evidence/P1-10/review-toctou.json','utf8'));
 expect(report.changed).toBe(true);expect(report.leaked).toBe(false);expect(report.systemSummaries.some((v:{ownMemory:boolean})=>v.ownMemory)).toBe(true);expect(report.hookLog).toContain('rejected:experimental.chat.system.transform');
},35000);
