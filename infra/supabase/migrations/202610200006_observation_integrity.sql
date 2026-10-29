alter table os_binding add column usage_uncertain boolean not null default false;
-- 不完整历史/无效用量只能保持不确定，不能靠后续观察把它洗为已知。
create function reinlab_usage_uncertain_guard() returns trigger language plpgsql as $$begin
 if old.usage_uncertain and not new.usage_uncertain then raise exception 'OS_USAGE_RECONCILIATION_REQUIRED' using errcode='23514';end if;
 return new;end $$;
revoke all on function reinlab_usage_uncertain_guard() from public;
create trigger os_usage_uncertain_guard before update on os_binding for each row execute function reinlab_usage_uncertain_guard();
