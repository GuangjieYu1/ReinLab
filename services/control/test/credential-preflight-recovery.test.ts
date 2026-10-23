import {it,expect} from 'vitest';
import {reconcileKnownCredentialPreflight} from '../src/provisioner/credential-recovery';
it('trusted preflight recovery rejects an incomplete operator proof without touching resources',async()=>{
 let reads=0;
 await expect(reconcileKnownCredentialPreflight({db:{} as any,driver:{inspectCredentialMigration(){reads++}} as any,vault:{} as any,accountId:'bad',operationId:'bad',recoveryOperationId:'bad',expectedImmutableId:'bad',targetImageDigest:'bad'})).rejects.toThrow();
 expect(reads).toBe(0);
});
