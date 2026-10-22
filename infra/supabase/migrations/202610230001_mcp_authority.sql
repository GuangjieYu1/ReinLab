-- Authority is captured with run creation; a pre-existing run cannot acquire current grants.
alter table run_harness add unique(account_id,dossier_id,run_id,effective_digest);
alter table budget_hold add unique(account_id,dossier_id,run_id,id);
create table mcp_run (
 account_id uuid not null,dossier_id uuid not null,run_id uuid primary key,effective_digest text not null,
 catalog_digest text not null check(catalog_digest ~ '^[a-f0-9]{64}$'),catalog jsonb not null,
 scope_digest text not null check(scope_digest ~ '^[a-f0-9]{64}$'),scope jsonb not null,
 foreign key(account_id,dossier_id,run_id,effective_digest) references run_harness(account_id,dossier_id,run_id,effective_digest),
 unique(account_id,dossier_id,run_id)
);
create table mcp_credential (
 jti uuid primary key,account_id uuid not null,dossier_id uuid not null,run_id uuid not null,hold_id uuid not null,
 claims_hash text not null check(claims_hash ~ '^[a-f0-9]{64}$'),issued_at timestamptz not null,expires_at timestamptz not null,revoked_at timestamptz,
 check(expires_at>issued_at and expires_at<=issued_at+interval '2 hours'),
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id),
 foreign key(account_id,dossier_id,run_id,hold_id) references budget_hold(account_id,dossier_id,run_id,id)
);
alter table approval add unique(account_id,run_id,id);
create table mcp_approval (
 id uuid primary key,account_id uuid not null,dossier_id uuid not null,run_id uuid not null,
 capability text not null,request_id text not null,args_hash text not null check(args_hash ~ '^[a-f0-9]{64}$'),
 scope_digest text not null,decision text check(decision in ('approve','reject')),consumed boolean not null default false,
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id),
 foreign key(account_id,run_id,id) references approval(account_id,run_id,id),
 unique(account_id,run_id,request_id),unique(account_id,run_id,id),
 check(not consumed or decision is not distinct from 'approve')
);
create table mcp_invocation (
 account_id uuid not null,dossier_id uuid not null,run_id uuid not null,request_id text not null,
 capability text not null,args_hash text not null check(args_hash ~ '^[a-f0-9]{64}$'),approval_id uuid,
 state text not null check(state in ('executing','succeeded','failed','indeterminate')),result jsonb,
 primary key(account_id,run_id,request_id),
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id),
 foreign key(account_id,run_id,approval_id) references mcp_approval(account_id,run_id,id)
);
-- Invalid signatures have no trusted tenant identity. Never accept tenant IDs from unsigned payloads.
create table mcp_anonymous_denial (
 id uuid primary key,at timestamptz not null default now(),action text not null check(action='capability.denied'),
 reason text not null check(reason='CAPABILITY_TOKEN_INVALID'),server text not null check(server in ('files','memory','cards','papers'))
);
alter table mcp_anonymous_denial enable row level security;
alter table mcp_anonymous_denial force row level security;
create policy anonymous_denial_insert on mcp_anonymous_denial for insert to reinlab_app with check(true);
grant insert on mcp_anonymous_denial to reinlab_app;
revoke select,update,delete,truncate on mcp_anonymous_denial from reinlab_app;
create trigger mcp_anonymous_denial_immutable before update or delete on mcp_anonymous_denial for each row execute function reinlab_append_only();
DO $$ declare t text; begin
 foreach t in array array['mcp_run','mcp_credential','mcp_approval','mcp_invocation'] loop
  execute format('alter table %I enable row level security',t);
  execute format('alter table %I force row level security',t);
  execute format('create policy tenant on %I to reinlab_app using(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid) with check(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid)',t);
  execute format('grant select,insert on %I to reinlab_app',t);
  execute format('revoke update,delete,truncate on %I from reinlab_app',t);
 end loop;
end $$;
create trigger mcp_run_immutable before update or delete on mcp_run for each row execute function reinlab_append_only();
grant update(revoked_at) on mcp_credential to reinlab_app;
grant update(decision,consumed) on mcp_approval to reinlab_app;
grant update(state,result) on mcp_invocation to reinlab_app;
create function reinlab_mcp_state_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if TG_TABLE_NAME='mcp_credential' then
  if OLD.revoked_at is not null and NEW.revoked_at is distinct from OLD.revoked_at then raise exception 'revocation is final' using errcode='23514'; end if;
 end if;
 if TG_TABLE_NAME='mcp_approval' then
  if OLD.decision is not null and NEW.decision is distinct from OLD.decision then raise exception 'decision is final' using errcode='23514'; end if;
  if OLD.consumed and not NEW.consumed then raise exception 'approval already consumed' using errcode='23514'; end if;
 end if;
 if TG_TABLE_NAME='mcp_invocation' then
  if OLD.state<>'executing' and ROW(NEW.state,NEW.result) is distinct from ROW(OLD.state,OLD.result) then raise exception 'invocation is final' using errcode='23514'; end if;
 end if;
 return NEW;
end $$;
create trigger mcp_credential_guard before update on mcp_credential for each row execute function reinlab_mcp_state_guard();
create trigger mcp_approval_guard before update on mcp_approval for each row execute function reinlab_mcp_state_guard();
create trigger mcp_invocation_guard before update on mcp_invocation for each row execute function reinlab_mcp_state_guard();

create table mcp_run_revocation (account_id uuid not null,dossier_id uuid not null,run_id uuid primary key,at timestamptz not null default now(),foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id));
alter table mcp_run_revocation enable row level security;
alter table mcp_run_revocation force row level security;
create policy tenant on mcp_run_revocation to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert on mcp_run_revocation to reinlab_app;
revoke update,delete,truncate on mcp_run_revocation from reinlab_app;
create trigger mcp_run_revocation_immutable before update or delete on mcp_run_revocation for each row execute function reinlab_append_only();
