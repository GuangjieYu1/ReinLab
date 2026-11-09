-- 创作台 MVP-2：人物形象资产（立绘 + 三视图）。契约 20 §12。
--
-- 资产 ID 稳定：一个实体一行；版本列表在 document 里（新的在前）。
-- 图片本体不入库，落本机磁盘（creative_image_file 记 fileId 与元数据）。
create table if not exists creative_person_asset (
  account_id uuid not null references account(id) on delete cascade,
  dossier_id uuid not null references dossier(id) on delete cascade,
  entity_id text not null,
  asset_id text not null,
  document jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, dossier_id, entity_id)
);

create table if not exists creative_image_file (
  file_id text primary key,
  account_id uuid not null references account(id) on delete cascade,
  dossier_id uuid not null references dossier(id) on delete cascade,
  mime text not null,
  bytes integer not null,
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

alter table creative_person_asset enable row level security;
alter table creative_person_asset force row level security;
drop policy if exists tenant_scope on creative_person_asset;
create policy tenant_scope on creative_person_asset to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update, delete on creative_person_asset to reinlab_app;

alter table creative_image_file enable row level security;
alter table creative_image_file force row level security;
drop policy if exists tenant_scope on creative_image_file;
create policy tenant_scope on creative_image_file to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on creative_image_file to reinlab_app;
