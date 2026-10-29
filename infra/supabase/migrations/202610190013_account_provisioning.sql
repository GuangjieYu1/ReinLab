alter table account_machine add column phase text not null default 'new';
alter table account_machine add column image text;
alter table account_machine add column last_error_code text;
alter table account_machine add column updated_at timestamptz not null default now();
create table account_machine_secret(account_id uuid primary key references account(id), envelope jsonb not null);
alter table account_machine_secret enable row level security;
alter table account_machine_secret force row level security;
create policy account_scope on account_machine_secret using(account_id=current_setting('app.account_id',true)::uuid) with check(account_id=current_setting('app.account_id',true)::uuid);
grant select,insert on account_machine_secret to reinlab_app;
create table reinlab_meta.machine_key(account_id uuid primary key references public.account(id), vault_secret_id uuid not null);
alter table reinlab_meta.machine_key enable row level security;
alter table reinlab_meta.machine_key force row level security;
revoke all on reinlab_meta.machine_key from public,reinlab_app;
-- Vault's DEK is only returned for the authenticated control transaction's account.
-- No grant to public/anon/authenticated and no direct Vault grants to application.
create function public.reinlab_machine_key(candidate text default null) returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare aid uuid; sid uuid; result text;
begin
 aid:=nullif(current_setting('app.account_id',true),'')::uuid;
 if aid is null or not exists(select 1 from public.account where id=aid) then raise exception 'ACCOUNT_SCOPE_REQUIRED' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('machine-key:'||aid::text,0));
 if to_regprocedure('vault.create_secret(text,text,text,uuid)') is null and to_regnamespace('vault') is null then raise exception 'VAULT_UNAVAILABLE' using errcode='55000'; end if;
 select vault_secret_id into sid from reinlab_meta.machine_key where account_id=aid;
 if sid is null then
   if candidate is null or candidate !~ '^[A-Za-z0-9+/]{43}=$' then raise exception 'KEY_REQUIRED' using errcode='22023'; end if;
   execute 'select vault.create_secret($1,$2,$3)' into sid using candidate,'reinlab-machine-'||aid::text,'ReinLab account machine envelope key';
   insert into reinlab_meta.machine_key values(aid,sid);
 end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where id=$1' into result using sid;
 if result is null then raise exception 'VAULT_KEY_UNAVAILABLE' using errcode='55000'; end if;
 return result;
end $$;
revoke all on function public.reinlab_machine_key(text) from public;
grant execute on function public.reinlab_machine_key(text) to reinlab_app;
