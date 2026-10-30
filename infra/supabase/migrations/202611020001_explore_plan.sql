-- 探索台 EXPL（design/prd/07-explore-contract.md 第 1～4 节）：计划与画布持久化、修订、操作记录、授权。
--
-- 一份探索档案一份当前计划；计划正文（含画布）整份存在 document 里，
-- revision 只在生效的业务批次上 +1（一批只加一次），页面写操作都带 baseRevision。

create table if not exists explore_plan (
  account_id uuid not null references account(id),
  dossier_id uuid not null references dossier(id),
  revision integer not null default 1 check (revision > 0),
  state text not null default 'draft' check (state in ('draft','ready','finished','cancelled')),
  document jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, dossier_id),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_plan enable row level security;
alter table explore_plan force row level security;
create policy tenant_scope on explore_plan to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_plan to reinlab_app;

-- 操作记录：一行一次生效的动作；inverse 是可撤回画布动作的反向操作。
create table if not exists explore_op (
  seq bigserial primary key,
  account_id uuid not null,
  dossier_id uuid not null,
  revision integer not null,
  actor text not null check (actor in ('page','agent')),
  op text not null,
  summary text not null,
  detail jsonb not null default '{}'::jsonb,
  inverse jsonb,
  undone_by bigint,
  created_at timestamptz not null default now(),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_op enable row level security;
alter table explore_op force row level security;
create policy tenant_scope on explore_op to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on explore_op to reinlab_app;
grant usage, select on sequence explore_op_seq_seq to reinlab_app;
create index if not exists explore_op_dossier_idx on explore_op(account_id, dossier_id, seq desc);
create index if not exists explore_op_canvas_idx
  on explore_op(account_id, dossier_id, seq desc) where inverse is not null and undone_by is null;

-- 一条用户消息只能用一次授权：用完记账，重复使用回到计划修改卡。
create table if not exists explore_authorization (
  account_id uuid not null,
  dossier_id uuid not null,
  message_id text not null,
  approval_id uuid,
  used_at timestamptz not null default now(),
  primary key (account_id, dossier_id, message_id),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_authorization enable row level security;
alter table explore_authorization force row level security;
create policy tenant_scope on explore_authorization to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on explore_authorization to reinlab_app;

-- 账户时区：天气检查按它每天 08/16/23 跑（第 6 节）；没设就是 null，不猜。
alter table account add column if not exists timezone text;
alter table account drop constraint if exists account_timezone_check;
alter table account add constraint account_timezone_check
  check (timezone is null or timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$');

-- 探索台的对话运行：run 模式集合加入 explore，并给它一个只带探索工具的角色。
alter table run drop constraint if exists run_mode_check;
alter table run add constraint run_mode_check
  check (mode in ('read','clarify','swarm','auto','assist','explore'));

insert into role_def(id,bench,prompt_ref,model_tier,tool_grants,read_scope,write_targets,steps)
values('bench-explore','exploration','roles/bench-explore.md','mid',
       '{"explore_read":{"risk":"read","permission":"allow"},
         "explore_write":{"risk":"write","permission":"allow"},
         "explore_confirm":{"risk":"write","permission":"ask"}}',
       '{"dossier":"current"}',
       '[]', 40)
on conflict (id) do update set
  prompt_ref=excluded.prompt_ref,
  tool_grants=excluded.tool_grants,
  read_scope=excluded.read_scope;
