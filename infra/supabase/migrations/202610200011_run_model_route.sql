-- 旧记录不猜模型；缺绑定必须显式重新确认，不能执行时用新环境变量填补。
alter table run_harness add column model_route text check(model_route ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._:/-]+$');
