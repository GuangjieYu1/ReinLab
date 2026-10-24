import {it,expect} from 'vitest';
import{mkdtemp,rm,readFile,realpath}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{startMcpSmokeGuard}from'../../../tooling/local/mcp-smoke-guard';
const token='x'.repeat(43),body=(text:string)=>({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:1024,messages:[{role:'user',content:text}]});
it('six sequential rounds share one non-restartable authorization; no model key on disk',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'mcp-smoke-'))),marker=join(dir,'consumed');let forwards=0;
 const options={incomingToken:token,upstreamKey:'synthetic-key-fixture',markerPath:marker,testOnlyTransport:(async()=>{forwards++;return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'fixture'}}]});}) as typeof fetch};
 let guard=await startMcpSmokeGuard(options);
 const call=(value:any)=>fetch('http://127.0.0.1:'+guard.port+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(value)});
 try{
  for(let i=0;i<6;i++){const r=await call(body('round '+i));expect(r.status).toBe(200);await r.body?.cancel();}
  expect((await call(body('seventh'))).status).toBe(409);expect(forwards).toBe(6);expect(await readFile(marker,'utf8')).not.toContain('key');
  await guard.close();guard=await startMcpSmokeGuard(options);expect((await call(body('replacement'))).status).toBe(409);expect(forwards).toBe(6);
 }finally{await guard.close();await rm(dir,{recursive:true,force:true});}
});
it('missing thinking, duplicate/retry and unknown upstream result cannot forward again',async()=>{
 for(const mode of ['thinking','duplicate','upstream']){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'mcp-deny-')));let forwards=0;
  const guard=await startMcpSmokeGuard({incomingToken:token,upstreamKey:'synthetic-key',markerPath:join(dir,'consumed'),testOnlyTransport:(async()=>{forwards++;if(mode==='upstream')throw Error('synthetic unknown');return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'fixture'}}]});}) as typeof fetch});
  const call=async(value:any)=>{const r=await fetch('http://127.0.0.1:'+guard.port+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(value)});await r.body?.cancel();return r.status;};
  try{const value:any=body('first');if(mode==='thinking')delete value.thinking;expect(await call(value)).toBe(mode==='thinking'?400:mode==='upstream'?502:200);if(mode==='duplicate'){expect(await call(value)).toBe(409);expect(await call(body('after duplicate'))).toBe(409);}if(mode==='upstream')expect(await call(body('after unknown'))).toBe(409);expect(forwards).toBe(mode==='thinking'?0:1);}
  finally{await guard.close();await rm(dir,{recursive:true,force:true});}
 }
});
it('upstream cannot reflect a credential into the native client or its ledger',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'mcp-private-response-'))),secret='fixture-reflected-key-not-a-real-credential';let forwards=0;
 const guard=await startMcpSmokeGuard({incomingToken:token,upstreamKey:secret,markerPath:join(dir,'consumed'),testOnlyTransport:(async()=>{forwards++;return Response.json({error:{message:secret}});}) as typeof fetch});
 try{for(const text of ['first','later']){const r=await fetch('http://127.0.0.1:'+guard.port+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body(text))});expect(await r.text()).not.toContain(secret);expect(r.status).toBe(text==='first'?502:409);}expect(forwards).toBe(1);}
 finally{await guard.close();await rm(dir,{recursive:true,force:true});}
});
