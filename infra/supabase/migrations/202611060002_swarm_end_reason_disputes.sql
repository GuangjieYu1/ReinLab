-- E1：D4「按有争议写入」用的结束原因没在约束里，写库直接失败（卡片已处理、运行没收尾）。
alter table swarm_run drop constraint if exists swarm_run_end_reason_check;
alter table swarm_run add constraint swarm_run_end_reason_check
  check (end_reason is null or end_reason in
    ('answered','all_blocked','user_finished','limit','cancelled','error','user_wrote_disputes'));
