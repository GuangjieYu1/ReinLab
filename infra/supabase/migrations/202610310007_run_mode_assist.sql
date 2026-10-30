-- 模式集合加入 assist（原集合 read/swarm/auto，另有 clarify 在用）。
alter table run drop constraint if exists run_mode_check;
alter table run add constraint run_mode_check
  check (mode in ('read','clarify','swarm','auto','assist'));
