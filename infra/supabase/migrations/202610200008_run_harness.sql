alter table bench_effective add unique(account_id,digest,bench,version);
create table run_harness (
 account_id uuid not null,dossier_id uuid not null,run_id uuid primary key,
 bench text not null,version text not null,effective_digest text not null,
 foreign key(account_id,dossier_id,run_id) references run(account_id,dossier_id,id),
 foreign key(account_id,effective_digest,bench,version) references bench_effective(account_id,digest,bench,version)
);
alter table run_harness enable row level security;
alter table run_harness force row level security;
create policy tenant_scope on run_harness to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert on run_harness to reinlab_app;
revoke update,delete,truncate on run_harness from reinlab_app;
create trigger run_harness_immutable before update or delete on run_harness for each row execute function reinlab_append_only();
