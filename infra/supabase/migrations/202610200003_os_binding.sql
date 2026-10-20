-- 控制面会话身份及发送意图；不授予删除，也不把凭据存入绑定。
create table os_binding (
 account_id uuid not null references account(id),
 dossier_id uuid not null,
 run_id uuid primary key,
 logical_role_id text not null references role_def(id),
 request_id text not null,
 session_id text not null check(session_id ~ '^ses_rl[a-f0-9]{32}$'),
 role_options jsonb not null,
 definition_hash text not null check(definition_hash ~ '^[a-f0-9]{64}$'),
 message text not null check(length(message) between 1 and 1000000),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 phase text not null default 'planned' check(phase in ('planned','preparing','prepared','submitting','accepted')),
 lease_id uuid, lease_until timestamptz,
 cursor bigint not null default 0 check(cursor>=0),
 initialized boolean not null default false,
 receipt jsonb, hold_id uuid references budget_hold(id),
 created_at timestamptz not null default now(),
 foreign key(account_id,dossier_id,run_id) references run(account_id,dossier_id,id),
 unique(account_id,session_id), unique(account_id,request_id),
 check ((receipt is not null) = (phase='accepted'))
);
create function reinlab_binding_immutable() returns trigger language plpgsql as $$ begin
 if row(new.account_id,new.dossier_id,new.run_id,new.logical_role_id,new.request_id,new.session_id,new.role_options,new.definition_hash,new.message,new.input_hash)
 is distinct from row(old.account_id,old.dossier_id,old.run_id,old.logical_role_id,old.request_id,old.session_id,old.role_options,old.definition_hash,old.message,old.input_hash)
 then raise exception 'OS_BINDING_IMMUTABLE' using errcode='23514'; end if;
 if old.phase in ('submitting','accepted') and new.phase not in ('submitting','accepted') then raise exception 'OS_SEND_FENCE_IMMUTABLE' using errcode='23514'; end if;
 if old.receipt is not null and new.receipt is distinct from old.receipt then raise exception 'OS_RECEIPT_IMMUTABLE' using errcode='23514'; end if;
 if new.cursor<old.cursor then raise exception 'OS_CURSOR_REGRESSION' using errcode='23514'; end if;
 return new;
end $$;
revoke all on function reinlab_binding_immutable() from public;
create trigger os_binding_immutable before update on os_binding for each row execute function reinlab_binding_immutable();
alter table os_binding enable row level security;
alter table os_binding force row level security;
create policy tenant_scope on os_binding to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert,update on os_binding to reinlab_app;
revoke delete,truncate on os_binding from reinlab_app;
create index os_binding_account on os_binding(account_id,phase);
