create table bench_version (
 bench text not null,version text not null,digest text not null check(digest ~ '^[a-f0-9]{64}$'),
 bundle jsonb not null,registry jsonb not null,created_at timestamptz not null default now(),
 primary key(bench,version),unique(bench,version,digest)
);
alter table bench_version enable row level security;
alter table bench_version force row level security;
create policy version_read on bench_version for select to reinlab_app using(true);
grant select on bench_version to reinlab_app;
revoke insert,update,delete,truncate on bench_version from reinlab_app;
create function reinlab_append_only() returns trigger language plpgsql as $$begin raise exception 'HARNESS_APPEND_ONLY' using errcode='23514';end $$;
revoke all on function reinlab_append_only() from public;
create trigger bench_version_immutable before update or delete on bench_version for each row execute function reinlab_append_only();
create table bench_effective (
 account_id uuid not null references account(id),digest text not null check(digest ~ '^[a-f0-9]{64}$'),
 bench text not null,version text not null,bundle_digest text not null,
 snapshot jsonb not null,created_at timestamptz not null default now(),
 primary key(account_id,digest),foreign key(bench,version,bundle_digest) references bench_version(bench,version,digest)
);
create table bench_tuning (
 account_id uuid not null references account(id),bench text not null,patch jsonb not null default '{}',
 primary key(account_id,bench)
);
create table dossier_override (
 account_id uuid not null,dossier_id uuid not null,bench text not null,
 effective_digest text not null,account_tuning_hash text not null,
 primary key(account_id,dossier_id),foreign key(account_id,dossier_id) references dossier(account_id,id),
 foreign key(account_id,effective_digest) references bench_effective(account_id,digest)
);
create table harness_proposal (
 id uuid primary key,account_id uuid not null,dossier_id uuid not null,
 patch jsonb not null,base_digest text not null,candidate_digest text not null,
 state text not null check(state in ('pending','applied','approved','rejected')),
 receipt jsonb,decision text check(decision in ('approve','reject')),
 created_at timestamptz not null default now(),
 unique(account_id,id),foreign key(account_id,dossier_id) references dossier(account_id,id),
 foreign key(account_id,base_digest) references bench_effective(account_id,digest),
 foreign key(account_id,candidate_digest) references bench_effective(account_id,digest),
 check((state in ('approved','rejected'))=(decision is not null))
);
do $$declare t text;begin foreach t in array array['bench_effective','bench_tuning','dossier_override','harness_proposal'] loop
 execute format('alter table %I enable row level security',t);
 execute format('alter table %I force row level security',t);
 execute format('create policy tenant_scope on %I to reinlab_app using(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid) with check(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid)',t);
 execute format('grant select,insert,update on %I to reinlab_app',t);
 execute format('revoke delete,truncate on %I from reinlab_app',t);
 end loop;end $$;
revoke update on bench_effective from reinlab_app;
create trigger bench_effective_immutable before update or delete on bench_effective for each row execute function reinlab_append_only();
create function reinlab_proposal_immutable() returns trigger language plpgsql as $$begin
 if row(new.account_id,new.dossier_id,new.patch,new.base_digest,new.candidate_digest) is distinct from row(old.account_id,old.dossier_id,old.patch,old.base_digest,old.candidate_digest)
 or old.receipt is not null and row(new.receipt,new.state,new.decision) is distinct from row(old.receipt,old.state,old.decision)
 then raise exception 'HARNESS_PROPOSAL_IMMUTABLE' using errcode='23514';end if;return new;end $$;
revoke all on function reinlab_proposal_immutable() from public;
create trigger harness_proposal_immutable before update on harness_proposal for each row execute function reinlab_proposal_immutable();
