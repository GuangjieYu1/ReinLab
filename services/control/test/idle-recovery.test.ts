import {it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
it('D-1服务端已终止但池尚未收到通知时，首次业务回调之前更换失效连接',async()=>{
 const account=randomUUID(),admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL??'postgres://postgres@127.0.0.1:55432/reinlab_test'});
 await admin.query('insert into account(id) values($1)',[account]);
 const child=spawn(process.execPath,['--import','tsx','services/control/test/fixtures/idle-recovery.ts'],{env:{...process.env,TEST_ACCOUNT_ID:account},stdio:['pipe','pipe','pipe']});
 let stderr='',oldPid:number|undefined,recovered:{pid:number;account:string;workCount:number}|undefined;
 child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-12000);});
 try {
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('IDLE_FIXTURE_TIMEOUT')),10000);let pending='';
   child.once('error',reject);
   child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('IDLE_FIXTURE_FAILED '+stderr));});
   child.stdout.on('data',chunk=>{pending+=String(chunk);let end;while((end=pending.indexOf('\n'))!==-1){const line=pending.slice(0,end);pending=pending.slice(end+1);const value=JSON.parse(line);if(value.code==='IDLE_READY'){oldPid=value.pid;void admin.query('select pg_terminate_backend($1) stopped',[oldPid]).then(r=>{expect(r.rows[0].stopped).toBe(true);child.stdin.write('continue\n');},reject);}if(value.code==='IDLE_RECOVERED')recovered=value;}});
  });
  expect(recovered?.pid).not.toBe(oldPid);expect(recovered).toMatchObject({account,workCount:1});
 }finally{if(child.exitCode===null&&child.signalCode===null){const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGTERM');await exit;}await admin.end();}
},15000);
