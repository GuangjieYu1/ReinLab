-- Auth is supplied by the real Supabase CLI. Plain PG receives queue functions,
-- but never an emulated auth.users table or a fake Auth service.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='reinlab_provisioner') then
   create role reinlab_provisioner login nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
 end if;
end $$;
alter role reinlab_provisioner nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
grant usage on schema public to reinlab_provisioner;

create table reinlab_meta.provision_job (
 account_id uuid primary key references public.account(id),
 state text not null default 'pending' check(state in ('pending','leased','done','failed')),
 attempts int not null default 0 check(attempts>=0),
 worker_id uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz not null default now(),
 last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table reinlab_meta.provision_job enable row level security;
alter table reinlab_meta.provision_job force row level security;
revoke all on reinlab_meta.provision_job from public,reinlab_app,reinlab_provisioner;

create function public.reinlab_handle_new_auth_user() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 insert into public.account(id,display_name) values(new.id,left(new.raw_user_meta_data->>'display_name',120)) on conflict(id) do nothing;
 insert into reinlab_meta.provision_job(account_id) values(new.id) on conflict(account_id) do nothing;
 return new;
end $$;
revoke all on function public.reinlab_handle_new_auth_user() from public,reinlab_app,reinlab_provisioner;
do $$ begin
 if to_regclass('auth.users') is not null then
   execute 'create trigger reinlab_auth_registered after insert on auth.users for each row execute function public.reinlab_handle_new_auth_user()';
 end if;
end $$;

-- The worker can only claim Auth-created metadata jobs and acknowledge its own
-- live lease. It has no direct business-table, Vault or queue-table privileges.
create function public.reinlab_provision_next(worker uuid)
returns table(job_account_id uuid,attempt int)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare chosen uuid;
begin
 if worker is null then raise exception 'WORKER_REQUIRED' using errcode='22023'; end if;
 select j.account_id into chosen from reinlab_meta.provision_job j
 where (j.state='pending' or (j.state='leased' and j.lease_until<now()))
 and j.next_attempt_at<=now() and j.attempts<8
 order by j.created_at,j.account_id for update skip locked limit 1;
 if chosen is null then return; end if;
 return query update reinlab_meta.provision_job j set state='leased',worker_id=worker,
   lease_until=now()+interval '5 minutes',attempts=j.attempts+1,updated_at=now()
   where j.account_id=chosen returning j.account_id,j.attempts;
end $$;
revoke all on function public.reinlab_provision_next(uuid) from public;
grant execute on function public.reinlab_provision_next(uuid) to reinlab_provisioner;

create function public.reinlab_provision_finish(aid uuid,worker uuid,error_code text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if error_code is not null and error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then raise exception 'ERROR_CODE_INVALID' using errcode='22023'; end if;
 update reinlab_meta.provision_job j set
   state=case when error_code is null then 'done' when j.attempts>=8 then 'failed' else 'pending' end,
   worker_id=null,lease_until=null,last_error_code=error_code,
   next_attempt_at=now()+interval '30 seconds',updated_at=now()
   where j.account_id=aid and j.worker_id=worker and j.state='leased' and j.lease_until>now();
 if not found then raise exception 'WORKER_SCOPE_DENIED' using errcode='42501'; end if;
end $$;
revoke all on function public.reinlab_provision_finish(uuid,uuid,text) from public;
grant execute on function public.reinlab_provision_finish(uuid,uuid,text) to reinlab_provisioner;
