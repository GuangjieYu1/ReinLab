-- 研究台「群研」MVP-1（design/prd/12-swarm.md、13-swarm-contract.md §1–3）。
--
-- 一个群研运行 = 一个 run 行（负责人会话）+ 这里的一行 swarm_run。执行任务的身份、
-- 依赖、负责人和执行状态仍然只由 DSH 任务板持有；这里只存研究语义（计划版本、
-- 轮次、额度、计时、干预、留言）和控制面自己的事件流，不另建一套任务状态。
--
-- 事件流是「服务端拼好的时间线」：DSH 会话事件由控制面折算成研究事件后追加，
-- 用户干预、留言、用量变化也进同一张表，seq 全局递增，前端只按 seq 排序去重。

create table if not exists swarm_run (
  account_id uuid not null,
  run_id uuid not null references run(id),
  dossier_id uuid not null,
  question text not null,
  state text not null check (state in (
    'clarifying','awaiting_confirm','running','waiting_user','paused',
    'near_limit','finishing','awaiting_review',
    'done','partial','unresolved','cancelled','failed')),
  phase text not null default 'independent' check (phase in ('independent','cross')),
  round integer not null default 0 check (round >= 0),
  plan_version integer not null default 0 check (plan_version >= 0),
  -- 用户确认的额度：最少 4 轮 / 30 分钟（12-swarm.md §3），只做下限校验。
  limit_rounds integer not null default 4 check (limit_rounds >= 4),
  limit_minutes integer not null default 30 check (limit_minutes >= 30),
  -- 活动时长按服务端时钟累计；pause / waiting_user / awaiting_confirm 期间不计时。
  active_ms bigint not null default 0 check (active_ms >= 0),
  active_since timestamptz,
  -- 累计创建的队员数（失败也占名额，名字不复用）。
  members_used integer not null default 0 check (members_used >= 0),
  -- 已经折算到研究事件流里的最后一条 DSH 事件 seq：重放、重启都不会重复折算。
  projected_seq bigint not null default 0 check (projected_seq >= 0),
  state_reason text,
  end_reason text check (end_reason is null or end_reason in
    ('answered','all_blocked','user_finished','limit','cancelled','error')),
  delegation jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, run_id),
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table swarm_run enable row level security;
alter table swarm_run force row level security;
create policy tenant_scope on swarm_run to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_run to reinlab_app;
revoke delete, truncate on swarm_run from reinlab_app;
-- 一个档案同时只有一个没结束的群研运行：重连、重复发起点开的还是这一个。
create unique index if not exists swarm_run_one_open_idx
  on swarm_run(account_id, dossier_id)
  where state not in ('done','partial','unresolved','cancelled','failed');
create index if not exists swarm_run_dossier_idx
  on swarm_run(account_id, dossier_id, created_at desc);

-- 计划：开跑前确认，改方向出新版本。版本号连续，最新一版就是当前计划。
create table if not exists swarm_plan (
  account_id uuid not null,
  run_id uuid not null,
  version integer not null check (version > 0),
  document jsonb not null,
  needs_confirm boolean not null default true,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (account_id, run_id, version),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_plan enable row level security;
alter table swarm_plan force row level security;
create policy tenant_scope on swarm_plan to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_plan to reinlab_app;

-- 研究事件流：快照游标、时间线、SSE 都读它。
create table if not exists swarm_event (
  seq bigserial primary key,
  account_id uuid not null,
  run_id uuid not null,
  dossier_id uuid not null,
  at timestamptz not null default now(),
  type text not null,
  data jsonb not null default '{}',
  source text not null default 'control' check (source in ('dsh','control','user','system')),
  -- 折算自哪一条 DSH 事件。一次 DSH 事件可能折出多条研究事件（负责人名册 + 队员），
  -- 所以这里不建唯一约束：折算和 projected_seq 在同一个事务里推进，天然只折一次。
  source_seq bigint,
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_event enable row level security;
alter table swarm_event force row level security;
create policy tenant_scope on swarm_event to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
-- update 只用来把「这条消息的发送结果」写回同一条目（delivery 是活状态，不是研究事实），
-- 不新增第二行，页面按 seq 排序时同一件事不会出现两遍。
grant select, insert, update on swarm_event to reinlab_app;
revoke delete, truncate on swarm_event from reinlab_app;
-- 事件序号是 bigserial：应用角色要能取号。
grant usage, select on sequence swarm_event_seq_seq to reinlab_app;
create index if not exists swarm_event_run_seq_idx on swarm_event(account_id, run_id, seq);
create index if not exists swarm_event_source_idx on swarm_event(account_id, run_id, source, source_seq);

-- 工具调用 → 事件条目的对应关系：工具结果晚一拍才到，靠它把发送结果写回同一条目。
create table if not exists swarm_call (
  account_id uuid not null,
  run_id uuid not null,
  call_id text not null check (length(call_id) between 1 and 200),
  name text not null,
  bus_seq bigint,
  primary key (account_id, run_id, call_id),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_call enable row level security;
alter table swarm_call force row level security;
create policy tenant_scope on swarm_call to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_call to reinlab_app;

-- 留言板四栏。问题可以指定接收者，回答用 reply_to 配对。
create table if not exists swarm_post (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  run_id uuid not null,
  dossier_id uuid not null,
  col text not null check (col in ('question','finding','help','decision')),
  author text not null,
  body text not null check (length(body) between 1 and 8000),
  at timestamptz not null default now(),
  -- 留言自己的递增序号：页面按它排序，不必和事件 seq 撞车。
  seq bigserial,
  recipient text,
  reply_to uuid references swarm_post(id),
  answered boolean not null default false,
  refs jsonb not null default '{}',
  scope jsonb,
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_post enable row level security;
alter table swarm_post force row level security;
create policy tenant_scope on swarm_post to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_post to reinlab_app;
create index if not exists swarm_post_run_idx on swarm_post(account_id, run_id, at);
-- 留言自己的序号也是序列。
grant usage, select on sequence swarm_post_seq_seq to reinlab_app;

-- 用户干预：进来的动作先记 received，之后每一步都写回真实状态和回执。
create table if not exists swarm_intervention (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  run_id uuid not null,
  dossier_id uuid not null,
  kind text not null check (kind in
    ('mention','redirect','add_member','stop_route','pause','resume','finish','extend')),
  text text,
  target jsonb,
  state text not null check (state in
    ('received','pending_approval','delivered','applied','replied','rejected','failed')),
  approval_id uuid,
  result text,
  at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_intervention enable row level security;
alter table swarm_intervention force row level security;
create policy tenant_scope on swarm_intervention to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_intervention to reinlab_app;
create index if not exists swarm_intervention_run_idx
  on swarm_intervention(account_id, run_id, at);

-- 群研负责人会话的角色。工具授权沿用精读/探索同一张表，真正的边界在容器与插件里。
insert into role_def(id, bench, prompt_ref, model_tier, tool_grants, read_scope, write_targets, steps)
values('bench-swarm','research','roles/bench-swarm.md','strong',
       '{"research_plan":{"risk":"write","permission":"allow"},
         "research_files":{"risk":"write","permission":"allow"},
         "team":{"risk":"write","permission":"allow"}}',
       '{"dossier":"current"}',
       '["team/"]', 200)
on conflict (id) do update set
  prompt_ref=excluded.prompt_ref,
  tool_grants=excluded.tool_grants,
  read_scope=excluded.read_scope,
  write_targets=excluded.write_targets;

-- 会话档位：群研负责人用的是独立一档，不能和精读/档案助手串用（工具配置不同）。
alter table dsh_session drop constraint if exists dsh_session_mode_check;
alter table dsh_session add constraint dsh_session_mode_check
  check (mode in ('read','clarify','assist','explore','swarm'));
alter table run drop constraint if exists run_mode_check;
alter table run add constraint run_mode_check
  check (mode in ('read','clarify','swarm','auto','assist','explore'));
