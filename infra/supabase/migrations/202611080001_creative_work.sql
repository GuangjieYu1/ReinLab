-- 创作台 1B：作品与任务（design/prd/20-creative-contract.md §5.1、§5.2）。
--
-- 作品是世界观里的对象，不另开档案；一部作品的整份内容（大纲、章、场、正文）放一行 jsonb，
-- 改动走自己的 revision（WorkOp 原子批次），和世界观的 revision 分开。
-- 导入 / 生成 / 助手任务另存一行：页面按 jobId 查状态，进度和结果走事件。

create table if not exists creative_work (
  account_id uuid not null references account(id) on delete cascade,
  dossier_id uuid not null references dossier(id) on delete cascade,
  work_id uuid not null,
  revision integer not null default 1,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, dossier_id, work_id)
);
create index if not exists creative_work_world_idx on creative_work(account_id, dossier_id, created_at);

create table if not exists creative_job (
  account_id uuid not null references account(id) on delete cascade,
  dossier_id uuid not null references dossier(id) on delete cascade,
  id uuid not null,
  work_id uuid,
  kind text not null,
  state text not null,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, dossier_id, id)
);
create index if not exists creative_job_work_idx on creative_job(account_id, dossier_id, work_id, updated_at desc);

alter table creative_work enable row level security;
alter table creative_work force row level security;
create policy tenant_scope on creative_work to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update, delete on creative_work to reinlab_app;

alter table creative_job enable row level security;
alter table creative_job force row level security;
create policy tenant_scope on creative_job to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update, delete on creative_job to reinlab_app;
