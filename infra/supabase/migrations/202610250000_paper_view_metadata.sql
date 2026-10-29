-- Public, bounded display metadata only; existing assets remain immutable and tenant-scoped.
alter table paper_asset add column view_metadata jsonb not null default '{}'::jsonb
  check (jsonb_typeof(view_metadata)='object' and octet_length(view_metadata::text)<=32768);
