-- 创作台 1A：世界观存储、操作批次、事件流、版本、pgRouting 路网（design/prd/19-creative.md §3 §4，20-creative-contract.md §1–§3）。
--
-- 路网用本机 Postgres 已有的 pgRouting：本机 Supabase 里 postgis 3.3.7 / pgrouting 3.4.1
-- 状态是「可用、未启用」，这里直接启用即可，不用另装。
-- 故事生效时间和作者修订版本分开：edge.valid_from / valid_to 是故事分钟，version 是修订号。

create extension if not exists postgis;
create extension if not exists pgrouting;

-- 一个创作台档案就是一个世界观；document 是整份账本（实体、事件、规则、改造层、提议）。
create table if not exists creative_world (
  account_id uuid not null references account(id) on delete cascade,
  dossier_id uuid not null references dossier(id) on delete cascade,
  revision integer not null default 1,
  document jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, dossier_id)
);

-- 每个生效批次一行：页面按 seq 取增量，也是「刷新以后都还在」的凭据。
create table if not exists creative_op (
  seq bigserial primary key,
  account_id uuid not null,
  dossier_id uuid not null,
  revision integer not null,
  actor text not null,
  op text not null,
  summary text not null,
  detail jsonb not null,
  at timestamptz not null default now()
);
create index if not exists creative_op_world_idx on creative_op(account_id, dossier_id, seq);

-- 契约 §3 的六种事件；seq 是快照里的 cursor，断线按 after= 续。
create table if not exists creative_event (
  seq bigserial primary key,
  account_id uuid not null,
  dossier_id uuid not null,
  type text not null,
  data jsonb not null,
  at timestamptz not null default now()
);
create index if not exists creative_event_world_idx on creative_event(account_id, dossier_id, seq);

-- 最近一次检查结果：快照直接带它，页面不用自己算。
create table if not exists creative_check (
  account_id uuid not null,
  dossier_id uuid not null,
  revision integer not null,
  run jsonb not null,
  at timestamptz not null default now(),
  primary key (account_id, dossier_id)
);

-- 版本：1A 只要存得下取得到（界面在 1C），world 存整份快照，旧版照样能看。
create table if not exists creative_version (
  account_id uuid not null,
  dossier_id uuid not null,
  n integer not null,
  summary text not null,
  changes integer not null default 0,
  revision integer not null default 0,
  world jsonb not null,
  at timestamptz not null default now(),
  primary key (account_id, dossier_id, n)
);

-- pgRouting 边表。source / target 是节点 key：OSM 用真实 node id，Azgaar 与手绘用坐标哈希。
-- cost 不落库：同一段路骑马和步行耗时不同，按交通方式在查询时现算（见 creative/routing.ts）。
create table if not exists creative_edge (
  id bigserial primary key,
  account_id uuid not null,
  dossier_id uuid not null,
  source bigint not null,
  target bigint not null,
  geom geometry(LineString, 4326) not null,
  length_km double precision not null,
  road_class text,
  name text,
  network text not null default 'road',
  oneway boolean not null default false,
  passable boolean not null default true,
  valid_from integer,
  valid_to integer,
  kind text not null,
  edit_id text,
  osm_type text,
  osm_id bigint,
  version integer not null default 1,
  imported_at timestamptz not null default now()
);
create index if not exists creative_edge_world_idx on creative_edge(account_id, dossier_id, kind);
create index if not exists creative_edge_osm_idx on creative_edge(account_id, dossier_id, osm_id);
create index if not exists creative_edge_from_idx on creative_edge(account_id, dossier_id, source);
create index if not exists creative_edge_to_idx on creative_edge(account_id, dossier_id, target);
create index if not exists creative_edge_geom_idx on creative_edge using gist (geom);

-- Azgaar 上传：1A 只存这一份文本与它解析出来的结果，够复现和重导。
create table if not exists creative_asset (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id) on delete cascade,
  dossier_id uuid not null references dossier(id) on delete cascade,
  name text not null,
  format text not null,
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists creative_asset_world_idx on creative_asset(account_id, dossier_id, created_at desc);

alter table creative_world enable row level security;
alter table creative_world force row level security;
create policy tenant_scope on creative_world to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update, delete on creative_world to reinlab_app;

alter table creative_op enable row level security;
alter table creative_op force row level security;
create policy tenant_scope on creative_op to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on creative_op to reinlab_app;
grant usage, select on sequence creative_op_seq_seq to reinlab_app;

alter table creative_event enable row level security;
alter table creative_event force row level security;
create policy tenant_scope on creative_event to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on creative_event to reinlab_app;
grant usage, select on sequence creative_event_seq_seq to reinlab_app;

alter table creative_check enable row level security;
alter table creative_check force row level security;
create policy tenant_scope on creative_check to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on creative_check to reinlab_app;

alter table creative_version enable row level security;
alter table creative_version force row level security;
create policy tenant_scope on creative_version to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on creative_version to reinlab_app;

alter table creative_asset enable row level security;
alter table creative_asset force row level security;
create policy tenant_scope on creative_asset to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on creative_asset to reinlab_app;

-- 边表只由控制面写；删除留给重导（1A 一块区域一份来源）。
alter table creative_edge enable row level security;
alter table creative_edge force row level security;
create policy tenant_scope on creative_edge to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update, delete on creative_edge to reinlab_app;
grant usage, select on sequence creative_edge_id_seq to reinlab_app;
