-- 群研 MVP-1 返工（Claude 验收后，见 design/walkthroughs/swarm-1/RESULTS.md）。
--
-- 三件事：
--  1) 内核事件要记住它属于哪个会话。DSH 的 SDK 会把负责人和队员的会话事件混在同一条
--     通知流里（params.sessionId 有值，只是我们之前丢了），所以不记这一列就分不清
--     「用户说的」「负责人说的」「某个队员说的」，也无法发现冒出来的第二个负责人会话。
--  2) 开跑指令只能发一次：重起栈后「继续」与确认并发，会把同一句「用户已确认计划」
--     发两遍，并且让一个运行同时跑两回合。
--  3) 路线 / 父任务 / 角色 / 显示名由插件建任务、建成员时登记，不靠负责人在描述里写对。

alter table event add column if not exists session_id text;
create index if not exists event_session_idx on event(account_id, run_id, session_id);

alter table swarm_run add column if not exists kickoff_at timestamptz;
alter table swarm_run add column if not exists lead_session text;

comment on column swarm_run.kickoff_at is '开跑指令真正发出去的时刻：只发一次（幂等）';
comment on column swarm_run.lead_session is '这次群研的负责人会话：内核事件按它认人';

-- 插件登记的研究语义：任务挂在哪条路线、父任务是谁、成员是什么角色、显示叫什么。
create table if not exists swarm_meta (
  account_id uuid not null,
  run_id uuid not null,
  kind text not null check (kind in ('task','member')),
  ref_id text not null check (length(ref_id) between 1 and 200),
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (account_id, run_id, kind, ref_id),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_meta enable row level security;
alter table swarm_meta force row level security;
create policy tenant_scope on swarm_meta to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_meta to reinlab_app;
