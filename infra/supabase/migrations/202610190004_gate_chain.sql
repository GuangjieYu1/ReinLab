-- Successors and review evidence stay in the same account and dossier.
ALTER TABLE gate ADD UNIQUE(account_id,dossier_id,id);
ALTER TABLE gate ADD COLUMN predecessor_id uuid;
ALTER TABLE gate ADD COLUMN review_artifact_id uuid;
ALTER TABLE gate ADD CONSTRAINT gate_predecessor_scope FOREIGN KEY(account_id,dossier_id,predecessor_id) REFERENCES gate(account_id,dossier_id,id);
ALTER TABLE gate ADD CONSTRAINT gate_review_scope FOREIGN KEY(account_id,dossier_id,review_artifact_id) REFERENCES artifact(account_id,dossier_id,id);
ALTER TABLE gate ADD CONSTRAINT gate_not_self CHECK(predecessor_id IS NULL OR predecessor_id<>id);
CREATE UNIQUE INDEX gate_one_successor ON gate(account_id,dossier_id,predecessor_id) WHERE predecessor_id IS NOT NULL;
