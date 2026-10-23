-- Only successful, schema-validated papers.pages results enter this append-only citation source.
alter table paper_asset add constraint paper_asset_account_dossier_id unique(account_id,dossier_id,id);
create table paper_page_read (
 account_id uuid not null,dossier_id uuid not null,run_id uuid not null,asset_id uuid not null,
 page integer not null check(page between 1 and 1000),
 text_sha256 text not null check(text_sha256 ~ '^[a-f0-9]{64}$'),
 page_text text not null check(octet_length(page_text)<=4194304),
 created_at timestamptz not null default now(),
 primary key(account_id,run_id,asset_id,page,text_sha256),
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id),
 foreign key(account_id,dossier_id,asset_id) references paper_asset(account_id,dossier_id,id)
);
alter table paper_page_read enable row level security;
alter table paper_page_read force row level security;
create policy tenant on paper_page_read to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert on paper_page_read to reinlab_app;
revoke update,delete,truncate on paper_page_read from reinlab_app;
create trigger paper_page_read_immutable before update or delete on paper_page_read for each row execute function reinlab_append_only();
