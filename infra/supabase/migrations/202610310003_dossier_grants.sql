-- 新表要给应用角色授权（其余档案表同样走 grant，不开 RLS 例外）。
grant select,insert,update on dossier_resume to reinlab_app;
grant select,insert,update,delete on dossier_artifact to reinlab_app;
