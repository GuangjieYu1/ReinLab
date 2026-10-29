-- 会话绑定的租户、档案、角色和request必须同时属于父运行。
alter table run add unique(account_id,dossier_id,id,role_id,request_id);
alter table os_binding add foreign key(account_id,dossier_id,run_id,logical_role_id,request_id)
 references run(account_id,dossier_id,id,role_id,request_id);
alter table os_binding add check(
 jsonb_typeof(role_options)='object' and
 (role_options->>'dossierId') is not null and role_options->>'dossierId'=dossier_id::text and
 jsonb_typeof(role_options->'role')='object' and
 (role_options->'role'->>'id') is not null and
 role_options->'role'->>'id' ~ '^[a-z][a-z0-9-]{0,27}--[a-f0-9]{32}$' and
 left(role_options->'role'->>'id',length(left(logical_role_id,28))+2)=left(logical_role_id,28)||'--'
);
