import type pg from 'pg';
import {z} from 'zod';
import {LedgerEvent,CredentialKind,Json,type JsonValue} from '@reinlab/contracts';
import {ApiFailure,denied} from '../api/errors';
import {canonical} from '../api/context';

const nullableText=z.string().min(1).nullable().default(null);
const nonnegative=z.number().finite().nonnegative();
const currency=nonnegative.max(999999.999999).refine(value=>{const [significand,exponent='0']=String(value).split('e');return(significand.split('.')[1]?.length??0)-Number(exponent)<=6;},'费用最多六位小数');
const EventInput=z.object({dossierId:z.string().uuid(),runId:z.string().uuid().nullable().default(null),roleId:nullableText,
  kind:LedgerEvent.shape.kind,action:nullableText,risk:LedgerEvent.shape.risk.default(null),
  inputRef:nullableText,outputRef:nullableText,costCny:currency.nullable().default(null),
  quota:nonnegative.int().max(2147483647).nullable().default(null),gpuSeconds:nonnegative.int().max(2147483647).nullable().default(null),credentialKind:CredentialKind.nullable().default(null),
  payload:z.record(Json).default({}),dedupeKey:z.string().min(1).max(500),}).strict();
export type EventInput=z.input<typeof EventInput>;
const sensitive=/(?:authorization|cookie|password|passwd|secret|(?:access|refresh|api|auth|private)[_-]?(?:key|token)|^token$|^credentials?$)/i;
function cleanText(text:string):string {
  return text.replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi,'[REDACTED]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,'[REDACTED]')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|authorization|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&#,;"'<>]+)/gi,'[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED]')
    .replace(/\b(?:sk[-_]|gh[pousr]_|flyV1\s+|sb_secret_)[A-Za-z0-9_+./=-]{12,}/g,'[REDACTED]')
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g,'[REDACTED]')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,url=>{try{const u=new URL(url);if(u.username||u.password){u.username='';u.password='';}for(const key of Array.from(u.searchParams.keys()))if(sensitive.test(key))u.searchParams.set(key,'[REDACTED]');if(u.hash.includes('=')){const fragment=new URLSearchParams(u.hash.slice(1));for(const key of Array.from(fragment.keys()))if(sensitive.test(key))fragment.set(key,'[REDACTED]');u.hash=fragment.toString();}return u.toString();}catch{return '[REDACTED_URL]';}});
}
export function scrub(value:JsonValue):JsonValue {
  if(typeof value==='string')return cleanText(value);
  if(Array.isArray(value))return value.map(scrub);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[cleanText(key),sensitive.test(key)?'[REDACTED]':scrub(v)]));
  return value;
}
const columns=`seq,at,dossier_id as "dossierId",run_id as "runId",role_id as "roleId",kind,action,risk,cost_cny as "costCny",input_ref as "inputRef",output_ref as "outputRef",quota,gpu_seconds as "gpuSeconds",credential_kind as "credentialKind",payload`;
function serialize(row:Record<string,unknown>):LedgerEvent {
  return LedgerEvent.parse(scrub({...row,seq:Number(row.seq),at:row.at instanceof Date?row.at.toISOString():row.at,costCny:row.costCny===null?null:Number(row.costCny)} as JsonValue));
}
export async function requireDossier(client:pg.PoolClient,dossierId:string):Promise<void> {
  if(!z.string().uuid().safeParse(dossierId).success)throw denied();
  if(!(await client.query('select id from dossier where id=$1',[dossierId])).rowCount)throw denied();
}
export async function appendEvent(client:pg.PoolClient,accountId:string,raw:EventInput):Promise<LedgerEvent> {
  const data=EventInput.parse(raw);
  if(!/^[-A-Za-z0-9_.:]{1,500}$/.test(data.dedupeKey)||cleanText(data.dedupeKey)!==data.dedupeKey)throw new ApiFailure('INVALID_INPUT',400,'事件去重键必须是无凭据的标识符。');
  const current=await client.query("select current_setting('app.account_id',true) id");
  if(current.rows[0].id!==accountId)throw denied();
  await requireDossier(client,data.dossierId);
  // One account lock also permits multiple dossiers/events in one transaction without lock-order cycles.
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['ledger:'+accountId]);
  const safe=scrub(data as JsonValue) as unknown as z.output<typeof EventInput>;
  const old=await client.query(`select ${columns} from event where account_id=$1 and dedupe_key=$2`,[accountId,data.dedupeKey]);
  const expected={dossierId:safe.dossierId,runId:safe.runId,roleId:safe.roleId,kind:safe.kind,action:safe.action,risk:safe.risk,costCny:safe.costCny,inputRef:safe.inputRef,outputRef:safe.outputRef,quota:safe.quota,gpuSeconds:safe.gpuSeconds,credentialKind:safe.credentialKind,payload:safe.payload};
  if(old.rowCount){const previous=serialize(old.rows[0]);const {seq,at,...content}=previous;if(canonical(content)!==canonical(expected))throw new ApiFailure('DEDUPE_CONFLICT',409,'事件去重键对应的内容不同。');return previous;}
  const result=await client.query(`insert into event(account_id,dossier_id,run_id,role_id,kind,action,risk,input_ref,output_ref,cost_cny,quota,gpu_seconds,credential_kind,payload,dedupe_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) returning ${columns}`,[accountId,safe.dossierId,safe.runId,safe.roleId,safe.kind,safe.action,safe.risk,safe.inputRef,safe.outputRef,safe.costCny,safe.quota,safe.gpuSeconds,safe.credentialKind,JSON.stringify(safe.payload),data.dedupeKey]);
  return serialize(result.rows[0]);
}
export function parseCursor(raw:string|undefined):number {
  if(raw===undefined)return 0;
  if(!/^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new ApiFailure('INVALID_CURSOR',400,'事件游标必须是非负安全整数。');
  return Number(raw);
}
export async function readEvents(client:pg.PoolClient,dossierId:string,after:number):Promise<LedgerEvent[]> {
  const rows=await client.query(`select ${columns} from event where dossier_id=$1 and seq>$2 order by seq limit 100`,[dossierId,after]);return rows.rows.map(serialize);
}
export async function auditSnapshot(client:pg.PoolClient,dossierId:string) {
  await requireDossier(client,dossierId);
  // Both JSON and aggregation see a single statement snapshot; unknown prices stay unknown.
  const result=await client.query(`with visible as materialized (select ${columns} from event where dossier_id=$1) select coalesce(json_agg(visible order by seq),'[]') events, count(*)::int "eventCount",coalesce(sum("costCny"),0)::numeric(30,6)::text "knownCostCny",count(*) filter(where "costCny" is null)::int "unknownCostEvents",coalesce(sum(quota),0)::text quota,coalesce(sum("gpuSeconds"),0)::text "gpuSeconds" from visible`,[dossierId]);
  const {events,...summary}=result.rows[0];return {events:events.map(serialize) as LedgerEvent[],summary:{...summary,quota:Number(summary.quota),gpuSeconds:Number(summary.gpuSeconds)}};
}
