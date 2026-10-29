-- 观察器的每条游标与费用均由受RLS的应用事务提交。
alter table os_binding add unique(account_id,run_id,session_id);
alter table os_binding add column pricing_context jsonb;
create table os_observation (
 account_id uuid not null references account(id), run_id uuid not null,
 session_id text not null, sequence bigint not null check(sequence>0),
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 event_seq bigint not null references event(seq),
 primary key(account_id,session_id,sequence),
 foreign key(account_id,run_id,session_id) references os_binding(account_id,run_id,session_id)
);
create table os_usage (
 account_id uuid not null references account(id), dossier_id uuid not null,
 run_id uuid not null,session_id text not null,part_id text not null,message_id text not null,
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 cost_cny numeric(12,6) check(cost_cny>=0),metadata jsonb not null,
 event_seq bigint not null references event(seq),
 primary key(account_id,session_id,part_id),
 foreign key(account_id,dossier_id,run_id) references run(account_id,dossier_id,id),
 foreign key(account_id,run_id,session_id) references os_binding(account_id,run_id,session_id)
);
alter table approval add column os_session_id text;
alter table approval add column decision_hash text check(decision_hash ~ '^[a-f0-9]{64}$');
alter table approval add column decision_input jsonb;
alter table approval add column decision_receipt jsonb;
create unique index approval_os_identity on approval(account_id,run_id,os_session_id,kind,os_request_id) where os_request_id is not null and os_session_id is not null;
do $$ declare t text;begin
 foreach t in array array['os_observation','os_usage'] loop
 execute format('alter table %I enable row level security',t);
 execute format('alter table %I force row level security',t);
 execute format('create policy tenant_scope on %I to reinlab_app using(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid) with check(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid)',t);
 execute format('grant select,insert on %I to reinlab_app',t);
 execute format('revoke update,delete,truncate on %I from reinlab_app',t);
 end loop;
end $$;
create function reinlab_binding_settlement_guard() returns trigger language plpgsql as $$begin
 if old.pricing_context is not null and new.pricing_context is distinct from old.pricing_context then raise exception 'OS_PRICE_IMMUTABLE' using errcode='23514';end if;
 if old.hold_id is not null and new.hold_id is distinct from old.hold_id then raise exception 'OS_HOLD_IMMUTABLE' using errcode='23514';end if;
 if new.hold_id is not null and not exists(select 1 from budget_hold h where h.id=new.hold_id and h.account_id=new.account_id and h.run_id=new.run_id and h.dossier_id=new.dossier_id) then raise exception 'OS_HOLD_SCOPE_INVALID' using errcode='23514';end if;
 return new;end $$;
revoke all on function reinlab_binding_settlement_guard() from public;
create trigger os_binding_settlement_guard before insert or update on os_binding for each row execute function reinlab_binding_settlement_guard();
