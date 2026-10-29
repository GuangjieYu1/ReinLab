-- Strengthen discovery assertion without changing previously applied migration bytes.
create or replace function public.reinlab_assert_discovery() returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare role_id oid;
begin
 select oid into role_id from pg_roles where rolname=current_user and rolname='reinlab_reconcile_discovery'
  and rolcanlogin and not(rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) and rolconnlimit=4;
 if role_id is null or exists(select 1 from pg_auth_members where member=role_id or roleid=role_id)
  or exists(select 1 from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=role_id and deptype='o')
  or exists(select 1 from pg_namespace n where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%' and has_schema_privilege(current_user,n.oid,'CREATE'))
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
set local role reinlab_reconcile_discovery;
select public.reinlab_assert_discovery();
reset role;
