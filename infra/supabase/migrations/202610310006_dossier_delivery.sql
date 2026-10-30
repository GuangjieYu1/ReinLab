-- 第 8 节：把档案操作事实投递给会话。每个会话记住投递到哪个事件，重启不重复。
alter table dsh_session add column if not exists user_op_cursor bigint not null default 0;
