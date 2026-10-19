import {afterEach, expect, it} from 'vitest';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimGeneration} from './probe-evidence.mjs';
const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function directory(){const path=await mkdtemp(join(tmpdir(),'reinlab-spike-claim-'));roots.push(path);return path;}
it('并发争抢只允许一个调用者取得提交资格，且不覆盖获胜请求',async()=>{
 const dir=await directory();
 const results=await Promise.allSettled(Array.from({length:40},(_,i)=>claimGeneration(dir,{request:{id:i},metadata:{realService:true}})));
 const winners=results.filter(r=>r.status==='fulfilled');expect(winners).toHaveLength(1);
 const report=JSON.parse(await readFile(join(dir,'live-generation.json'),'utf8'));
 expect(report).toMatchObject({state:'claimed',callCount:0,providerCallCount:null});expect(report.callCountScope).toContain('HTTP');
 const request=await readFile(join(dir,'request.json'),'utf8');
 await expect(claimGeneration(dir,{request:{id:'overwrite'},metadata:{}})).rejects.toThrow('LIVE_PROBE_ALREADY_EXISTS');
 expect(await readFile(join(dir,'request.json'),'utf8')).toBe(request);
});
it('请求文件写入失败时保留防重占位，并标记尚未提交',async()=>{
 const dir=await directory();await writeFile(join(dir,'request.json'),'original');
 await expect(claimGeneration(dir,{request:{},metadata:{}})).rejects.toThrow('LIVE_PROBE_REQUEST_WRITE_FAILED');
 expect(JSON.parse(await readFile(join(dir,'live-generation.json'),'utf8'))).toMatchObject({state:'failed-before-submit',callCount:0,providerCallCount:null});
 expect(await readFile(join(dir,'request.json'),'utf8')).toBe('original');
 await expect(claimGeneration(dir,{request:{},metadata:{}})).rejects.toThrow('LIVE_PROBE_ALREADY_EXISTS');
});
it('已存在报告时不能改写报告或新建请求',async()=>{
 const dir=await directory();await writeFile(join(dir,'live-generation.json'),'original-report');
 await expect(claimGeneration(dir,{request:{},metadata:{}})).rejects.toThrow('LIVE_PROBE_ALREADY_EXISTS');
 expect(await readFile(join(dir,'live-generation.json'),'utf8')).toBe('original-report');
 await expect(readFile(join(dir,'request.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('HTML不能保存时不得报告generated，保留已发生HTTP调用次数',async()=>{
 const dir=await directory();const report=await claimGeneration(dir,{request:{},metadata:{}});
 const {saveGeneratedEvidence}=await import('./probe-evidence.mjs');
 await writeFile(join(dir,'interactive.html'),'existing');report.callCount=1;
 await expect(saveGeneratedEvidence(dir,report,'new html')).rejects.toThrow('LIVE_PROBE_SAVE_FAILED');
 expect(JSON.parse(await readFile(join(dir,'live-generation.json'),'utf8'))).toMatchObject({state:'failed-to-save',callCount:1,providerCallCount:null});
 expect(await readFile(join(dir,'interactive.html'),'utf8')).toBe('existing');
});
