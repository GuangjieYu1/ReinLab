-- 探索台 EXPL 第 4 批：账户级模特/器材、档案参考图（06 §6、§8；07 契约第 1、2、3 节）。
--
-- 资料独立于探索档案、按账户共享：计划选择时保存当时那一版快照，
-- 资料后来改了或删了，旧计划仍按快照显示（用户已确认该范围）。

create table if not exists account_profile (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id),
  type text not null check (type in ('model','gear')),
  revision integer not null default 1 check (revision > 0),
  data jsonb not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table account_profile enable row level security;
alter table account_profile force row level security;
create policy tenant_scope on account_profile to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on account_profile to reinlab_app;
create index if not exists account_profile_list_idx
  on account_profile(account_id, type, created_at desc);

-- 参考图：上传或网图都在这张表；网图另存一份副本（image_path），拿不到图就只留来源。
create table if not exists explore_ref (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  dossier_id uuid not null,
  origin text not null check (origin in ('upload','web')),
  kind text not null check (kind in ('same-spot','style')),
  -- 服务器上的副本（本人档案内可见）；拿不到图就是 null，页面上只显示来源卡
  image_path text,
  mime text,
  width integer,
  height integer,
  page_url text,
  page_title text,
  author text,
  platform text,
  taken_at text,
  stop_id uuid,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_ref enable row level security;
alter table explore_ref force row level security;
create policy tenant_scope on explore_ref to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_ref to reinlab_app;
create index if not exists explore_ref_dossier_idx
  on explore_ref(account_id, dossier_id, created_at desc) where removed_at is null;
