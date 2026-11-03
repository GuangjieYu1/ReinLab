-- B14：把「排进收件箱」和「对方真的看到」分开记。
-- queued = 已排进对方收件箱；delivered = 对方会话里出现了这条 user/message。
alter table swarm_inbox drop constraint if exists swarm_inbox_state_check;
alter table swarm_inbox add constraint swarm_inbox_state_check
  check (state in ('pending','queued','delivered','applied','failed'));

-- 按卡认人：加人卡建出来的成员会带上这张卡的 id（research_spawn 的 add_card）。
comment on column swarm_meta.data is '成员登记：role / label / routeId / sessionId / cardId（按加人卡建的人带卡 id）';
