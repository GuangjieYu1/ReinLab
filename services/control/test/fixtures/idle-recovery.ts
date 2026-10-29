import pg from 'pg';
import { once } from 'node:events';
import { Database } from '../../src/db/database';
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test',max:1});
const database=new Database(pool),account=process.env.TEST_ACCOUNT_ID??'';
let workCount=0;
try {
 await database.assertSafeRole();
 const client=await pool.connect();
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid;
 // 仅测试：冻结此专属连接的入站通知，确定性复现旧idle client被重新借出。
 const stream=(client as unknown as {connection:{stream:{pause():void;resume():void}}}).connection.stream;
 stream.pause();client.release();
 console.log(JSON.stringify({code:'IDLE_READY',pid}));
 await once(process.stdin,'data');
 setImmediate(()=>stream.resume());
 const recovered=await database.withAccount(account,async c=>{workCount++;return (await c.query("select pg_backend_pid() pid,current_setting('app.account_id') account")).rows[0];});
 console.log(JSON.stringify({code:'IDLE_RECOVERED',pid:recovered.pid,account:recovered.account,workCount}));
} catch(error) {
 const code=error!==null&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^[A-Z0-9]{5}$/.test(error.code)?error.code:null;
 console.error(JSON.stringify({code:'IDLE_RECOVERY_FAILED',sqlState:code,workCount}));process.exitCode=1;
} finally {await pool.end();process.stdin.destroy();}
