-- 档案的删除/归档确认卡不属于任何运行，run_id 必须允许为空。
alter table approval alter column run_id drop not null;
