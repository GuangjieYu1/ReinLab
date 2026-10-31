-- 探索台 EXPL 第二版第 1 批（design/prd/09-explore-v2.md §3、10-explore-v2-contract.md §1–2）。
--
-- 三张表：现场记录（附加事实，独立于计划修订）、修订快照（出发时那一版要留得下来，
-- 供回顾对照与离线包固定引用）、离线包（清单 + 只允许代取清单里列的瓦片/字形）。

-- 现场记录：设备生成的 clientId 是幂等键；更正也是一条新记录，指回原记录，不改原行。
create table if not exists explore_field_event (
  server_id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  dossier_id uuid not null,
  client_id text not null check (length(client_id) between 1 and 100),
  kind text not null check (kind in ('arrived','shot','note','situation','correction')),
  -- 记录当时的停留点与名称：点后来被删了，记录照旧能显示原名
  stop_id text,
  stop_name text,
  plan_revision integer not null check (plan_revision >= 0),
  -- 设备记录的现场时间与 IANA 时区；接收时间另存，不能拿它顶替现场时间
  at timestamptz not null,
  tz text not null check (length(tz) between 1 and 64),
  text text,
  situation text check (situation is null or situation in ('rain','late','crowd','light','other')),
  position jsonb,
  refers_to text,
  correction jsonb,
  received_at timestamptz not null default now(),
  unique (account_id, dossier_id, client_id),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_field_event enable row level security;
alter table explore_field_event force row level security;
create policy tenant_scope on explore_field_event to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on explore_field_event to reinlab_app;
create index if not exists explore_field_event_list_idx
  on explore_field_event(account_id, dossier_id, at, received_at);

-- 修订快照：每次生效的业务批次留一份，出发时的计划与后来批准的版本都还在。
create table if not exists explore_plan_revision (
  account_id uuid not null,
  dossier_id uuid not null,
  revision integer not null check (revision > 0),
  state text not null,
  document jsonb not null,
  created_at timestamptz not null default now(),
  primary key (account_id, dossier_id, revision),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_plan_revision enable row level security;
alter table explore_plan_revision force row level security;
create policy tenant_scope on explore_plan_revision to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on explore_plan_revision to reinlab_app;

-- 离线包：清单固定下来，代取瓦片时只认清单里列的坐标，超上限就拒绝而不是悄悄漏图。
create table if not exists explore_offline_pack (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  dossier_id uuid not null,
  day date not null,
  plan_revision integer not null check (plan_revision > 0),
  detail text not null default 'full' check (detail in ('full','low')),
  manifest jsonb not null,
  -- [{z,x,y}] 与 [{fontstack,range}]：代取的白名单
  tile_list jsonb not null,
  glyph_list jsonb not null,
  tiles_fetched integer not null default 0,
  tile_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_offline_pack enable row level security;
alter table explore_offline_pack force row level security;
create policy tenant_scope on explore_offline_pack to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_offline_pack to reinlab_app;
create index if not exists explore_offline_pack_idx
  on explore_offline_pack(account_id, dossier_id, created_at desc);
