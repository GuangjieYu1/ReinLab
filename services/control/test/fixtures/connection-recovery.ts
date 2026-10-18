import pg from 'pg';
import { once } from 'node:events';
import { Database } from '../../src/db/database';

const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL_APP??'postgres://reinlab_app@127.0.0.1:55432/reinlab_test'});
const database=new Database(pool),account=process.env.TEST_ACCOUNT_ID??'';
await database.assertSafeRole();
try {
  await database.withAccount(account,async client=>{
    const result=await client.query('select pg_backend_pid() pid');
    console.log(JSON.stringify({code:'BORROWED',pid:result.rows[0].pid}));
    await once(process.stdin,'data');
    await client.query('select 1');
  });
  throw new Error('EXPECTED_DISCONNECT_MISSING');
}catch(error){if(error instanceof Error&&error.message==='EXPECTED_DISCONNECT_MISSING')throw error;}
const recovered=await database.withAccount(account,client=>client.query("select current_setting('app.account_id') account"));
console.log(JSON.stringify({code:'RECOVERED',account:recovered.rows[0].account}));
await pool.end();process.stdin.destroy();
