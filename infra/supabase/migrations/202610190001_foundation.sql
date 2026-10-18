-- 迁移仅由迁移连接执行；应用连接不得使用迁移角色。
DO $$ BEGIN
  IF NOT EXISTS (select 1 from pg_roles where rolname='reinlab_app') THEN
    CREATE ROLE reinlab_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
  END IF;
END $$;
ALTER ROLE reinlab_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO reinlab_app;
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
set search_path = public, extensions;

create table account (id uuid primary key, created_at timestamptz default now(), display_name text,
  monthly_budget_cny numeric(12,2) not null default 300);

create table dossier (id uuid primary key default gen_random_uuid(), account_id uuid not null references account(id),
  bench text not null check (bench in ('research','curriculum','engineering','creative','automation','exploration','data')),
  title text not null, workspace_path text not null, created_at timestamptz default now(), archived_at timestamptz);

create table role_def (id text primary key, bench text not null, prompt_ref text not null,
  model_tier text not null check (model_tier in ('cheap','mid','strong','embed')),
  tool_grants jsonb not null, read_scope jsonb not null, write_targets jsonb not null, steps int);
-- role_def 是全局表（不分账户），由迁移种子写入，不开放写接口

create table thread (id uuid primary key default gen_random_uuid(), account_id uuid not null, dossier_id uuid not null references dossier(id),
  role_id text not null references role_def(id), os_session_id text, summary text default '', created_at timestamptz default now());

create table run (id uuid primary key default gen_random_uuid(), account_id uuid not null, dossier_id uuid not null references dossier(id),
  parent_run_id uuid references run(id), role_id text not null references role_def(id), mode text not null,
  os_session_id text, os_run_id text, request_id text not null, unique(account_id, request_id),
  state text not null check (state in ('queued','running','waiting','paused_budget','completed','failed','cancelled','interrupted')),
  budget_cny numeric(12,2) not null, spent_cny numeric(12,4) not null default 0,
  quota_runs int not null default 0, gpu_seconds int not null default 0,
  created_at timestamptz default now(), ended_at timestamptz);

create table event (seq bigserial primary key, account_id uuid not null, dossier_id uuid not null, run_id uuid references run(id),
  at timestamptz not null default now(), role_id text, kind text not null, action text, risk text check (risk in ('read','write','danger')),
  input_ref text, output_ref text, cost_cny numeric(12,6), quota int, gpu_seconds int, credential_kind text,
  payload jsonb not null default '{}', dedupe_key text, unique(account_id, dedupe_key));
-- event 只追加：给应用角色撤销 UPDATE / DELETE 权限（迁移里写 revoke）

create table artifact (id uuid primary key default gen_random_uuid(), account_id uuid not null, run_id uuid references run(id),
  dossier_id uuid not null, kind text not null, path text not null, sha256 text not null, version int not null default 1,
  supersedes uuid references artifact(id), created_at timestamptz default now());

create table gate (id uuid primary key default gen_random_uuid(), account_id uuid not null, dossier_id uuid not null,
  subject text not null, state text not null check (state in ('locked','ready','running','review','discuss','approved')),
  updated_at timestamptz default now(), unique (dossier_id, subject));

create table approval (id uuid primary key default gen_random_uuid(), account_id uuid not null, run_id uuid not null references run(id),
  os_request_id text, kind text not null check (kind in ('permission','question','gate','budget','compute','anim')),
  title text not null, effects jsonb not null, risk text not null, state text not null default 'pending'
  check (state in ('pending','approved','rejected','expired','indeterminate')), decided_at timestamptz, decided_scope text);

create table memory_item (id uuid primary key default gen_random_uuid(), account_id uuid not null,
  layer text not null check (layer in ('L1','L2','L3','L4')), dossier_id uuid, thread_id uuid,
  key text not null, value jsonb not null, evidence jsonb not null default '[]', supersedes uuid references memory_item(id),
  revoked_at timestamptz, embedding vector(1536), created_at timestamptz default now());

create table promotion (id uuid primary key default gen_random_uuid(), account_id uuid not null, from_run uuid references run(id),
  target_layer text not null check (target_layer in ('L3.profile','L3.preference','L3.procedure','L4.knowledge')),
  items jsonb not null, reason text not null, status text not null default 'pending'
  check (status in ('pending','approved','edited','rejected','kept_local','expired')),
  created_at timestamptz default now(), expires_at timestamptz not null);

create table delegation (id uuid primary key default gen_random_uuid(), account_id uuid not null,
  from_dossier uuid not null, from_run uuid, to_bench text not null, to_dossier uuid, to_run uuid,
  request jsonb not null, budget_cny numeric(12,2) not null, state text not null, result_ref text, created_at timestamptz default now());

create table credential (id uuid primary key default gen_random_uuid(), account_id uuid not null,
  kind text not null check (kind in ('api_key','subscription_oauth','external_runtime','self_hosted')),
  provider text not null, fingerprint text not null, vault_secret_id uuid not null, created_at timestamptz default now());

create table account_machine (account_id uuid primary key, fly_machine_id text, fly_volume_id text,
  state text not null, os_version text, last_health_at timestamptz);

-- 全局资源ID不足以保证外键的租户一致性。
ALTER TABLE dossier ADD UNIQUE(account_id,id);
ALTER TABLE thread ADD UNIQUE(account_id,id), ADD UNIQUE(account_id,dossier_id,id);
ALTER TABLE run ADD UNIQUE(account_id,id), ADD UNIQUE(account_id,dossier_id,id);
ALTER TABLE artifact ADD UNIQUE(account_id,id), ADD UNIQUE(account_id,dossier_id,id);
ALTER TABLE memory_item ADD UNIQUE(account_id,id);
ALTER TABLE thread ADD FOREIGN KEY(account_id,dossier_id) REFERENCES dossier(account_id,id);
ALTER TABLE run ADD FOREIGN KEY(account_id,dossier_id) REFERENCES dossier(account_id,id),
  ADD FOREIGN KEY(account_id,parent_run_id) REFERENCES run(account_id,id);
ALTER TABLE event ADD FOREIGN KEY(account_id,dossier_id) REFERENCES dossier(account_id,id),
  ADD FOREIGN KEY(account_id,dossier_id,run_id) REFERENCES run(account_id,dossier_id,id),
  ADD FOREIGN KEY(role_id) REFERENCES role_def(id);
ALTER TABLE artifact ADD FOREIGN KEY(account_id,dossier_id) REFERENCES dossier(account_id,id),
  ADD FOREIGN KEY(account_id,dossier_id,run_id) REFERENCES run(account_id,dossier_id,id),
  ADD FOREIGN KEY(account_id,dossier_id,supersedes) REFERENCES artifact(account_id,dossier_id,id);
ALTER TABLE gate ADD FOREIGN KEY(account_id,dossier_id) REFERENCES dossier(account_id,id);
ALTER TABLE approval ADD FOREIGN KEY(account_id,run_id) REFERENCES run(account_id,id),
  ADD CHECK(risk IN ('read','write','danger'));
ALTER TABLE memory_item ADD FOREIGN KEY(account_id,dossier_id) REFERENCES dossier(account_id,id),
  ADD FOREIGN KEY(account_id,thread_id) REFERENCES thread(account_id,id),
  ADD FOREIGN KEY(account_id,dossier_id,thread_id) REFERENCES thread(account_id,dossier_id,id),
  ADD FOREIGN KEY(account_id,supersedes) REFERENCES memory_item(account_id,id),
  ADD CHECK(thread_id IS NULL OR dossier_id IS NOT NULL);
ALTER TABLE promotion ADD FOREIGN KEY(account_id,from_run) REFERENCES run(account_id,id);
ALTER TABLE delegation ADD FOREIGN KEY(account_id,from_dossier) REFERENCES dossier(account_id,id),
  ADD FOREIGN KEY(account_id,to_dossier) REFERENCES dossier(account_id,id),
  ADD FOREIGN KEY(account_id,from_dossier,from_run) REFERENCES run(account_id,dossier_id,id),
  ADD FOREIGN KEY(account_id,to_run) REFERENCES run(account_id,id),
  ADD FOREIGN KEY(account_id,to_dossier,to_run) REFERENCES run(account_id,dossier_id,id),
  ADD CHECK(to_run IS NULL OR to_dossier IS NOT NULL);
ALTER TABLE account ADD CHECK(monthly_budget_cny >= 0);
ALTER TABLE run ADD CHECK(budget_cny > 0 AND spent_cny >= 0 AND quota_runs >= 0 AND gpu_seconds >= 0),
  ADD CHECK(mode IN ('read','swarm','auto'));
ALTER TABLE event ADD CHECK(cost_cny IS NULL OR cost_cny >= 0), ADD CHECK(quota IS NULL OR quota >= 0),
  ADD CHECK(gpu_seconds IS NULL OR gpu_seconds >= 0);
ALTER TABLE delegation ADD CHECK(budget_cny > 0);
ALTER TABLE artifact ADD CHECK(version > 0), ADD CHECK(sha256 ~ '^[a-f0-9]{64}$');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['dossier','thread','run','event','artifact','gate','approval','memory_item','promotion','delegation','credential','account_machine'] LOOP
    EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY(account_id) REFERENCES account(id)',t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO reinlab_app USING (account_id = nullif(current_setting(''app.account_id'',true),'''')::uuid) WITH CHECK (account_id = nullif(current_setting(''app.account_id'',true),'''')::uuid)',t);
    EXECUTE format('CREATE INDEX ON %I(account_id)',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO reinlab_app',t);
  END LOOP;
END $$;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account FORCE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON account TO reinlab_app
  USING(id = nullif(current_setting('app.account_id',true),'')::uuid)
  WITH CHECK(id = nullif(current_setting('app.account_id',true),'')::uuid);
GRANT SELECT,UPDATE ON account TO reinlab_app;
ALTER TABLE role_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_def FORCE ROW LEVEL SECURITY;
CREATE POLICY global_roles_read ON role_def FOR SELECT TO reinlab_app USING(true);
GRANT SELECT ON role_def TO reinlab_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON role_def FROM reinlab_app;
REVOKE UPDATE,DELETE,TRUNCATE ON event FROM reinlab_app;
GRANT USAGE,SELECT ON SEQUENCE event_seq_seq TO reinlab_app;
GRANT USAGE ON SCHEMA extensions TO reinlab_app;
CREATE INDEX event_dossier_cursor ON event(account_id,dossier_id,seq);
CREATE INDEX approval_pending ON approval(account_id,state);
CREATE INDEX promotion_pending ON promotion(account_id,status,expires_at);
CREATE INDEX run_active ON run(account_id,state);

-- Supabase Auth注册时创建本人的账户；普通应用无账户创建/代建权限。
CREATE FUNCTION public.reinlab_on_signup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$ BEGIN
  INSERT INTO public.account(id,display_name) VALUES(NEW.id, coalesce(NEW.raw_user_meta_data->>'display_name','')) ON CONFLICT(id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.reinlab_on_signup() FROM PUBLIC;
DO $$ BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    CREATE TRIGGER reinlab_signup AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.reinlab_on_signup();
  END IF;
END $$;
