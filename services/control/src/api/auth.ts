import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiFailure } from './errors';

export type JwtConfig = { issuer: string; secret?: Uint8Array };
export function createVerifier(config: JwtConfig) {
  if (!config.issuer || (config.secret && config.secret.byteLength<32)) throw new Error('AUTH_CONFIG_INVALID: JWT配置缺失或密钥过短');
  const key=config.secret??createRemoteJWKSet(new URL(config.issuer.replace(/\/$/,'')+'/.well-known/jwks.json'));
  return async (authorization: string | undefined): Promise<string> => {
    if (!authorization) throw new ApiFailure('AUTH_REQUIRED',401,'请先登录。');
    const match=/^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) throw new ApiFailure('AUTH_INVALID',401,'登录凭据格式无效。');
    try {
      const {payload}=await jwtVerify(match[1],key,{issuer:config.issuer,audience:'authenticated',algorithms:config.secret?['HS256']:['ES256','RS256'],requiredClaims:['sub','exp','iat','iss','aud']});
      if(payload.role!=='authenticated'||typeof payload.sub!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub)) throw new Error('invalid subject');
      return payload.sub;
    } catch { throw new ApiFailure('AUTH_INVALID',401,'登录已失效或凭据无效，请重新登录。'); }
  };
}
