-- 群研 MVP-3 第三批：精读关联 + 跨台委托。

-- 结论 ↔ 精读档案的关联：同一材料版本与定位只建一次精读，之后再点就是「接着精读」。
create table if not exists swarm_read_link (
  account_id uuid not null,
  run_id uuid not null,
  claim_id uuid not null,
  claim_version integer not null check (claim_version >= 1),
  evidence_id uuid not null,
  read_dossier_id uuid not null,
  read_run_id uuid,
  mode text not null default 'fresh' check (mode in ('fresh','followup')),
  created_at timestamptz not null default now(),
  primary key (account_id, run_id, claim_id, claim_version, evidence_id)
);
alter table swarm_read_link enable row level security;
alter table swarm_read_link force row level security;
create policy tenant_scope on swarm_read_link to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_read_link to reinlab_app;

-- 委托结果卡（回到源档案）。
alter table approval drop constraint if exists approval_kind_check;
alter table approval add constraint approval_kind_check check (kind in (
  'permission','question','gate','budget','compute','anim',
  'swarm_add_member','swarm_extend','swarm_scope','swarm_divergence','delegation_result'
));

-- 跨台委托表（202610280001 退掉 openscience 时把旧的 delegation 删了，这里按 MVP-3 重新建）。
create table if not exists delegation (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  from_dossier uuid not null,
  from_run uuid,
  to_bench text not null,
  to_dossier uuid,
  to_run uuid,
  request jsonb not null,
  budget_cny numeric(12,2) not null default 8,
  state text not null default 'awaiting_confirm'
    check (state in ('awaiting_confirm','running','done','failed','cancelled')),
  result_ref text,
  result_version integer not null default 0,
  adopted boolean not null default false,
  decided_at timestamptz,
  created_at timestamptz default now()
);
alter table delegation enable row level security;
alter table delegation force row level security;
create policy tenant_scope on delegation to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on delegation to reinlab_app;
create index if not exists delegation_source_idx
  on delegation(account_id, from_dossier, created_at desc);
