-- Default only: existing dossiers and immutable published releases are untouched.
alter table dossier alter column bench_version set default '1.2.0';
create table read_clarification (
 account_id uuid not null references account(id),dossier_id uuid not null,
 chosen_id uuid,chosen_approval uuid references approval(id),selection_revision integer not null default 0 check(selection_revision>=0),
 closed boolean not null default false,primary key(account_id,dossier_id),foreign key(account_id,dossier_id) references dossier(account_id,id)
);
create table read_candidate (
 id uuid primary key default gen_random_uuid(),account_id uuid not null,dossier_id uuid not null,run_id uuid not null,
 request_id text not null,paper_id text not null check(paper_id ~ '^W[0-9]{1,30}$'),metadata jsonb not null check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=16384),
 created_at timestamptz not null default now(),unique(account_id,run_id,request_id,paper_id),unique(account_id,dossier_id,id),
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id)
);
alter table read_clarification add foreign key(account_id,dossier_id,chosen_id) references read_candidate(account_id,dossier_id,id);
create table read_clarify_run (
 account_id uuid not null,dossier_id uuid not null,run_id uuid not null,closed boolean not null default false,
 primary key(account_id,run_id),foreign key(account_id,dossier_id) references read_clarification(account_id,dossier_id),
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id)
);
create table clarify_model_request (
 account_id uuid not null,dossier_id uuid not null,run_id uuid not null,body_hash text not null check(body_hash ~ '^[a-f0-9]{64}$'),
 maximum_micros integer not null check(maximum_micros between 1 and 50000),state text not null check(state in ('forwarding','completed','unknown')),
 created_at timestamptz not null default now(),primary key(account_id,dossier_id,body_hash),
 foreign key(account_id,dossier_id) references read_clarification(account_id,dossier_id),
 foreign key(account_id,dossier_id,run_id) references mcp_run(account_id,dossier_id,run_id)
);
-- All HTTP and gateway work still uses the ordinary account-local application role.
alter table read_clarification enable row level security;
alter table read_clarification force row level security;
create policy tenant on read_clarification to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert,update on read_clarification to reinlab_app;
revoke delete,truncate on read_clarification from reinlab_app;
alter table read_candidate enable row level security;
alter table read_candidate force row level security;
create policy tenant on read_candidate to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert on read_candidate to reinlab_app;
revoke delete,truncate on read_candidate from reinlab_app;
alter table clarify_model_request enable row level security;
alter table clarify_model_request force row level security;
create policy tenant on clarify_model_request to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert,update on clarify_model_request to reinlab_app;
revoke delete,truncate on clarify_model_request from reinlab_app;
create trigger read_candidate_immutable before update or delete on read_candidate for each row execute function reinlab_append_only();
alter table read_clarify_run enable row level security;
alter table read_clarify_run force row level security;
create policy tenant on read_clarify_run to reinlab_app using(account_id=nullif(current_setting('app.account_id',true),'')::uuid) with check(account_id=nullif(current_setting('app.account_id',true),'')::uuid);
grant select,insert,update on read_clarify_run to reinlab_app;
create function reinlab_clarify_model_limit() returns trigger language plpgsql as $$
declare total integer; rounds integer; busy boolean; begin
 if tg_op='UPDATE' then
  if row(new.account_id,new.dossier_id,new.run_id,new.body_hash,new.maximum_micros,new.created_at) is distinct from row(old.account_id,old.dossier_id,old.run_id,old.body_hash,old.maximum_micros,old.created_at) or old.state<>'forwarding' or new.state not in ('completed','unknown') then raise exception 'CLARIFY_MODEL_IMMUTABLE' using errcode='23514';end if;
  return new;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('ledger:'||new.account_id::text,0));
 if new.state<>'forwarding' or not exists(select 1 from read_clarify_run r join read_clarification d using(account_id,dossier_id) where r.account_id=new.account_id and r.run_id=new.run_id and not r.closed and not d.closed) then raise exception 'CLARIFY_CLOSED' using errcode='23514';end if;
 select coalesce(sum(maximum_micros),0),count(*),coalesce(bool_or(state<>'completed'),false) into total,rounds,busy from clarify_model_request where account_id=new.account_id and dossier_id=new.dossier_id;
 if busy or rounds>=6 or total+new.maximum_micros>50000 then raise exception 'CLARIFY_MODEL_LIMIT' using errcode='23514';end if;
 return new;
end $$;
revoke all on function reinlab_clarify_model_limit() from public;
create trigger clarify_model_limit before insert or update on clarify_model_request for each row execute function reinlab_clarify_model_limit();

revoke delete,truncate on read_clarify_run from reinlab_app;
alter table read_clarification add check((chosen_id is null)=(chosen_approval is null));
create function reinlab_clarify_run_closed() returns trigger language plpgsql as $$
begin
 if row(new.account_id,new.dossier_id,new.run_id) is distinct from row(old.account_id,old.dossier_id,old.run_id) or old.closed and not new.closed then raise exception 'CLARIFY_RUN_CLOSED' using errcode='23514';end if;
 return new;
end $$;
revoke all on function reinlab_clarify_run_closed() from public;
create trigger clarify_run_closed before update on read_clarify_run for each row execute function reinlab_clarify_run_closed();
create function reinlab_clarify_choice_scope() returns trigger language plpgsql as $$
begin
 if new.chosen_approval is not null and not exists(select 1 from approval a join run r on r.id=a.run_id and r.account_id=a.account_id join read_candidate p on p.run_id=a.run_id and p.account_id=a.account_id where a.id=new.chosen_approval and a.account_id=new.account_id and r.dossier_id=new.dossier_id and p.id=new.chosen_id and a.kind='question') then raise exception 'CLARIFY_CHOICE_SCOPE' using errcode='23514';end if;
 return new;
end $$;
revoke all on function reinlab_clarify_choice_scope() from public;
create trigger clarify_choice_scope before insert or update on read_clarification for each row execute function reinlab_clarify_choice_scope();
