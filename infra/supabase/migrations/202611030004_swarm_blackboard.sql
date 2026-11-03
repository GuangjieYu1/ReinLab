-- 群研 MVP-2（design/prd/14-swarm-mvp2-brief.md）：黑板、证据、提交幂等、路线登记。
--
-- 研究对象按 PRD §4 的对象表落库：结论（claim）带版本与可见范围，证据（evidence）
-- 按「来源 + 版本 + 定位」去重，引用关系单独记（去重后仍能追回每条结论引用的是哪条证据）。
-- 提交（submission）按 submission_id 幂等：模型重试不会把同一份产出记两遍。

create table if not exists swarm_submission (
  account_id uuid not null,
  run_id uuid not null,
  submission_id text not null check (length(submission_id) between 1 and 200),
  member text not null,
  kind text not null,
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (account_id, run_id, submission_id),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_submission enable row level security;
alter table swarm_submission force row level security;
create policy tenant_scope on swarm_submission to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on swarm_submission to reinlab_app;

-- 证据：同来源、同版本、同定位只记一条（dedupe_key 是这几项的摘要）。
-- locator 里 page 可以没有：用户 2026-11-03 定「章节 / 表号 / 图号 + 原文摘句」即可。
create table if not exists swarm_evidence (
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  run_id uuid not null,
  submission_id text not null,
  source jsonb not null,
  locator jsonb,
  access text not null check (access in ('full_text','abstract_only','unavailable')),
  how text not null,
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (account_id, run_id, id),
  unique (account_id, run_id, dedupe_key),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_evidence enable row level security;
alter table swarm_evidence force row level security;
create policy tenant_scope on swarm_evidence to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on swarm_evidence to reinlab_app;
create index if not exists swarm_evidence_run_idx on swarm_evidence(account_id, run_id, created_at);

-- 结论：带版本；改主张就出新版本，旧版本保留（核实要绑定版本）。
create table if not exists swarm_claim (
  account_id uuid not null,
  run_id uuid not null,
  id uuid not null default gen_random_uuid(),
  submission_id text not null,
  version integer not null check (version >= 1),
  text text not null check (length(text) between 1 and 8000),
  conditions jsonb not null default '[]',
  basis text not null check (basis in ('checked_fact','source_claim','inference','observation')),
  status text not null default 'candidate'
    check (status in ('candidate','awaiting_refute','awaiting_verify','verified','disputed','falsified','insufficient')),
  status_reason text,
  author text not null,
  task_id text,
  route_id text,
  round integer not null default 0 check (round >= 0),
  visibility text not null default 'lead_reviewers'
    check (visibility in ('lead_reviewers','route','all')),
  negative jsonb,
  refute_rounds integer not null default 0 check (refute_rounds between 0 and 2),
  created_at timestamptz not null default now(),
  primary key (account_id, run_id, id, version),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_claim enable row level security;
alter table swarm_claim force row level security;
create policy tenant_scope on swarm_claim to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on swarm_claim to reinlab_app;
create index if not exists swarm_claim_run_idx on swarm_claim(account_id, run_id, created_at);
create index if not exists swarm_claim_route_idx on swarm_claim(account_id, run_id, route_id);

-- 引用关系：证据按去重键合并，但「这条结论引用了它」要逐条保留。
create table if not exists swarm_claim_evidence (
  account_id uuid not null,
  run_id uuid not null,
  claim_id uuid not null,
  claim_version integer not null,
  evidence_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (account_id, run_id, claim_id, claim_version, evidence_id),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id),
  foreign key (account_id, run_id, claim_id, claim_version)
    references swarm_claim(account_id, run_id, id, version),
  foreign key (account_id, run_id, evidence_id) references swarm_evidence(account_id, run_id, id)
);
alter table swarm_claim_evidence enable row level security;
alter table swarm_claim_evidence force row level security;
create policy tenant_scope on swarm_claim_evidence to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on swarm_claim_evidence to reinlab_app;

-- 路线登记（PRD §5 research_register_approach）：同义不新开路线；标阻塞、记缺口、申请重开。
create table if not exists swarm_approach (
  account_id uuid not null,
  run_id uuid not null,
  route_id text not null check (length(route_id) between 1 and 120),
  title text not null,
  idea text not null default '',
  approach_family text not null default '',
  tags jsonb not null default '[]',
  state text not null default 'active' check (state in ('active','blocked','stopped','reopened','merged')),
  gap text,
  blocked_reason text,
  reopen_reason text,
  merged_into text,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, run_id, route_id),
  foreign key (account_id, run_id) references swarm_run(account_id, run_id)
);
alter table swarm_approach enable row level security;
alter table swarm_approach force row level security;
create policy tenant_scope on swarm_approach to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert, update on swarm_approach to reinlab_app;

-- 留言板：问题 / 求助 / 决定由 research_submit 落成；发现栏直接对应 claim。
-- 已有 swarm_post 够用，这里只补一个「引用结论」的索引位（refs 里已有 claimId）。
create index if not exists swarm_post_claim_idx on swarm_post(account_id, run_id, (refs->>'claimId'));
