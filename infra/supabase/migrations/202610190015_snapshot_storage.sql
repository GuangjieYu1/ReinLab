-- Supabase-only integration. Local plain Postgres does not emulate Storage.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='reinlab_snapshot_writer') then
   create role reinlab_snapshot_writer nologin nosuperuser nocreatedb nocreaterole nobypassrls;
 end if;
 if exists(select 1 from pg_roles where rolname='authenticator') then grant reinlab_snapshot_writer to authenticator; end if;
 if to_regclass('storage.objects') is not null and to_regclass('storage.buckets') is not null then
   if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname='objects' and c.relrowsecurity) then raise exception 'STORAGE_RLS_REQUIRED'; end if;
   execute 'insert into storage.buckets(id,name,public) values(''dossier-snapshots'',''dossier-snapshots'',false) on conflict(id) do update set public=false';
   execute 'grant usage on schema storage to reinlab_snapshot_writer';
   execute 'grant select,insert on storage.objects to reinlab_snapshot_writer';
   execute $p$create policy reinlab_snapshot_insert on storage.objects for insert to reinlab_snapshot_writer with check(bucket_id='dossier-snapshots' and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9]{4}-[0-9]{2}-[0-9]{2}\.tar$')$p$;
   execute $p$create policy reinlab_snapshot_read on storage.objects for select to reinlab_snapshot_writer using(bucket_id='dossier-snapshots')$p$;
   execute $p$create policy reinlab_snapshot_private on storage.objects as restrictive for all to public using(bucket_id<>'dossier-snapshots' or current_user='reinlab_snapshot_writer') with check(bucket_id<>'dossier-snapshots' or current_user='reinlab_snapshot_writer')$p$;
 end if;
end $$;
