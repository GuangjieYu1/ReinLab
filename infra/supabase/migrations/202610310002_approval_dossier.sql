-- 删除/归档确认卡要按档案找：approval 原来只有 run_id。
alter table approval add column if not exists dossier_id uuid;
create index if not exists approval_dossier_idx
  on approval(account_id, dossier_id, state);
