-- Run-local forwarding fences. Unknown prior runs retain their full reservation.
alter table clarify_model_request add column max_output integer not null default 256 check(max_output in (256,512));
alter table clarify_model_request drop constraint clarify_model_request_pkey;
alter table clarify_model_request add primary key(account_id,run_id,body_hash);
alter table budget_hold add column known_cost_cny numeric(18,6) not null default 0 check(known_cost_cny>=0);
update budget_hold set known_cost_cny=coalesce(actual_cny,0) where state='settled';
grant update(known_cost_cny) on budget_hold to reinlab_app;
alter table dossier alter column bench_version set default '1.2.1';
-- Re-evaluate every receipt, including rows written before strict receipt validation.
-- Invalid/partial legacy proofs never release any reservation and are not rewritten.
create or replace function reinlab_clarify_reservation(r clarify_model_request) returns integer
language plpgsql immutable parallel safe as $$
declare proof jsonb;p numeric;o numeric;cost numeric;
begin
 proof=r.response_receipt;
 if r.state<>'completed' or proof is null then return r.maximum_micros;end if;
 if jsonb_typeof(proof->'promptTokens') is distinct from 'number' or jsonb_typeof(proof->'completionTokens') is distinct from 'number' or jsonb_typeof(proof->'costUpperMicros') is distinct from 'number' or coalesce(proof->>'responseSha256','')!~'^[a-f0-9]{64}$' or coalesce(proof->>'responseModel','') not in ('deepseek-flash','deepseek-v4-flash','DeepSeek-V4.1-Flash-1017') or coalesce(proof->>'pricingVersion','')<>'deepseek-official-2026-10-20' then return r.maximum_micros;end if;
 p=(proof->>'promptTokens')::numeric;o=(proof->>'completionTokens')::numeric;cost=(proof->>'costUpperMicros')::numeric;
 if p<0 or p<>trunc(p) or o<0 or o<>trunc(o) or o>r.max_output or p+o<=0 or cost<>ceil(p*2.16+o*8.64) or cost>r.maximum_micros or cost<1 then return r.maximum_micros;end if;
 return cost::integer;
 exception when numeric_value_out_of_range or invalid_text_representation then return r.maximum_micros;
end $$;
revoke all on function reinlab_clarify_reservation(clarify_model_request) from public;
grant execute on function reinlab_clarify_reservation(clarify_model_request) to reinlab_app;
create or replace function reinlab_clarify_model_limit() returns trigger language plpgsql as $$
declare total integer;rounds integer;busy boolean;
begin
 if tg_op='UPDATE' then
  if row(new.account_id,new.dossier_id,new.run_id,new.body_hash,new.maximum_micros,new.max_output,new.created_at) is distinct from row(old.account_id,old.dossier_id,old.run_id,old.body_hash,old.maximum_micros,old.max_output,old.created_at) or old.state<>'forwarding' or new.state not in ('completed','unknown') then raise exception 'CLARIFY_MODEL_IMMUTABLE' using errcode='23514';end if;return new;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('ledger:'||new.account_id::text,0));
 if new.state<>'forwarding' or not exists(select 1 from read_clarify_run r join read_clarification d using(account_id,dossier_id) where r.account_id=new.account_id and r.run_id=new.run_id and not r.closed and not d.closed) then raise exception 'CLARIFY_CLOSED' using errcode='23514';end if;
 select coalesce(sum(reinlab_clarify_reservation(clarify_model_request)),0),count(*),coalesce(bool_or(state<>'completed'),false) into total,rounds,busy from clarify_model_request where account_id=new.account_id and run_id=new.run_id;
 if new.max_output=512 and not exists(select 1 from os_binding b where b.account_id=new.account_id and b.run_id=new.run_id and b.role_options->'role'->'modelCap'->>'output_tokens'='512') then raise exception 'CLARIFY_OUTPUT_CAP_INVALID' using errcode='23514';end if;
 if busy or rounds>=6 or total+new.maximum_micros>50000 then raise exception 'CLARIFY_MODEL_LIMIT' using errcode='23514';end if;return new;
end $$;
revoke all on function reinlab_clarify_model_limit() from public;
