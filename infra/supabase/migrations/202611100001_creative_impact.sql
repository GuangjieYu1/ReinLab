-- 创作台 1C：影响清单的「扫正文」结果（design/prd/20-creative-contract.md §6.3）。
--
-- 版本差异和「确定受影响」都是现算的，不落库；只有 AI 扫正文（慢、花钱）把结果存一行，
-- 页面按 (from,to) 取最近一次。状态、花费、错误都在 document 里。
create table if not exists creative_impact_scan (
  account_id uuid not null references account(id) on delete cascade,
  dossier_id uuid not null references dossier(id) on delete cascade,
  from_version integer not null,
  to_version integer not null,
  state text not null,
  document jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, dossier_id, from_version, to_version)
);

alter table creative_impact_scan enable row level security;
alter table creative_impact_scan force row level security;
create policy tenant_scope on creative_impact_scan to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update, delete on creative_impact_scan to reinlab_app;
