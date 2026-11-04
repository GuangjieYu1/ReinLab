-- B15：一条待送消息只投一次。取的时候就领走（handed），插件 steer 成功后再由控制面确认；
-- 同一个消息 id 在插件侧（内存去重）与控制面侧（状态机）都只放行一次。

alter table swarm_inbox drop constraint if exists swarm_inbox_state_check;
alter table swarm_inbox add constraint swarm_inbox_state_check
  check (state in ('pending','queued','handed','delivered','applied','failed'));

-- 领走的时间：便于看「交给这一步」与「会话里出现」的时间差。
alter table swarm_inbox add column if not exists handed_at timestamptz;
