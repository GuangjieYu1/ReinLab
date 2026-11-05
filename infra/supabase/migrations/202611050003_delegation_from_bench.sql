-- B17：委托要记住源台（之前只存了 to_bench，fromBench 返回 "undefined"）。
alter table delegation add column if not exists from_bench text not null default 'exploration';

-- 同一份委托只对应一张结果卡：以后按 (account, run, effect_key) 唯一，靠 effect_key 去重。
create index if not exists delegation_result_key_idx
  on approval(account_id, run_id, effect_key) where kind = 'delegation_result';
