-- 群研 MVP-3 第二批补修（B12）：用户插话与批卡后的指令要排进负责人的收件箱，
-- 在它的下一个步骤边界送进去，而不是另起一个回合把正在跑的那一轮顶掉。

create table if not exists swarm_inbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  run_id uuid not null,
  -- 送给谁：lead 或某个队员名（成员名在团队里唯一）。
  target text not null default 'lead',
  kind text not null check (kind in ('mention','redirect','instruction','system')),
  text text not null check (length(text) between 1 and 8000),
  intervention_id uuid,
  state text not null default 'pending'
    check (state in ('pending','delivered','applied','failed')),
  reason text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
alter table swarm_inbox enable row level security;
alter table swarm_inbox force row level security;
create policy tenant_scope on swarm_inbox to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_inbox to reinlab_app;
create index if not exists swarm_inbox_pending_idx
  on swarm_inbox(account_id, run_id, target, state) where state = 'pending';
