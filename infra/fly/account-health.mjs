import {request} from 'node:http';
const r=request({host:'::1',port:4096,path:'/global/health',headers:{authorization:'Bearer '+process.env.OPENSCIENCE_AUTH_TOKEN}},res=>{res.resume();process.exitCode=res.statusCode===200?0:1;});r.setTimeout(4000,()=>{r.destroy();process.exitCode=1;});r.on('error',()=>{process.exitCode=1;});r.end();
