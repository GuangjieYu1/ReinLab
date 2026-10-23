import { runtimeConfiguration } from "../src/configuration";
const config = runtimeConfiguration();
import pg from 'pg';
import {Database} from '../src/db/database';
import {provisionerFromEnvironment} from '../src/provisioner';
const id=process.argv[2];
if(!id||!config.DATABASE_URL_APP)throw new Error('CONFIG_MISSING: 需要账户UUID及应用连接');
const pool=new pg.Pool({connectionString:config.DATABASE_URL_APP,max:5});
try{const db=new Database(pool);await db.assertSafeRole();const result=await provisionerFromEnvironment(db).ensure(id);console.log(JSON.stringify({code:'ACCOUNT_PROVISIONED',state:result.state}));}
catch(e){console.error(JSON.stringify({code:e instanceof Error&&'code' in e?e.code:'PROVISIONER_FAILED'}));process.exitCode=1;}
finally{await pool.end();}
