-- MVP-2 修正：图片文件按 (账号, 内容哈希) 唯一——不同账号存同一张图不能互相顶掉。
drop table if exists creative_image_file;
create table creative_image_file (
  account_id uuid not null references account(id) on delete cascade,
  dossier_id uuid not null references dossier(id) on delete cascade,
  file_id text not null,
  mime text not null,
  bytes integer not null,
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  primary key (account_id, file_id)
);
alter table creative_image_file enable row level security;
alter table creative_image_file force row level security;
create policy tenant_scope on creative_image_file to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on creative_image_file to reinlab_app;
