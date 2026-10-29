-- research@1.2.1 raised the clarify output ceiling to 512 tokens, but this receipt
-- guard still hard-coded 256. Any receipt with 257–512 completion tokens therefore
-- failed with CLARIFY_RECEIPT *after* the paid provider call, the run was fenced as
-- unknown usage, and the client's retry then looked like a bad model token (401).
-- Bind the guard to the request's own ceiling, exactly like reinlab_clarify_reservation
-- in 202610260002_clarify_lifecycle.sql.
create or replace function reinlab_clarify_receipt() returns trigger language plpgsql as $$
declare p numeric;o numeric;cost numeric;
begin
 if tg_op='INSERT' then
  if new.response_receipt is not null then raise exception 'CLARIFY_RECEIPT' using errcode='23514';end if;return new;
 end if;
 if old.response_receipt is not null then raise exception 'CLARIFY_RECEIPT_IMMUTABLE' using errcode='23514';end if;
 if new.state='completed' then
  if new.response_receipt is null or jsonb_typeof(new.response_receipt->'promptTokens') is distinct from 'number' or jsonb_typeof(new.response_receipt->'completionTokens') is distinct from 'number' or jsonb_typeof(new.response_receipt->'costUpperMicros') is distinct from 'number' or coalesce(new.response_receipt->>'responseSha256','')!~'^[a-f0-9]{64}$' or coalesce(new.response_receipt->>'responseModel','') not in ('deepseek-flash','deepseek-v4-flash','DeepSeek-V4.1-Flash-1017') or coalesce(new.response_receipt->>'pricingVersion','')<>'deepseek-official-2026-10-20' then raise exception 'CLARIFY_RECEIPT' using errcode='23514';end if;
  p=(new.response_receipt->>'promptTokens')::numeric;o=(new.response_receipt->>'completionTokens')::numeric;cost=(new.response_receipt->>'costUpperMicros')::numeric;
  if p<0 or p<>trunc(p) or o<0 or o<>trunc(o) or o>new.max_output or p+o<=0 or cost<>ceil(p*2.16+o*8.64) or cost>new.maximum_micros or cost<1 then raise exception 'CLARIFY_RECEIPT' using errcode='23514';end if;
 elsif new.response_receipt is not null then raise exception 'CLARIFY_RECEIPT' using errcode='23514';end if;
 return new;
end $$;
revoke all on function reinlab_clarify_receipt() from public;
