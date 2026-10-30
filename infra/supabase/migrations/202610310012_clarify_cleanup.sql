-- 澄清阶段的会话在正式精读开始后就没有意义了：早该收尾。这里清掉历史残留，
-- 之后由开始正式精读时的取消流程持续保证（见 service.submit）。
update run set state='cancelled', ended_at=coalesce(ended_at, now())
 where mode='clarify' and state='waiting'
   and created_at < now() - interval '30 minutes';

update approval set state='expired'
 where state='pending'
   and run_id in (select id from run where state='cancelled');
