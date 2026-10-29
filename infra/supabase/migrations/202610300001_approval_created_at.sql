-- 等待不再靠插件轮询判过期，改由控制面按业务时限裁定。
-- 审批行之前没有时间戳，无法判断「等了多久」，先补上。
alter table approval add column if not exists created_at timestamptz not null default now();

-- 按时间收尾待处理请求时按账户扫。
create index if not exists approval_pending_created on approval(account_id, created_at)
  where state = 'pending';
