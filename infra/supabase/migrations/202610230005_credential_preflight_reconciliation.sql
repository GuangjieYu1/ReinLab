alter table account_machine_operation drop constraint account_machine_operation_state_check;
alter table account_machine_operation add constraint account_machine_operation_state_check check(state in ('pending','indeterminate','applied','not_applied'));
create table credential_preflight_reconciliation (
 account_id uuid not null,operation_id uuid not null,recovery_operation_id uuid not null,
 immutable_id text not null check(immutable_id ~ '^[a-f0-9]{64}$'),
 container_created_at timestamptz not null,target_image_digest text not null check(target_image_digest ~ '^sha256:[a-f0-9]{64}$'),
 proof_digest text not null check(proof_digest ~ '^[a-f0-9]{64}$'),
 reason text not null check(reason='e044e46_image_env_preflight_rejection'),
 created_at timestamptz not null default now(),primary key(account_id,operation_id),unique(account_id,recovery_operation_id),
 foreign key(account_id,operation_id) references account_machine_operation(account_id,operation_id),
 foreign key(account_id,recovery_operation_id) references account_machine_operation(account_id,operation_id)
);
alter table credential_preflight_reconciliation enable row level security;
alter table credential_preflight_reconciliation force row level security;
create policy tenant on credential_preflight_reconciliation to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert on credential_preflight_reconciliation to reinlab_app;
revoke update,delete,truncate on credential_preflight_reconciliation from reinlab_app;
create trigger credential_preflight_reconciliation_immutable before update or delete on credential_preflight_reconciliation for each row execute function reinlab_append_only();
create function reinlab_machine_operation_terminal() returns trigger language plpgsql as $$begin
 if old.state in ('not_applied','applied') and new.state is distinct from old.state then raise exception 'MACHINE_OPERATION_TERMINAL' using errcode='23514';end if;
 if new.state='not_applied' and not exists(select 1 from credential_preflight_reconciliation r where r.account_id=new.account_id and r.operation_id=new.operation_id) then raise exception 'RECONCILIATION_REQUIRED' using errcode='23514';end if;
 return new;end $$;
revoke all on function reinlab_machine_operation_terminal() from public;
create trigger machine_operation_terminal before update on account_machine_operation for each row execute function reinlab_machine_operation_terminal();
