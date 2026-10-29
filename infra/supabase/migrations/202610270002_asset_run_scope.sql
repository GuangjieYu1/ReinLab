-- DSH 内核不再经过旧的能力层：论文资产与读页回执属于「一次运行」，不再要求
-- 运行存在 mcp_run（旧的 capability 快照）。保留对 run 的引用，账户/档案仍由 RLS 与列约束保证。
alter table paper_asset drop constraint paper_asset_account_id_dossier_id_run_id_fkey;
alter table paper_asset add constraint paper_asset_run_fkey foreign key (run_id) references run(id);
