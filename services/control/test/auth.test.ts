import { expect,it } from 'vitest';
import { createServer } from 'node:http';
import { randomBytes,randomUUID } from 'node:crypto';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { createVerifier } from '../src/api/auth';

it('JWKS验证ES256真实签名，拒绝HS256算法切换与未知kid',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('ES256',{extractable:true});
  const jwk={...await exportJWK(publicKey),kid:'key-1',alg:'ES256',use:'sig'};
  const server=createServer((req,res)=>{
    if(req.url!=='/auth/v1/.well-known/jwks.json'){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({keys:[jwk]}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('TEST_LISTEN_FAILED');
  const issuer=`http://127.0.0.1:${address.port}/auth/v1`,subject=randomUUID(),verify=createVerifier({issuer});
  const claims=()=>new SignJWT({role:'authenticated'}).setSubject(subject).setIssuer(issuer).setAudience('authenticated').setIssuedAt().setExpirationTime('1h');
  try {
    const jwt=await claims().setProtectedHeader({alg:'ES256',kid:'key-1'}).sign(privateKey);
    expect(await verify('Bearer '+jwt)).toBe(subject);
    const wrongAlgorithm=await claims().setProtectedHeader({alg:'HS256',kid:'key-1'}).sign(randomBytes(48));
    await expect(verify('Bearer '+wrongAlgorithm)).rejects.toMatchObject({code:'AUTH_INVALID'});
    const unknownKey=await claims().setProtectedHeader({alg:'ES256',kid:'unknown'}).sign(privateKey);
    await expect(verify('Bearer '+unknownKey)).rejects.toMatchObject({code:'AUTH_INVALID'});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
