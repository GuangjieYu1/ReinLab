import { serve } from '@hono/node-server';
import pg from 'pg';
import nodeProcess from 'node:process';
import { createApp } from './api/app';
import { Database } from './db/database';
import { provisionerFromEnvironment } from './provisioner';
import { startAuthProvisioner } from './provisioner/auth-worker';

if(!process.env.DATABASE_URL_APP||!process.env.SUPABASE_URL)throw new Error('CONFIG_MISSING: 需要应用数据库连接与Supabase地址');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL_APP,max:10});
const app=await createApp({pool,auth:{issuer:process.env.SUPABASE_URL.replace(/\/$/,'')+'/auth/v1',secret:process.env.SUPABASE_JWT_SECRET?new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET):undefined}});
const stopProvisioner=process.env.DATABASE_URL_PROVISIONER
  ? await startAuthProvisioner(process.env.DATABASE_URL_PROVISIONER,provisionerFromEnvironment(new Database(pool)))
  : undefined;
const server=serve({fetch:app.fetch,port:Number(process.env.PORT??3001),hostname:'0.0.0.0'},info=>{
  console.log(JSON.stringify({code:'CONTROL_READY',port:info.port}));
  const marker=process.argv.indexOf('--instance'),instance=marker<0?undefined:process.argv[marker+1];
  if(nodeProcess.connected&&nodeProcess.send&&instance&&/^[a-f0-9-]{36}$/.test(instance))nodeProcess.send({type:'reinlab.control.ready',pid:process.pid,instance,port:info.port},()=>{});
});
const shutdown=()=>{server.close(()=>{void (async()=>{await stopProvisioner?.();await pool.end();})();});};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
