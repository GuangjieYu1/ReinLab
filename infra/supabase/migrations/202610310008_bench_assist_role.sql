-- 非研究台的最小侧边会话：一个只带档案工具的通用角色，七个台共用。
insert into role_def(id,bench,prompt_ref,model_tier,tool_grants,read_scope,write_targets,steps)
values('bench-assist','curriculum','roles/bench-assist.md','mid',
       '{"dossier_read":{"risk":"read","permission":"allow"},
         "dossier_write":{"risk":"write","permission":"ask"},
         "dossier_delete":{"risk":"write","permission":"ask"},
         "card_answer":{"risk":"write","permission":"ask"}}',
       '{"dossier":"current"}',
       '[]', 12)
on conflict (id) do update set
  prompt_ref=excluded.prompt_ref,
  tool_grants=excluded.tool_grants,
  read_scope=excluded.read_scope;
