-- 17 返工：黑板减负的读游标 + 成稿的 narrative。

-- 每个成员「上次读到哪个版本」：默认返回自上次读取以来的增量（按成员记）。
create table if not exists swarm_cursor (
  account_id uuid not null,
  run_id uuid not null,
  member text not null,
  claim_version integer not null default 0,
  -- 增量按「上次读到的时间点」算：版本号是每条结论各自的，不能当全局游标。
  seen_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (account_id, run_id, member)
);
alter table swarm_cursor enable row level security;
alter table swarm_cursor force row level security;
create policy tenant_scope on swarm_cursor to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_cursor to reinlab_app;

-- 成稿（契约 13 §2 report 新增 narrative 字段）：负责人写的一份贯穿全局的报告。
alter table swarm_run add column if not exists narrative text;
alter table swarm_run add column if not exists narrative_at timestamptz;
