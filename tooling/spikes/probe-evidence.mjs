import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const json=value=>JSON.stringify(value,null,2)+'\n';
// 独占报告先于请求文件；失败或未知结果保留占位，绝不自动重新计费。
export async function claimGeneration(directory,{request,metadata}) {
 await mkdir(directory,{recursive:true});
 const report={...metadata,state:'claimed',callCount:0,providerCallCount:null,callCountScope:'生成HTTP请求次数；服务内部模型重试/用量未知'};
 const reportPath=join(directory,'live-generation.json');
 try {await writeFile(reportPath,json(report),{flag:'wx'});}
 catch(error){if(error.code==='EEXIST')throw Error('LIVE_PROBE_ALREADY_EXISTS');throw Error('LIVE_PROBE_CLAIM_FAILED');}
 try {await writeFile(join(directory,'request.json'),json(request),{flag:'wx'});}
 catch {report.state='failed-before-submit';await writeFile(reportPath,json(report));throw Error('LIVE_PROBE_REQUEST_WRITE_FAILED');}
 return report;
}
export async function saveGeneratedEvidence(directory,report,html) {
 try {
  report.state='saving-evidence';
  await writeFile(join(directory,'interactive.html'),html,{flag:'wx'});
  report.state='generated';
  await writeFile(join(directory,'live-generation.json'),json(report));
 } catch {
  report.state='failed-to-save';
  await writeFile(join(directory,'live-generation.json'),json(report));
  throw Error('LIVE_PROBE_SAVE_FAILED');
 }
}
