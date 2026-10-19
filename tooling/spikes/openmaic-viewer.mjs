import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';
const sample=await readFile('evidence/P2-01/interactive.html','utf8');
const escape=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const page='<!doctype html><html lang="zh"><meta charset="utf-8"><title>SPIKE-3 隔离交互验证</title><body style="margin:0;background:#eef0ec"><iframe title="单场景真实生成样本" sandbox="allow-scripts" referrerpolicy="no-referrer" style="display:block;width:100vw;height:100vh;border:0" srcdoc="'+escape(sample)+'"></iframe></body></html>';
const server=createServer((req,res)=>{if(req.url!=='/'){res.writeHead(404).end();return;}res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(page);});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({code:'SPIKE_VIEWER_READY',port:server.address().port})));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close());
