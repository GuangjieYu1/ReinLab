-- 18 广度返工：证据来路（discovery）+ 搜索/引用来路索引。
-- 控制面在转发 search / fetch 时把「见过哪些网址、怎么见到的」记下来，
-- 队员交证据时据此判定 discovery（search / known-url / citation），不靠模型自述。
create table if not exists swarm_source_hit (
  account_id uuid not null,
  run_id uuid not null,
  url text not null,
  kind text not null check (kind in ('search','citation')),
  hits integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (account_id, run_id, url, kind)
);
create index if not exists swarm_source_hit_run_idx on swarm_source_hit (account_id, run_id);
alter table swarm_source_hit enable row level security;
alter table swarm_source_hit force row level security;
create policy tenant_scope on swarm_source_hit to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_source_hit to reinlab_app;

-- 证据的来路：search（搜出来的）/ known-url（早知道直接抓）/ citation（顺着引用找过去的）。
alter table swarm_evidence add column if not exists discovery text
  check (discovery in ('search','known-url','citation'));
