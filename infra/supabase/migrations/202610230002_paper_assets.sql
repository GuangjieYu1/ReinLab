create table paper_asset (
 id uuid primary key,account_id uuid not null,dossier_id uuid not null,run_id uuid not null,
 paper_id text not null,source text not null,license text,status text not null check(status in ('full_text','abstract_only')),
 is_open_access boolean not null,sha256 text check(sha256 ~ '^[a-f0-9]{64}$'),path text not null,
 abstract text not null,created_at timestamptz not null default now(),
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id),
 check(status<>'full_text' or (is_open_access and license is not null and sha256 is not null))
);
alter table paper_asset enable row level security;
alter table paper_asset force row level security;
create policy tenant on paper_asset to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert on paper_asset to reinlab_app;
revoke update,delete,truncate on paper_asset from reinlab_app;
create trigger paper_asset_immutable before update or delete on paper_asset for each row execute function reinlab_append_only();
