-- 读页回执同样属于「一次运行」：去掉对已退役 mcp_run 的外键，改挂 run。
alter table paper_page_read drop constraint paper_page_read_account_id_dossier_id_run_id_fkey;
alter table paper_page_read add constraint paper_page_read_run_fkey foreign key (run_id) references run(id);
