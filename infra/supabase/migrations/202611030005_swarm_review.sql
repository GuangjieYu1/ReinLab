-- 群研 MVP-3 第一批（design/prd/15-swarm-mvp3-brief.md）：审查记录与核实门禁。
--
-- 反驳与核实分开记：每条 review 绑定具体结论的**具体版本**，主张或证据一改，
-- 旧核实就作废（门禁只看「核实绑定的版本 == 当前版本」）。
-- 每条结论最多两轮反驳，改版本不重置计数。

create table if not exists swarm_review (
  account_id uuid not null,
  run_id uuid not null,
  id uuid not null default gen_random_uuid(),
  claim_id uuid not null,
  claim_version integer not null check (claim_version >= 1),
  kind text not null check (kind in ('refute','need_evidence','verify','downgrade')),
  by_member text not null,
  reason text not null check (length(reason) between 1 and 4000),
  evidence_ids jsonb not null default '[]',
  verdict text not null check (verdict in ('upheld','rejected','verified','not_verifiable','pending')),
  round integer not null default 0 check (round >= 0),
  task_id text,
  submission_id text,
  created_at timestamptz not null default now(),
  primary key (account_id, run_id, id),
  foreign key (account_id, run_id, claim_id, claim_version)
    references swarm_claim(account_id, run_id, id, version)
);
alter table swarm_review enable row level security;
alter table swarm_review force row level security;
create policy tenant_scope on swarm_review to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on swarm_review to reinlab_app;
create index if not exists swarm_review_claim_idx
  on swarm_review(account_id, run_id, claim_id, claim_version);

-- 门禁用的去规范化字段：核实绑的是哪个版本、谁核的。
-- 只认 verified_version = version 的结论进正式报告正文。
alter table swarm_claim add column if not exists verified_version integer;
alter table swarm_claim add column if not exists verified_by text;
alter table swarm_claim add column if not exists verified_at timestamptz;

comment on column swarm_claim.verified_version is '独立核实绑定的结论版本；改版后与 version 不等即视为未核实';

-- 审查会改结论的状态与核实绑定：给应用角色 update（只加这一项，不放开 delete）。
grant update on swarm_claim to reinlab_app;
