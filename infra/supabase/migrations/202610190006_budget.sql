ALTER TABLE run ALTER COLUMN budget_cny TYPE numeric(18,6), ALTER COLUMN spent_cny TYPE numeric(18,6);
ALTER TABLE run ADD COLUMN input jsonb NOT NULL DEFAULT '{}';
ALTER TABLE run ADD COLUMN quota_limit integer NOT NULL DEFAULT 0 CHECK(quota_limit>=0),
 ADD COLUMN gpu_limit integer NOT NULL DEFAULT 0 CHECK(gpu_limit>=0),
 ADD COLUMN budget_revision integer NOT NULL DEFAULT 0 CHECK(budget_revision>=0),
 ADD COLUMN budget_warned_revision integer NOT NULL DEFAULT -1,
 ADD COLUMN budget_paused_revision integer NOT NULL DEFAULT -1,
 ADD COLUMN budget_paused_from text;

CREATE TABLE budget_estimate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL,dossier_id uuid NOT NULL,
 mode text NOT NULL CHECK(mode IN ('read','swarm','auto')),model_tier text NOT NULL CHECK(model_tier IN ('cheap','mid','strong')),
 quote jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 UNIQUE(account_id,dossier_id,id),FOREIGN KEY(account_id,dossier_id) REFERENCES dossier(account_id,id)
);
ALTER TABLE run ADD COLUMN estimate_id uuid;
ALTER TABLE run ADD FOREIGN KEY(account_id,dossier_id,estimate_id) REFERENCES budget_estimate(account_id,dossier_id,id);
CREATE UNIQUE INDEX run_one_estimate ON run(account_id,estimate_id) WHERE estimate_id IS NOT NULL;

ALTER TABLE delegation ADD UNIQUE(account_id,id);
CREATE TABLE budget_allocation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL,dossier_id uuid NOT NULL,
 parent_id uuid,run_id uuid,delegation_id uuid,period date NOT NULL,
 amount_cny numeric(18,6) NOT NULL CHECK(amount_cny>=0),spent_cny numeric(18,6) NOT NULL DEFAULT 0 CHECK(spent_cny>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,period,id),UNIQUE(account_id,run_id,period),
 FOREIGN KEY(account_id,dossier_id) REFERENCES dossier(account_id,id),
 FOREIGN KEY(account_id,period,parent_id) REFERENCES budget_allocation(account_id,period,id),
 FOREIGN KEY(account_id,dossier_id,run_id) REFERENCES run(account_id,dossier_id,id),
 FOREIGN KEY(account_id,delegation_id) REFERENCES delegation(account_id,id),
 CHECK(NOT(run_id IS NOT NULL AND delegation_id IS NOT NULL)),CHECK(parent_id IS NULL OR parent_id<>id),
 CHECK(parent_id IS NOT NULL OR(run_id IS NULL AND delegation_id IS NULL))
);
CREATE UNIQUE INDEX budget_dossier_root ON budget_allocation(account_id,dossier_id,period) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX budget_delegation_once ON budget_allocation(account_id,delegation_id,period) WHERE delegation_id IS NOT NULL;
ALTER TABLE event ADD UNIQUE(account_id,seq);
CREATE TABLE budget_hold (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL,dossier_id uuid NOT NULL,run_id uuid NOT NULL,
 allocation_id uuid NOT NULL,period date NOT NULL,request_id text NOT NULL,
 maximum_cny numeric(18,6) NOT NULL CHECK(maximum_cny>=0),maximum_quota integer NOT NULL CHECK(maximum_quota>=0),
 maximum_gpu_seconds integer NOT NULL CHECK(maximum_gpu_seconds>=0),
 state text NOT NULL CHECK(state IN ('reserved','unpriced','settled','cancelled')),
 actual_cny numeric(18,6),actual_quota integer NOT NULL DEFAULT 0 CHECK(actual_quota>=0),actual_gpu_seconds integer NOT NULL DEFAULT 0 CHECK(actual_gpu_seconds>=0),
 settlement_hash text,receipt jsonb,event_seq bigint,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,run_id,request_id),CHECK(actual_cny IS NULL OR actual_cny>=0),
 FOREIGN KEY(account_id,dossier_id,run_id) REFERENCES run(account_id,dossier_id,id),
 FOREIGN KEY(account_id,period,allocation_id) REFERENCES budget_allocation(account_id,period,id),
 FOREIGN KEY(account_id,event_seq) REFERENCES event(account_id,seq)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['budget_estimate','budget_allocation','budget_hold'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant ON %I USING(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid) WITH CHECK(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO reinlab_app',t);
  EXECUTE format('REVOKE DELETE,TRUNCATE ON %I FROM reinlab_app',t);
 END LOOP;
END $$;
