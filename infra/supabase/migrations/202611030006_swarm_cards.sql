-- 群研 MVP-3 第二批：收件箱四种新卡（design/prd/13-swarm-contract.md §5）。
-- 卡片仍然走 approval 表：kind 加四种，内容按契约放在 effects[0]。

alter table approval drop constraint if exists approval_kind_check;
alter table approval add constraint approval_kind_check check (kind in (
  'permission','question','gate','budget','compute','anim',
  'swarm_add_member','swarm_extend','swarm_scope','swarm_divergence'
));

-- 用户改方向之后负责人交上来的新版本计划：不用再等一次确认（除非问题范围变了）。
alter table swarm_run add column if not exists redirect_pending boolean not null default false;

-- 页面按「这个运行还有哪些待处理卡」查，加个索引。
create index if not exists approval_run_pending_idx
  on approval(account_id, run_id, state) where state = 'pending';
