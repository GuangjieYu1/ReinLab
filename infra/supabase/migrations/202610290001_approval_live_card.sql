-- 同一动作的「有效卡」只有一张：过期/决定过的卡不该继续占着这个位置，否则
-- 过期以后再要审批只能拿回那张旧卡，模型接到 409 就卡在那里。
drop index if exists approval_effect_once;
create unique index approval_effect_once on approval(account_id, run_id, effect_key)
  where effect_key is not null and state = 'pending';

-- 按「当前有效卡」查是最常见的一次查询：过期之后照样只返回 pending 那一张。
create index if not exists approval_run_pending on approval(account_id, run_id, effect_key)
  where state = 'pending';
