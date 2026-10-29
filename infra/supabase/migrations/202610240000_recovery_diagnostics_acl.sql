-- Supabase installs these extension views with PUBLIC SELECT. A UUID-only
-- discovery principal must not inherit a query-statistics reader through PUBLIC.
-- Keep intentional diagnostics with PostgreSQL's existing monitoring role.
do $$declare relation text;begin
 foreach relation in array array['extensions.pg_stat_statements','extensions.pg_stat_statements_info'] loop
  if to_regclass(relation) is not null then
   execute format('revoke select on %s from public',to_regclass(relation));
   execute format('grant select on %s to pg_read_all_stats',to_regclass(relation));
  end if;
 end loop;
end$$;
