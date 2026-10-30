-- 探索台 EXPL 第 5 批：地图快照与两版计划书（06 §9、07 契约第 3、7 节）。
--
-- 地图快照由页面上传（矢量底图导出），按「计划修订 + 键」保存：键为 overview
-- 或停留点 id。同一修订同一键重传覆盖。PDF 只用同修订的快照，不拿旧图混装新计划。

create table if not exists explore_snapshot (
  account_id uuid not null,
  dossier_id uuid not null,
  revision integer not null check (revision > 0),
  -- 'overview' 或停留点 id
  key text not null,
  path text not null,
  mime text not null default 'image/png',
  attribution text,
  bytes integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (account_id, dossier_id, revision, key),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_snapshot enable row level security;
alter table explore_snapshot force row level security;
create policy tenant_scope on explore_snapshot to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_snapshot to reinlab_app;
create index if not exists explore_snapshot_revision_idx
  on explore_snapshot(account_id, dossier_id, revision);
