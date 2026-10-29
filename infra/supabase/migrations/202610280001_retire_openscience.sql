-- OpenScience 退役：删掉旧内核的表与绑定列。
--
-- 新内核（DSH）只用到：account/dossier/run/event/approval/dsh_*/paper_*/usage_record/
-- budget_*/card_decision/http_request/role_def。其余都是 OpenScience 时代的
-- 绑定、bench 发布、MCP 能力、promotion、memory、artifact 等，运行路径上已经没有代码读它们。

-- 新内核仍然会建 run.role_id='research-read'，这里保证干净库也有这行。
insert into role_def(id, bench, prompt_ref, model_tier, tool_grants, read_scope, write_targets, steps)
values (
  'research-read', 'research', 'roles/research-read.md', 'strong',
  '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 48
)
on conflict (id) do nothing;

-- 绑定列：内核卡片不再区分 os 会话。
alter table approval drop column if exists os_request_id;
alter table approval drop column if exists os_session_id;
alter table run drop column if exists os_session_id;
alter table run drop column if exists os_run_id;

drop table if exists mcp_anonymous_denial cascade;
drop table if exists mcp_invocation cascade;
drop table if exists mcp_credential cascade;
drop table if exists mcp_run_revocation cascade;
drop table if exists mcp_run cascade;
drop table if exists mcp_approval cascade;
drop table if exists os_observation cascade;
drop table if exists os_usage cascade;
drop table if exists os_binding cascade;
drop table if exists harness_proposal cascade;
drop table if exists run_harness cascade;
drop table if exists bench_effective cascade;
drop table if exists bench_tuning cascade;
drop table if exists bench_version cascade;
drop table if exists read_candidate cascade;
drop table if exists read_clarification cascade;
drop table if exists read_clarify_run cascade;
drop table if exists clarify_model_request cascade;
drop table if exists runtime_model_request cascade;
drop table if exists promotion_decision cascade;
drop table if exists promotion cascade;
drop table if exists memory_item cascade;
drop table if exists thread cascade;
drop table if exists gate cascade;
drop table if exists dossier_override cascade;
drop table if exists artifact cascade;
drop table if exists delegation cascade;

-- 账户机器与凭据库：OpenScience 时代的容器/机器管理，新内核不再使用。
drop table if exists credential_preflight_reconciliation;
drop table if exists account_machine_operation;
drop table if exists account_machine_secret;
drop table if exists credential;
drop table if exists account_machine;
