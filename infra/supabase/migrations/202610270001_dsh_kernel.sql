-- DSH 内核的业务记录：会话、回合与用量。
-- 不预留预算、不冻结账户：用量记录与任务状态彼此独立。
create table dsh_session (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id),
  dossier_id uuid not null,
  session_id text not null check (session_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  home_path text not null check (length(home_path) between 1 and 4096),
  lease_run_id uuid,
  lease_state text not null default 'active' check (lease_state in ('active','unconfirmed')),
  leased_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, dossier_id, session_id)
);

create table dsh_turn (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id),
  dossier_id uuid not null,
  run_id uuid not null references run(id),
  session_id text not null,
  message_id text,
  state text not null check (state in ('running','completed','failed','cancelled','cancel_unconfirmed')),
  error_code text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table usage_record (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id),
  dossier_id uuid not null,
  run_id uuid not null references run(id),
  provider text not null,
  model text not null,
  known boolean not null,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cache_read_tokens integer check (cache_read_tokens is null or cache_read_tokens >= 0),
  cache_write_tokens integer check (cache_write_tokens is null or cache_write_tokens >= 0),
  reasoning_tokens integer check (reasoning_tokens is null or reasoning_tokens >= 0),
  cost_cny numeric(14,6) check (cost_cny is null or cost_cny >= 0),
  recorded_at timestamptz not null default now(),
  -- 未知用量绝不写成 0：缺用量时计数与费用都必须为空。
  check (known or (input_tokens is null and output_tokens is null and cost_cny is null))
);

-- 单次审批：一次具体动作一个键，用掉即作废，重复提交不再执行。
alter table approval add column effect_key text;
alter table approval add column consumed_at timestamptz;
create unique index approval_effect_once on approval(account_id, run_id, effect_key) where effect_key is not null;

alter table dsh_session enable row level security;
alter table dsh_session force row level security;
create policy tenant_scope on dsh_session to reinlab_app using (account_id = nullif(current_setting('app.account_id',true),'')::uuid) with check (account_id = nullif(current_setting('app.account_id',true),'')::uuid);
grant select, insert, update on dsh_session to reinlab_app;
revoke delete, truncate on dsh_session from reinlab_app;
create index dsh_session_dossier on dsh_session(account_id, dossier_id);
create index dsh_session_lease on dsh_session(account_id, lease_run_id);

alter table dsh_turn enable row level security;
alter table dsh_turn force row level security;
create policy tenant_scope on dsh_turn to reinlab_app using (account_id = nullif(current_setting('app.account_id',true),'')::uuid) with check (account_id = nullif(current_setting('app.account_id',true),'')::uuid);
grant select, insert, update on dsh_turn to reinlab_app;
revoke delete, truncate on dsh_turn from reinlab_app;
create index dsh_turn_run on dsh_turn(account_id, run_id);

alter table usage_record enable row level security;
alter table usage_record force row level security;
create policy tenant_scope on usage_record to reinlab_app using (account_id = nullif(current_setting('app.account_id',true),'')::uuid) with check (account_id = nullif(current_setting('app.account_id',true),'')::uuid);
grant select, insert on usage_record to reinlab_app;
revoke update, delete, truncate on usage_record from reinlab_app;
create index usage_record_run on usage_record(account_id, run_id);
