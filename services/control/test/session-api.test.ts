import {it,expect} from 'vitest';
import {Hono} from 'hono';
import {registerSession} from '../src/api/session';
import {ApiFailure} from '../src/api/errors';
import type {ApiEnv} from '../src/api/context';
it('会话代理仅固定目标、同源JSON，不回显上游错误/多余字段且禁缓存',async()=>{
 let calls=0;const app=new Hono<ApiEnv>();registerSession(app,{url:'http://127.0.0.1:54321',anonKey:'FIXTURE_ANON',transport:(async(url,init)=>{calls++;expect(String(url)).toBe('http://127.0.0.1:54321/auth/v1/token?grant_type=password');expect(JSON.parse(init!.body as string)).toEqual({email:'a@example.test',password:'fixture-password'});return Response.json({access_token:'a'.repeat(32),refresh_token:'b'.repeat(32),expires_in:3600,user:{id:'12345678-1234-4234-8234-123456789abc'},extra:'PRIVATE_PROVIDER_FIELD'});}) as typeof fetch});app.onError((e,c)=>c.json({code:e instanceof ApiFailure?e.code:'INTERNAL_ERROR'},e instanceof ApiFailure?e.status:500));
 const body=JSON.stringify({email:'a@example.test',password:'fixture-password'});
 for(const headers of [{'content-type':'application/json'}, {'content-type':'application/json',origin:'https://evil.test'},{'content-type':'application/json',origin:'http://localhost','sec-fetch-site':'cross-site'}])expect((await app.request('http://localhost/auth/login',{method:'POST',headers,body})).status).toBe(403);
 expect(calls).toBe(0);const r=await app.request('http://localhost/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost','sec-fetch-site':'same-origin'},body});expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(await r.text()).not.toContain('PRIVATE_PROVIDER');expect(calls).toBe(1);
});
it('Supabase实际12字符refresh token作为不透明凭据保留，认证仍由固定Auth端验证',async()=>{
 const app=new Hono<ApiEnv>();registerSession(app,{url:'http://127.0.0.1:54321',anonKey:'fixture',transport:(async()=>Response.json({access_token:'a'.repeat(64),refresh_token:'fixture12abc',expires_in:3600,user:{id:'12345678-1234-4234-8234-123456789abc'}})) as typeof fetch});app.onError((e,c)=>c.json({code:e instanceof ApiFailure?e.code:'INTERNAL'},e instanceof ApiFailure?e.status:500));
 const r=await app.request('http://localhost/auth/login',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({email:'a@example.test',password:'fixture'})});expect(r.status).toBe(200);expect((await r.json()).refreshToken.length).toBe(12);
});
it('本机用户名映射后仍由Auth验证密码；未知用户名不转发且映射必须命中原账户',async()=>{
 let calls=0;let account='12345678-1234-4234-8234-123456789abc';
 const app=new Hono<ApiEnv>();registerSession(app,{url:'http://127.0.0.1:54321',anonKey:'fixture',usernameAlias:{username:'local-user',email:'a@example.test',accountId:account},transport:(async(_url,init)=>{calls++;expect(JSON.parse(init!.body as string)).toEqual({email:'a@example.test',password:'fixture-password'});return Response.json({access_token:'a'.repeat(32),refresh_token:'b'.repeat(32),expires_in:3600,user:{id:account}});}) as typeof fetch});
 app.onError((e,c)=>c.json({code:e instanceof ApiFailure?e.code:'INTERNAL'},e instanceof ApiFailure?e.status:500));
 const request=(email:string)=>app.request('http://localhost/auth/login',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({email,password:'fixture-password'})});
 expect((await request('local-user')).status).toBe(200);
 expect((await request('unknown-user')).status).toBe(401);expect(calls).toBe(1);
 expect((await request('invalid@@example')).status).toBe(400);expect(calls).toBe(1);
 account='22345678-1234-4234-8234-123456789abc';
 expect((await request('local-user')).status).toBe(401);
});
