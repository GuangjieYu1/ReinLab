-- Release policy: all existing research dossiers remain on their reviewed version.
-- The application has no version-upgrade API in this batch (T-HAR-4 stays deferred).
alter table dossier add column bench_version text;
update dossier d set bench_version=coalesce((
 select e.version from dossier_override o join bench_effective e on e.account_id=o.account_id and e.digest=o.effective_digest
 where o.account_id=d.account_id and o.dossier_id=d.id
),'1.0.0');
alter table dossier alter column bench_version set default '1.1.0';
alter table dossier alter column bench_version set not null;
alter table dossier add constraint dossier_bench_version_format check(length(bench_version) between 1 and 200);
create function reinlab_dossier_version_pin() returns trigger language plpgsql as $$begin
 if row(new.bench,new.bench_version) is distinct from row(old.bench,old.bench_version) then
  raise exception 'DOSSIER_VERSION_PINNED' using errcode='23514';
 end if;return new;end $$;
revoke all on function reinlab_dossier_version_pin() from public;
create trigger dossier_version_pin before update on dossier for each row execute function reinlab_dossier_version_pin();
