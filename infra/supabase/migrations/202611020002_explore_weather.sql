-- 探索台 EXPL 第 2 批：逐时天气快照（06 §5.2、07 契约第 1、2 节）。
--
-- 每个「停留点 / 目的地」留最近一次取到的预报（附带取数时间、来源和那一天那一段的
-- 签名）；页面、Agent、以后的后台检查与 PDF 都从这里读同一份，不各取各的。

create table if not exists explore_weather (
  account_id uuid not null,
  dossier_id uuid not null,
  -- 'destination' 或停留点 id
  key text not null,
  at jsonb not null,
  -- 这一份对应哪一天、哪一段时段：时段改了就得重新取。
  signature text not null,
  state text not null check (state in ('ok','out_of_range','failed')),
  hours jsonb not null default '[]'::jsonb,
  from_date text,
  source jsonb not null default '{}'::jsonb,
  reason text,
  fetched_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (account_id, dossier_id, key),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_weather enable row level security;
alter table explore_weather force row level security;
create policy tenant_scope on explore_weather to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_weather to reinlab_app;
