-- Only a complete, bounded usage receipt can replace a request's worst-case reservation.
-- Unknown/in-flight requests keep the full maximum permanently. All attempts still count.
create function reinlab_clarify_receipt() returns trigger language plpgsql as $$
declare p numeric;o numeric;cost numeric;
begin
 if tg_op='INSERT' then
  if new.response_receipt is not null then raise exception 'CLARIFY_RECEIPT' using errcode='23514';end if;return new;
 end if;
 if old.response_receipt is not null then raise exception 'CLARIFY_RECEIPT_IMMUTABLE' using errcode='23514';end if;
 if new.state='completed' then
  if new.response_receipt is null or jsonb_typeof(new.response_receipt->'promptTokens')<>'number' or jsonb_typeof(new.response_receipt->'completionTokens')<>'number' or jsonb_typeof(new.response_receipt->'costUpperMicros')<>'number' or coalesce(new.response_receipt->>'responseSha256','')!~'^[a-f0-9]{64}$' then raise exception 'CLARIFY_RECEIPT' using errcode='23514';end if;
  p=(new.response_receipt->>'promptTokens')::numeric;o=(new.response_receipt->>'completionTokens')::numeric;cost=(new.response_receipt->>'costUpperMicros')::numeric;
  if p<0 or p<>trunc(p) or o<0 or o<>trunc(o) or o>256 or p+o<=0 or cost<>ceil(p*2.16+o*8.64) or cost>new.maximum_micros or cost<1 then raise exception 'CLARIFY_RECEIPT' using errcode='23514';end if;
 elsif new.response_receipt is not null then raise exception 'CLARIFY_RECEIPT' using errcode='23514';end if;
 return new;
end $$;
revoke all on function reinlab_clarify_receipt() from public;
create trigger clarify_receipt before insert or update on clarify_model_request for each row execute function reinlab_clarify_receipt();
create or replace function reinlab_clarify_model_limit() returns trigger language plpgsql as $$
declare total integer;rounds integer;busy boolean;
begin
 if tg_op='UPDATE' then
  if row(new.account_id,new.dossier_id,new.run_id,new.body_hash,new.maximum_micros,new.created_at) is distinct from row(old.account_id,old.dossier_id,old.run_id,old.body_hash,old.maximum_micros,old.created_at) or old.state<>'forwarding' or new.state not in ('completed','unknown') then raise exception 'CLARIFY_MODEL_IMMUTABLE' using errcode='23514';end if;return new;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('ledger:'||new.account_id::text,0));
 if new.state<>'forwarding' or not exists(select 1 from read_clarify_run r join read_clarification d using(account_id,dossier_id) where r.account_id=new.account_id and r.run_id=new.run_id and not r.closed and not d.closed) then raise exception 'CLARIFY_CLOSED' using errcode='23514';end if;
 select coalesce(sum(case when state='completed' then coalesce((response_receipt->>'costUpperMicros')::integer,maximum_micros) else maximum_micros end),0),count(*),coalesce(bool_or(state<>'completed'),false) into total,rounds,busy from clarify_model_request where account_id=new.account_id and dossier_id=new.dossier_id;
 if busy or rounds>=6 or total+new.maximum_micros>50000 then raise exception 'CLARIFY_MODEL_LIMIT' using errcode='23514';end if;return new;
end $$;
revoke all on function reinlab_clarify_model_limit() from public;
