import type { Context } from 'hono';
import type { z } from 'zod';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import type { JsonValue } from '@reinlab/contracts';
import type { Database } from '../db/database';
import { ApiFailure } from './errors';

export type ApiEnv = { Variables: { accountId: string } };
export type ApiContext = Context<ApiEnv>;
export type Receipt = { status: 200|201|202; body: JsonValue };
export function canonical(value: unknown): string {
  if(typeof value==='number'&&!Number.isFinite(value))throw new ApiFailure('INVALID_INPUT',400,'数字必须是有限值。');
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,val])=>JSON.stringify(key)+':'+canonical(val)).join(',')+'}';
  throw new ApiFailure('INVALID_INPUT',400,'请求包含不支持的数据。');
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function mutate<T>(c: ApiContext, database: Database, schema: z.ZodType<T>, work: (client: pg.PoolClient,input:T)=>Promise<Receipt>): Promise<Response> {
  const key=c.req.header('Idempotency-Key');
  if(!key||!/^[-A-Za-z0-9_.:]{1,200}$/.test(key))throw new ApiFailure('IDEMPOTENCY_KEY_REQUIRED',400,'写入请求需要有效的 Idempotency-Key。');
  let raw:unknown;
  try {raw=await c.req.json();} catch {throw new ApiFailure('INVALID_INPUT',400,'请求不是有效的JSON。');}
  const parsed=schema.safeParse(raw);
  if(!parsed.success)throw new ApiFailure('INVALID_INPUT',400,'请求字段不符合要求，请检查输入。');
  const keyHash=digest(key),requestHash=digest(c.req.method+'\n'+c.req.path+'\n'+canonical(parsed.data));
  const accountId=c.get('accountId');
  const receipt=await database.withAccount(accountId,async client=>{
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[accountId+':'+keyHash]);
    const old=await client.query<{request_hash:string;status:200|201|202;response:JsonValue}>('select request_hash,status,response from http_request where account_id=$1 and key_hash=$2',[accountId,keyHash]);
    if(old.rowCount){if(old.rows[0].request_hash!==requestHash)throw new ApiFailure('IDEMPOTENCY_CONFLICT',409,'同一幂等键对应的请求内容不同。');return{status:old.rows[0].status,body:old.rows[0].response};}
    const result=await work(client,parsed.data);
    await client.query('insert into http_request(account_id,key_hash,request_hash,status,response) values($1,$2,$3,$4,$5::jsonb)',[accountId,keyHash,requestHash,result.status,JSON.stringify(result.body)]);
    return result;
  });
  return new Response(JSON.stringify(receipt.body),{status:receipt.status,headers:{'Content-Type':'application/json; charset=UTF-8'}});
}
