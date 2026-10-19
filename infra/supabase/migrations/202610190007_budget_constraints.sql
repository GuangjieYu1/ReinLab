REVOKE UPDATE ON budget_estimate FROM reinlab_app;
ALTER TABLE budget_allocation ADD UNIQUE(account_id,period,dossier_id,run_id,id);
ALTER TABLE budget_hold ADD FOREIGN KEY(account_id,period,dossier_id,run_id,allocation_id) REFERENCES budget_allocation(account_id,period,dossier_id,run_id,id);
