-- 会话要记住它是哪一档起的：精读和档案助手不能复用同一个会话的工具配置。
alter table dsh_session add column if not exists mode text not null default 'read';
