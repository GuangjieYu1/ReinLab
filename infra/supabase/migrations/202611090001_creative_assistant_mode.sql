-- 创作台 1B：设定顾问 / 写作助手的会话跑在控制面里（不进内核容器），
-- 但沿用同一条运行与事件流：页面的侧边会话按 runId 订阅 /v1/kernel/runs/:id/stream。
alter table run drop constraint if exists run_mode_check;
alter table run add constraint run_mode_check
  check (mode in ('read','clarify','swarm','auto','assist','explore','creative'));
