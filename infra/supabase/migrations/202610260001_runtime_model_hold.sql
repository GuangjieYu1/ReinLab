-- Each paid HTTP is a sub-reservation of the already-confirmed run hold.
create table runtime_model_request (
 account_id uuid not null,dossier_id uuid not null,run_id uuid not null,hold_id uuid not null references budget_hold(id),
 body_hash text not null check(body_hash ~ '^[a-f0-9]{64}$'),
 wire_bytes integer not null check(wire_bytes between 1 and 65536),
 max_output integer not null check(max_output between 1 and 1024),
 maximum_micros bigint not null check(maximum_micros=ceil(((wire_bytes+4096)::numeric*216+max_output*864)/100)),
 state text not null check(state in ('forwarding','completed','unknown')),response_receipt jsonb,
 created_at timestamptz not null default now(),primary key(account_id,run_id,body_hash),
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id),
 check((state='completed')=(response_receipt is not null))
);
alter table runtime_model_request enable row level security;
alter table runtime_model_request force row level security;
create policy tenant on runtime_model_request to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert,update on runtime_model_request to reinlab_app;
revoke delete,truncate on runtime_model_request from reinlab_app;

create function reinlab_runtime_model_receipt_valid(v runtime_model_request) returns boolean language plpgsql immutable as $$
declare p jsonb:=v.response_receipt; i bigint; o bigint; cost bigint;
begin
 if v.state<>'completed' or p is null or jsonb_typeof(p)<>'object' then return false;end if;
 if not(p ?& array['promptTokens','completionTokens','costUpperMicros','observedAt','responseSha256','pricingVersion','responseModel'])
 or coalesce(p->>'promptTokens','') !~ '^(0|[1-9][0-9]{0,8})$' or coalesce(p->>'completionTokens','') !~ '^(0|[1-9][0-9]{0,8})$'
 or coalesce(p->>'costUpperMicros','') !~ '^[1-9][0-9]{0,8}$' or coalesce(p->>'observedAt','') !~ '^[1-9][0-9]{0,15}$'
 or coalesce(p->>'responseSha256','') !~ '^[a-f0-9]{64}$'
 or (p->>'pricingVersion') is distinct from 'deepseek-official-2026-10-20'
 or coalesce(p->>'responseModel','') not in ('deepseek-flash','deepseek-v4-flash','DeepSeek-V4.1-Flash-1017')
 or jsonb_typeof(p->'promptTokens')<>'number' or jsonb_typeof(p->'completionTokens')<>'number'
 or jsonb_typeof(p->'costUpperMicros')<>'number' or jsonb_typeof(p->'observedAt')<>'number' then return false;end if;
 i:=(p->>'promptTokens')::bigint;o:=(p->>'completionTokens')::bigint;cost:=(p->>'costUpperMicros')::bigint;
 return i<=v.wire_bytes+4096 and o<=v.max_output and i+o>0 and cost=ceil((i::numeric*216+o*864)/100) and cost<=v.maximum_micros and (p->>'observedAt')::bigint<=9007199254740991;
end $$;
revoke all on function reinlab_runtime_model_receipt_valid(runtime_model_request) from public;
grant execute on function reinlab_runtime_model_receipt_valid(runtime_model_request) to reinlab_app;
create function reinlab_runtime_model_reservation(v runtime_model_request) returns bigint language sql immutable as $$
 select case when reinlab_runtime_model_receipt_valid(v) then (v.response_receipt->>'costUpperMicros')::bigint else v.maximum_micros end
$$;
revoke all on function reinlab_runtime_model_reservation(runtime_model_request) from public;
grant execute on function reinlab_runtime_model_reservation(runtime_model_request) to reinlab_app;

create function reinlab_runtime_model_limit() returns trigger language plpgsql as $$
declare cap numeric; used numeric; busy boolean; rounds integer; steps integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('ledger:'||new.account_id::text,0));
 if tg_op='UPDATE' then
  if row(new.account_id,new.dossier_id,new.run_id,new.hold_id,new.body_hash,new.wire_bytes,new.max_output,new.maximum_micros,new.created_at) is distinct from row(old.account_id,old.dossier_id,old.run_id,old.hold_id,old.body_hash,old.wire_bytes,old.max_output,old.maximum_micros,old.created_at)
  or old.state<>'forwarding' or new.state not in ('completed','unknown') then raise exception 'MODEL_RESERVATION_IMMUTABLE' using errcode='23514';end if;
  if new.state='completed' and not reinlab_runtime_model_receipt_valid(new) then raise exception 'MODEL_RECEIPT_INVALID' using errcode='23514';end if;
  return new;
 end if;
 select h.maximum_cny*1000000,(b.role_options->'role'->>'steps')::integer into cap,steps
 from budget_hold h join run r on r.account_id=h.account_id and r.id=h.run_id
 join os_binding b on b.account_id=r.account_id and b.run_id=r.id and b.hold_id=h.id
 where h.account_id=new.account_id and h.dossier_id=new.dossier_id and h.run_id=new.run_id and h.id=new.hold_id
 and h.state='reserved' and r.state in ('running','waiting') and r.ended_at is null and r.role_id in ('research-read','research-clarify')
 and b.role_options->>'model'='deepseek/deepseek-v4-flash' for share of h,r,b;
 if cap is null or steps is null or new.state<>'forwarding' or new.response_receipt is not null then raise exception 'MODEL_HOLD_INVALID' using errcode='23514';end if;
 select coalesce(sum(reinlab_runtime_model_reservation(v)),0),coalesce(bool_or(state<>'completed'),false),count(*) into used,busy,rounds from runtime_model_request v where account_id=new.account_id and hold_id=new.hold_id;
 if busy or rounds>=steps or used+new.maximum_micros>cap then raise exception 'MODEL_HOLD_LIMIT' using errcode='23514';end if;
 return new;
end $$;
revoke all on function reinlab_runtime_model_limit() from public;
create trigger runtime_model_limit before insert or update on runtime_model_request for each row execute function reinlab_runtime_model_limit();
