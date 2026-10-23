-- User decisions are immutable business receipts; HTTP idempotency alone cannot prevent
-- two different keys from committing conflicting decisions for the same proposal/card.
alter table promotion add unique(account_id,id);
alter table approval add unique(account_id,id);
create table promotion_decision (
 account_id uuid not null,promotion_id uuid not null,request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb not null,created_at timestamptz not null default now(),primary key(account_id,promotion_id),
 foreign key(account_id,promotion_id) references promotion(account_id,id)
);
create table card_decision (
 account_id uuid not null,approval_id uuid not null,request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 receipt jsonb not null,created_at timestamptz not null default now(),primary key(account_id,approval_id),
 foreign key(account_id,approval_id) references approval(account_id,id)
);
do $$declare t text;begin foreach t in array array['promotion_decision','card_decision'] loop
 execute format('alter table %I enable row level security',t);
 execute format('alter table %I force row level security',t);
 execute format('create policy tenant on %I to reinlab_app using(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid) with check(account_id=nullif(current_setting(''app.account_id'',true),'''')::uuid)',t);
 execute format('grant select,insert on %I to reinlab_app',t);
 execute format('create trigger immutable before update or delete on %I for each row execute function reinlab_append_only()',t);
end loop;end$$;
create unique index memory_one_successor on memory_item(account_id,supersedes) where supersedes is not null;
