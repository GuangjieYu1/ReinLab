import { runtimeConfiguration } from "../src/configuration";
const config = runtimeConfiguration();
import pg from 'pg';
import {z} from 'zod';
import {Database} from '../src/db/database';
import {lifecycleFromEnvironment} from '../src/provisioner/lifecycle';
import {provisionerFromEnvironment} from '../src/provisioner';
let pool:pg.Pool|undefined;
try{
 const [command,id,value,mode,operation]=process.argv.slice(2);z.string().uuid().parse(id);
 if(!config.DATABASE_URL_APP)throw Error();
 pool=new pg.Pool({connectionString:config.DATABASE_URL_APP,max:3});const db=new Database(pool);await db.assertSafeRole();const service=lifecycleFromEnvironment(db);
 let result:{code:string};
 if(command==='snapshot')result=await service.snapshot(id,value);
 else if(command==='migrate-credentials')result=await service.migrateCredentials(id,value,mode as 'wait'|'interrupt',operation);
 else if(command==='upgrade')result=await service.upgrade(id,value,mode as 'wait'|'interrupt',operation);
 else if(command==='reconcile')result=await service.reconcileRuntime(id,value);
 else if(command==='registered'){await service.registered({source:'supabase-auth',accountId:id},provisionerFromEnvironment(db));result={code:'ACCOUNT_PROVISIONED'};}
 else throw Error();
 console.log(JSON.stringify({code:result.code}));
}catch(error){const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'MAINTENANCE_FAILED';console.error(JSON.stringify({code}));process.exitCode=1;}finally{await pool?.end();}
