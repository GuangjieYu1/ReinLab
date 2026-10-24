import { expect, it } from 'vitest';
import pg from 'pg';
import { mcpFixture } from './mcp-fixture';
import { RecoveryDiscovery } from '../../worker/src/discovery';
it('P1-13 discovery can enumerate UUIDs but cannot read account data/business tables or SET ROLE across either boundary',async()=>{
 const f=await mcpFixture();const pool=new pg.Pool({connectionString:'postgres://reinlab_reconcile_discovery@127.0.0.1:55432/reinlab_test',max:1});
 try {
  const discovery=new RecoveryDiscovery(pool);await discovery.assertSafe();
  const ids:string[]=[]; let after:string|undefined;
  for(;;){const page=await discovery.page(after,250);ids.push(...page);if(page.length<250)break;after=page.at(-1);}
  expect(ids).toContain(f.account);expect(ids).toEqual([...ids].sort());expect(new Set(ids).size).toBe(ids.length);
  for(const query of ['select * from account','select display_name from account','select id from account where display_name is null','select * from run','select * from account_machine_secret','update account set display_name=\'x\'','set role reinlab_app']) await expect(pool.query(query)).rejects.toMatchObject({code:'42501'});
  await expect(f.pool.query('set role reinlab_reconcile_discovery')).rejects.toMatchObject({code:'42501'});
  await expect(new RecoveryDiscovery(f.pool).assertSafe()).rejects.toThrow('UNSAFE_DISCOVERY_ROLE');
 } finally {await pool.end();await f.close();}
});
