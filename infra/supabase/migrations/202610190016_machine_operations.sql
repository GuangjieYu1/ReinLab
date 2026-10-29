create table account_machine_operation(
 account_id uuid not null references account(id),operation_id uuid not null,request_hash char(64) not null check(request_hash ~ '^[a-f0-9]{64}$'),image text not null,
 mode text not null check(mode in ('wait','interrupt')),state text not null check(state in ('pending','indeterminate','applied')),created_at timestamptz not null default now(),
 primary key(account_id,operation_id)
);
alter table account_machine_operation enable row level security;
alter table account_machine_operation force row level security;
create policy account_scope on account_machine_operation using(account_id=current_setting('app.account_id',true)::uuid) with check(account_id=current_setting('app.account_id',true)::uuid);
grant select,insert on account_machine_operation to reinlab_app;
grant update(state) on account_machine_operation to reinlab_app;
