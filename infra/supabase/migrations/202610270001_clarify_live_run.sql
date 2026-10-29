-- 选定论文会把这一段澄清标记为关闭，但模型还要把这一轮答完（run8 C5）。
-- 关闭只表示「不再开新的澄清轮次」，不应该拦住仍然活着的这个 run 转发；
-- 真正防止乱花钱的是运行终态（ended_at）与预留/轮次上限。
create or replace function reinlab_clarify_model_limit() returns trigger language plpgsql as $$
declare total integer;rounds integer;busy boolean;live boolean;
begin
 if tg_op='UPDATE' then
  if row(new.account_id,new.dossier_id,new.run_id,new.body_hash,new.maximum_micros,new.max_output,new.created_at) is distinct from row(old.account_id,old.dossier_id,old.run_id,old.body_hash,old.maximum_micros,old.max_output,old.created_at) or old.state<>'forwarding' or new.state not in ('completed','unknown') then raise exception 'CLARIFY_MODEL_IMMUTABLE' using errcode='23514';end if;return new;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('ledger:'||new.account_id::text,0));
 select exists(select 1 from read_clarify_run r join read_clarification d using(account_id,dossier_id) join run n on n.id=r.run_id where r.account_id=new.account_id and r.run_id=new.run_id and ((not r.closed and not d.closed) or (n.ended_at is null and n.state in ('running','waiting','paused_budget')))) into live;
 if new.state<>'forwarding' or not live then raise exception 'CLARIFY_CLOSED' using errcode='23514';end if;
 select coalesce(sum(reinlab_clarify_reservation(clarify_model_request)),0),count(*),coalesce(bool_or(state<>'completed'),false) into total,rounds,busy from clarify_model_request where account_id=new.account_id and run_id=new.run_id;
 if new.max_output=512 and not exists(select 1 from os_binding b where b.account_id=new.account_id and b.run_id=new.run_id and b.role_options->'role'->'modelCap'->>'output_tokens'='512') then raise exception 'CLARIFY_OUTPUT_CAP_INVALID' using errcode='23514';end if;
 if busy or rounds>=6 or total+new.maximum_micros>500000 then raise exception 'CLARIFY_MODEL_LIMIT' using errcode='23514';end if;return new;
end $$;
revoke all on function reinlab_clarify_model_limit() from public;
grant execute on function reinlab_clarify_model_limit() to reinlab_app;
