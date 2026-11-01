-- 探索台 EXPL 第二版第 3 批：照片、对时、回顾（design/prd/09-explore-v2.md §5–6、10-explore-v2-contract.md §2.3–2.5）。
--
-- 原图只存不改：文件放在档案自己的 photos/<photoId>/ 下，库里记路径、摘要与 EXIF 原文；
-- 照片是附加事实，不改计划。AI 挑片标记和用户精选分两列存，谁都不覆盖谁。

create table if not exists explore_photo_batch (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  dossier_id uuid not null,
  files integer not null default 0,
  bytes bigint not null default 0,
  unsupported jsonb not null default '[]'::jsonb,
  uploaded integer not null default 0,
  processed integer not null default 0,
  failed integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_photo_batch enable row level security;
alter table explore_photo_batch force row level security;
create policy tenant_scope on explore_photo_batch to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_photo_batch to reinlab_app;
create index if not exists explore_photo_batch_idx
  on explore_photo_batch(account_id, dossier_id, created_at desc);

-- 一次 tus 上传 = 一个文件；offset 是服务端权威的已收字节数（续传从这里接着传）。
create table if not exists explore_photo_upload (
  id text primary key,
  account_id uuid not null,
  dossier_id uuid not null,
  batch_id uuid not null,
  file_name text not null,
  bytes bigint not null,
  last_modified bigint,
  length bigint not null check (length >= 0),
  -- 服务端权威的已收字节数（offset 是保留字，换个名字）
  received_bytes bigint not null default 0 check (received_bytes >= 0),
  state text not null default 'open' check (state in ('open','done','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_photo_upload enable row level security;
alter table explore_photo_upload force row level security;
create policy tenant_scope on explore_photo_upload to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_photo_upload to reinlab_app;

-- 相机组：同一台机身的照片共用一个时间偏差；序列号只用来分辨机型，不进接口。
create table if not exists explore_camera_group (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  dossier_id uuid not null,
  label text not null,
  fingerprint text not null,
  timezone text,
  timezone_basis text check (timezone_basis is null or timezone_basis in ('offset_tag','plan','user')),
  offset_sec integer,
  residual_sec integer,
  status text not null default 'auto' check (status in ('auto','needs_anchor','inconsistent','confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (account_id, dossier_id) references dossier(account_id, id),
  unique (account_id, dossier_id, fingerprint)
);
alter table explore_camera_group enable row level security;
alter table explore_camera_group force row level security;
create policy tenant_scope on explore_camera_group to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_camera_group to reinlab_app;

create table if not exists explore_photo (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  dossier_id uuid not null,
  batch_id uuid not null,
  file_name text not null,
  bytes bigint not null,
  sha256 text not null,
  status text not null default 'processing' check (status in ('uploading','processing','ready','failed')),
  error text,
  original_path text,
  thumb_path text,
  preview_path text,
  exif jsonb not null default '{}'::jsonb,
  -- EXIF 原始时间文本（不改写）、按已确认时区解释后的时刻、加偏差后的时刻
  taken_raw text,
  taken_ts timestamptz,
  corrected_ts timestamptz,
  time_basis text check (time_basis is null or time_basis in ('offset_tag','gps','clock_fix','unknown')),
  time_trust text check (time_trust is null or time_trust in ('certain','estimated','pending')),
  camera_group_id uuid,
  placement_stop_id text,
  placement_basis text check (placement_basis is null or placement_basis in ('gps','event','plan_time','manual','unplanned','pending')),
  placement_lng double precision,
  placement_lat double precision,
  placement_manual boolean not null default false,
  ai_mark text check (ai_mark is null or ai_mark in ('recommend','alternate')),
  ai_reason text,
  ai_inspected text not null default 'none' check (ai_inspected in ('none','preview','detail')),
  picked boolean not null default false,
  stats jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_photo enable row level security;
alter table explore_photo force row level security;
create policy tenant_scope on explore_photo to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_photo to reinlab_app;
-- 同一份档案里同内容只留一张（删掉的不占名额）；同名不同内容照常并存。
create unique index if not exists explore_photo_digest_idx
  on explore_photo(account_id, dossier_id, sha256) where deleted_at is null;
create index if not exists explore_photo_list_idx
  on explore_photo(account_id, dossier_id, created_at) where deleted_at is null;
create index if not exists explore_photo_group_idx
  on explore_photo(account_id, dossier_id, camera_group_id) where deleted_at is null;

-- 对时锚点：这张照片 = 这个打卡 / 这个已知时刻。组内多个独立锚点取中位数。
create table if not exists explore_clock_anchor (
  account_id uuid not null,
  dossier_id uuid not null,
  group_id uuid not null,
  photo_id uuid not null,
  event_client_id text,
  at timestamptz,
  delta_sec integer not null,
  created_at timestamptz not null default now(),
  primary key (account_id, dossier_id, group_id, photo_id),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_clock_anchor enable row level security;
alter table explore_clock_anchor force row level security;
create policy tenant_scope on explore_clock_anchor to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, delete on explore_clock_anchor to reinlab_app;

-- 游记：按修订保存，旧版本都在（回顾对照与导出用）。
create table if not exists explore_travelogue (
  account_id uuid not null,
  dossier_id uuid not null,
  revision integer not null check (revision > 0),
  markdown text not null,
  photo_ids jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (account_id, dossier_id, revision),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_travelogue enable row level security;
alter table explore_travelogue force row level security;
create policy tenant_scope on explore_travelogue to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on explore_travelogue to reinlab_app;

-- 上传完成时还不知道是哪个账户（tus 只给上传 id）：用 definer 函数查归属，
-- 和会话表同一套写法——表本身仍只对应用角色按账户开放。
create or replace function reinlab_photo_upload_owner(upload_key text)
returns table(acc uuid, dos uuid)
language sql
security definer
set search_path = public
as $$
  select u.account_id, u.dossier_id from explore_photo_upload u where u.id = upload_key;
$$;
revoke all on function reinlab_photo_upload_owner(text) from public;
grant execute on function reinlab_photo_upload_owner(text) to reinlab_app;

-- 地点经验：账户级资料新增一种类型（和模特 / 器材同一套 /v1/profiles）。
alter table account_profile drop constraint if exists account_profile_type_check;
alter table account_profile add constraint account_profile_type_check
  check (type in ('model','gear','place'));
