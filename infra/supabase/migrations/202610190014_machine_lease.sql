alter table account_machine add column lease_id uuid;
alter table account_machine add column lease_until timestamptz;
alter table account_machine add column runtime_id text;
