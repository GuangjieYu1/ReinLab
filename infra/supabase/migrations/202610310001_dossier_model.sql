-- 地基第 4 项：七台通用档案（design/prd/03-dossier-contract.md 第 1 节）

alter table dossier
  add column if not exists kind text not null default 'workspace',
  add column if not exists intent text,
  add column if not exists name_source text not null default 'placeholder',
  add column if not exists lifecycle text not null default 'active',
  add column if not exists deletion text not null default 'none',
  add column if not exists deleted_at timestamptz,
  add column if not exists version integer not null default 1,
  add column if not exists last_activity_at timestamptz not null default now(),
  add column if not exists progress text;

alter table dossier drop constraint if exists dossier_kind_check;
alter table dossier drop constraint if exists dossier_name_source_check;
alter table dossier drop constraint if exists dossier_lifecycle_check;
alter table dossier drop constraint if exists dossier_deletion_check;

alter table dossier
  add constraint dossier_kind_check check (kind in ('reading','topic','workspace','learning')),
  add constraint dossier_name_source_check check (name_source in ('user','paper','intent','placeholder')),
  add constraint dossier_lifecycle_check check (lifecycle in ('active','completed','archived')),
  add constraint dossier_deletion_check check (deletion in ('none','stopping','deleted'));

-- 现有归档状态迁到 lifecycle；archived_at 继续保留并双写，旧代码不受影响。
update dossier set lifecycle='archived' where archived_at is not null and lifecycle='active';

-- 研究台的旧档案是「新的精读」：默认按 reading 归类，等工作面显式写 kind 时再纠正。
update dossier set kind='reading' where bench='research' and kind='workspace';

create index if not exists dossier_account_activity_idx
  on dossier(account_id, last_activity_at desc);

-- 每个账户在这份档案的上次位置
create table if not exists dossier_resume (
  account_id uuid not null references account(id),
  dossier_id uuid not null references dossier(id),
  face text not null,
  anchor text,
  mode text,
  updated_at timestamptz not null default now(),
  primary key (account_id, dossier_id)
);

-- 成果关联：论文/讲解层/发现卡/课程/文件都挂在这里；只解除关联，不删原件。
create table if not exists dossier_artifact (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id),
  dossier_id uuid not null references dossier(id),
  kind text not null,
  title text not null,
  run_id uuid,
  version integer not null default 1,
  status text not null default 'available',
  open jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (account_id, dossier_id, kind, id)
);

create index if not exists dossier_artifact_dossier_idx
  on dossier_artifact(account_id, dossier_id, created_at desc);
create index if not exists dossier_artifact_kind_idx
  on dossier_artifact(account_id, dossier_id, kind);

-- 操作记录：与业务动作同一事务写 event（kind='user_op'），这里只需要查询索引。
create index if not exists event_user_op_idx
  on event(account_id, dossier_id, seq) where kind='user_op';
