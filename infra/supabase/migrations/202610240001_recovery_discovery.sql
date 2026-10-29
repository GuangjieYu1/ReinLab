-- Global recovery discovers UUIDs only. This role never owns business objects or bypasses RLS.
do $$begin
 if not exists(select 1 from pg_roles where rolname='reinlab_reconcile_discovery') then
  create role reinlab_reconcile_discovery login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
 end if;
 if exists(select 1 from pg_roles r where r.rolname='reinlab_reconcile_discovery' and
   (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls or r.rolinherit or not r.rolcanlogin or r.rolconnlimit<>4
    or exists(select 1 from pg_auth_members m where m.member=r.oid or m.roleid=r.oid)
    or exists(select 1 from pg_shdepend d where d.refclassid='pg_authid'::regclass and d.refobjid=r.oid and d.deptype='o'))) then
  raise exception 'UNSAFE_DISCOVERY_ROLE' using errcode='42501';
 end if;
end$$;
grant usage on schema public to reinlab_reconcile_discovery;
grant select(id) on account to reinlab_reconcile_discovery;
create policy recovery_uuid_discovery on account for select to reinlab_reconcile_discovery using(true);

create function public.reinlab_assert_discovery() returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare role_id oid;
begin
 select oid into role_id from pg_roles where rolname=current_user and rolname='reinlab_reconcile_discovery'
  and rolcanlogin and not(rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) and rolconnlimit=4;
 if role_id is null or exists(select 1 from pg_auth_members where member=role_id or roleid=role_id)
  or exists(select 1 from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=role_id and deptype='o')
  or has_schema_privilege(current_user,'public','CREATE')
  or not has_column_privilege(current_user,'public.account','id','SELECT')
  or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%'
     and ((c.relkind in ('r','p','v','m','f') and (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
         and has_column_privilege(current_user,c.oid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES') and not(c.oid='public.account'::regclass and a.attname='id' and has_column_privilege(current_user,c.oid,a.attnum,'SELECT') and not has_column_privilege(current_user,c.oid,a.attnum,'INSERT,UPDATE,REFERENCES')))))
      or (c.relkind='S' and has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE'))))
  or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname not in ('pg_catalog','information_schema')
      and has_schema_privilege(current_user,n.oid,'USAGE') and has_function_privilege(current_user,p.oid,'EXECUTE'))
 then raise exception 'UNSAFE_DISCOVERY_ROLE' using errcode='42501'; end if;
 if not exists(select 1 from pg_class where oid='public.account'::regclass and relrowsecurity and relforcerowsecurity)
 then raise exception 'UNSAFE_DISCOVERY_ROLE' using errcode='42501'; end if;
end$$;
revoke all on function public.reinlab_assert_discovery() from public;
grant execute on function public.reinlab_assert_discovery() to reinlab_reconcile_discovery;
-- Refuse pre-existing extra ACLs. Never silently repair an untrusted role.
set local role reinlab_reconcile_discovery;
select public.reinlab_assert_discovery();
reset role;
