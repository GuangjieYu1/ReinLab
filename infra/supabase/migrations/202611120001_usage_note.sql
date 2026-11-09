-- MVP-2：账本上记一句人话（比如「平台未收费：没出图」）。
alter table usage_record add column if not exists note text;
